const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const totp = require('../auth/totp');
const { COOKIE: COOKIE_SESSAO } = require('../auth/session');
const { cifrarSegredo2fa, abrirSegredo2fa } = require('../crypto/pessoais');

// Verificação em duas etapas (aplicativo autenticador) + confirmação recente.
// A confirmação recente vale 10 minutos, fica num cookie HttpOnly assinado e é
// exigida pelo servidor antes das ações sensíveis (ver requireStepUp).
const router = express.Router();
// __Host-: só HTTPS, só este host. A confirmação fica vinculada à SESSÃO (sid), não só à pessoa:
// sair e entrar de novo (ou outra sessão roubada) não herda a confirmação.
const COOKIE = COOKIE_SESSAO.startsWith('__Host-') ? '__Host-biotrop_2fa' : 'biotrop_2fa';
// Cadastrar um autenticador exige login recente: quem só tem um cookie roubado não consegue.
const LOGIN_RECENTE_S = 15 * 60;
const MINUTES = 10;
const failures = new Map(); // tentativas erradas por pessoa, em memória

function cookieOptions(ms) { return { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', maxAge: ms }; }
function tooMany(userId) {
  const f = failures.get(userId);
  if (!f) return false;
  if (Date.now() - f.since > 10 * 60000) { failures.delete(userId); return false; }
  return f.count >= 6;
}
function fail(userId) {
  const f = failures.get(userId) || { count: 0, since: Date.now() };
  f.count += 1; failures.set(userId, f);
}
async function state(db) { return (await db.query('SELECT app.twofa_estado() AS s')).rows[0]?.s || {}; }
const vinculo = req => `${req.user.id}:${req.sessao?.sid || ''}`;
function stepUpUntil(req) { return totp.verifyStepUp(req.cookies?.[COOKIE], vinculo(req), config.twofaKey); }
function loginRecente(req) { return req.sessao && Date.now() / 1000 - Number(req.sessao.iat) <= LOGIN_RECENTE_S; }
function limparStepUp(res) { res.clearCookie(COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' }); }
function grantStepUp(req, res) {
  res.cookie(COOKIE, totp.signStepUp(vinculo(req), config.twofaKey, MINUTES), cookieOptions(MINUTES * 60000));
  return Date.now() + MINUTES * 60000;
}

/** Confere código do app ou de recuperação; registra o passo para não aceitar o mesmo código duas vezes. */
async function checkCode(db, s, body, userId) {
  const { segredo: secret, legado } = await abrirSegredo2fa(userId, s.segredo);
  if (body.codigo) {
    if (!secret) return false;
    const step = totp.verify(secret, body.codigo, { lastStep: Number(s.ultimo_passo || 0) });
    if (step === null) return false;
    // Segredo no formato antigo: regrava no formato novo (envelope + AAD do usuário) no primeiro uso.
    if (legado) await db.query('SELECT app.twofa_regravar_segredo($1,$2)', [s.segredo, await cifrarSegredo2fa(userId, secret)]);
    // O UPDATE condicional no banco torna a proteção contra repetição atômica:
    // duas requisições com o mesmo código não conseguem ser aceitas juntas.
    return (await db.query('SELECT app.twofa_registrar_passo($1) AS ok', [step])).rows[0]?.ok === true;
  }
  if (body.recuperacao) {
    const hash = totp.hashRecovery(body.recuperacao, config.twofaKey);
    return (await db.query('SELECT app.twofa_usar_recuperacao($1) AS ok', [hash])).rows[0]?.ok === true;
  }
  return false;
}

/**
 * Middleware para rotas sensíveis: com 2FA ativo, exige confirmação dos últimos 10 minutos.
 * exigirAtivo (ações administrativas): quem ainda não ativou o 2FA recebe 403 com configurar2fa e precisa ativar antes.
 * Não tranca ninguém fora: ativar é autoatendimento (Minha conta › Segurança, com login Microsoft recente), sem depender
 * de outro admin; o resto do sistema continua aberto enquanto isso.
 * perfis: quem a rota deixa fazer a ação (o MESMO Set da rota). Outro perfil não é perguntado pelo código: segue e a rota
 * responde o 403 dela, em vez de pedir 2FA para algo que a pessoa nem pode fazer.
 */
function stepUp(exigirAtivo, perfis) {
  return async function (req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();   // leitura nunca pede confirmação
    if (perfis && !perfis.has(req.user?.perfilId)) return next();
    try {
      const s = await transaction(req.user, db => state(db));
      if (s.ativo ? stepUpUntil(req) : !exigirAtivo) return next();
      if (!s.ativo) return res.status(403).json({ ok: false, precisa2fa: true, configurar2fa: true,
        erro: 'Esta ação administrativa exige a verificação em duas etapas. Ative em Minha conta › Segurança e tente de novo.' });
      res.status(403).json({ ok: false, precisa2fa: true, erro: 'Confirme com o código do aplicativo autenticador.' });
    } catch (error) { next(error); }
  };
}
const requireStepUp = stepUp(false);
/** Ações administrativas (cadastros, modo de teste, aprovação do inventário): 2FA ativo + confirmação recente. */
const requireStepUpAdmin = perfis => stepUp(true, perfis);

router.use(requireAuth);
// O limite de produção vive no PostgreSQL: reiniciar/escalar o Node não libera novas tentativas.
router.use(async (req,res,next) => {
  if (!config.production || req.method !== 'POST' || !['/ativar','/verificar'].includes(req.path)) return next();
  try {
    const chave=require('node:crypto').createHmac('sha256',config.twofaKey).update('twofa-account:'+req.user.id).digest('hex');
    const r=await transaction(req.user,async db=>(await db.query('SELECT * FROM app.consumir_limite($1,6,600)',[chave])).rows[0]);
    if(!r.permitido){res.set('Retry-After',String(r.espera));return res.status(429).json({ok:false,erro:'Muitas tentativas. Aguarde alguns minutos.'});}
    next();
  }catch(e){next(e);}
});

router.get('/', async (req, res, next) => {
  try {
    const s = await transaction(req.user, db => state(db));
    res.set('Cache-Control', 'no-store').json({ ok: true, ativo: !!s.ativo, pendente: !!s.pendente, ativadoEm: s.ativado_em || null,
      codigosRestantes: Array.isArray(s.recuperacao) ? s.recuperacao.length : 0, confirmadoAte: stepUpUntil(req) || null });
  } catch (error) { next(error); }
});

router.post('/iniciar', async (req, res, next) => {
  try {
    const s = await transaction(req.user, db => state(db));
    if (s.ativo) return res.status(409).json({ ok: false, erro: 'A verificação já está ativa.' });
    if (!loginRecente(req)) return res.status(403).json({ ok: false, reautenticar: true, erro: 'Por segurança, saia e entre de novo com a Microsoft para cadastrar o autenticador.' });
    const secret = totp.generateSecret();
    await transaction(req.user, async db => db.query('SELECT app.twofa_iniciar($1)', [await cifrarSegredo2fa(req.user.id, secret)]));
    const uri = totp.otpauthUri(secret, req.user.email);
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#10233a', light: '#ffffff' } });
    res.set('Cache-Control', 'no-store').json({ ok: true, segredo: secret.match(/.{1,4}/g).join(' '), uri, qr });
  } catch (error) { next(error); }
});

router.post('/ativar', async (req, res, next) => {
  if (tooMany(req.user.id)) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  if (!loginRecente(req)) return res.status(403).json({ ok: false, reautenticar: true, erro: 'Por segurança, saia e entre de novo com a Microsoft para cadastrar o autenticador.' });
  try {
    const out = await transaction(req.user, async db => {
      const s = await state(db);
      const { segredo: secret } = await abrirSegredo2fa(req.user.id, s.pendente_segredo);
      if (!secret) return null;
      const step = totp.verify(secret, req.body?.codigo);
      if (step === null) return null;
      const codes = totp.recoveryCodes();
      await db.query('SELECT app.twofa_ativar($1,$2)', [step, codes.map(c => totp.hashRecovery(c, config.twofaKey))]);
      return codes;
    });
    if (!out) { fail(req.user.id); return res.status(400).json({ ok: false, erro: 'Código incorreto. Confira o horário do celular e tente o código atual.' }); }
    failures.delete(req.user.id);
    res.json({ ok: true, codigos: out, confirmadoAte: grantStepUp(req, res) });
  } catch (error) { next(error); }
});

router.post('/verificar', async (req, res, next) => {
  if (tooMany(req.user.id)) return res.status(429).json({ ok: false, erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  try {
    const ok = await transaction(req.user, async db => {
      const s = await state(db);
      if (!s.ativo) return 'inativo';
      return (await checkCode(db, s, req.body || {}, req.user.id)) ? 'ok' : 'erro';
    });
    if (ok === 'inativo') return res.status(409).json({ ok: false, erro: 'A verificação em duas etapas não está ativa.' });
    if (ok !== 'ok') { fail(req.user.id); return res.status(400).json({ ok: false, erro: 'Código incorreto.' }); }
    failures.delete(req.user.id);
    res.json({ ok: true, confirmadoAte: grantStepUp(req, res) });
  } catch (error) { next(error); }
});

router.post('/codigos', requireStepUp, async (req, res, next) => {
  try {
    const codes = totp.recoveryCodes();
    await transaction(req.user, db => db.query('SELECT app.twofa_trocar_recuperacao($1)', [codes.map(c => totp.hashRecovery(c, config.twofaKey))]));
    res.json({ ok: true, codigos: codes });
  } catch (error) { next(error); }
});

router.post('/desativar', requireStepUp, async (req, res, next) => {
  try {
    await transaction(req.user, db => db.query('SELECT app.twofa_desativar()'));
    limparStepUp(res);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
module.exports.requireStepUp = requireStepUp;
module.exports.requireStepUpAdmin = requireStepUpAdmin;
module.exports.limparStepUp = limparStepUp;
