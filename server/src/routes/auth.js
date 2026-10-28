const express = require('express');
const config = require('../config');
const { transaction } = require('../db/pool');
const { client, redirectUri, createOauthState, readOauthState } = require('../auth/entra');
const { setSession, clearSession, verifySession, COOKIE } = require('../auth/session');
const { requireAuth, sidHash } = require('../middleware/auth');
const { requireSameOrigin } = require('../middleware/security');
const { limparStepUp } = require('./twofa');
const { registrarEvento } = require('../seguranca/eventos');
const { abrirTelefone } = require('../crypto/pessoais');
const { DOMINIO: DOMINIO_SIMULACAO } = require('../simulacao/identidade');

const router = express.Router();
const OAUTH = config.cookieSecure ? '__Host-biotrop_oauth' : 'biotrop_oauth';
const oauthCookie = { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' };
const limparOauth = res => res.clearCookie(OAUTH, oauthCookie);

router.get('/microsoft', async (_req, res, next) => {
  try {
    const oauth = createOauthState();
    res.cookie(OAUTH, oauth.cookie, { ...oauthCookie, maxAge: 10 * 60 * 1000 });
    const url = await client.getAuthCodeUrl({
      scopes: ['openid', 'profile', 'email'],
      redirectUri: redirectUri(),
      state: oauth.value.state,
      nonce: oauth.value.nonce,
      codeChallenge: oauth.challenge,
      codeChallengeMethod: 'S256',
      prompt: 'select_account'
    });
    res.redirect(url);
  } catch (error) { next(error); }
});

router.get('/microsoft/callback', async (req, res) => {
  const saved = readOauthState(req.cookies?.[OAUTH]);
  limparOauth(res);   // uso único, com ou sem sucesso
  if (!saved || !req.query.code || req.query.state !== saved.state) return res.redirect('/?login=erro&motivo=sessao_expirada');
  try {
    const token = await client.acquireTokenByCode({
      code: String(req.query.code), scopes: ['openid', 'profile', 'email'],
      redirectUri: redirectUri(), codeVerifier: saved.verifier, nonce: saved.nonce
    });
    const claims = token.idTokenClaims || {};
    const tenant = String(claims.tid || '');
    const objectId = String(claims.oid || '');
    const email = String(claims.email || claims.preferred_username || token.account?.username || '').trim().toLowerCase();
    const nome = String(claims.name || token.account?.name || email.split('@')[0]).trim();
    // Identidade = tenant + oid (conta Microsoft). O e-mail só localiza o cadastro autorizado.
    if (tenant !== config.entraTenantId || !/^[0-9a-f-]{36}$/i.test(objectId) || !email) return res.redirect('/?login=erro&motivo=conta_invalida');
    // Usuários virtuais do modo de teste nunca entram pela Microsoft (só existem dentro da simulação).
    if (email.endsWith('@' + DOMINIO_SIMULACAO)) return res.redirect('/?login=erro&motivo=conta_invalida');

    const user = await transaction(null, async db => {
      const id = (await db.query(`SELECT core.provisionar_acesso($1::citext,$2,$3::uuid,$4::inet,$5) AS id`,
        [email, nome, objectId, req.ip, String(req.get('user-agent') || '').slice(0, 300)])).rows[0]?.id;
      if (!id) return null;
      return (await db.query('SELECT id, sessao_versao FROM app.sessao_usuario($1::uuid)', [id])).rows[0] || null;
    });
    if (!user) return res.redirect('/?login=erro&motivo=email_nao_autorizado');
    limparStepUp(res);
    setSession(res, { id: user.id, sessaoVersao: user.sessao_versao });   // novo sid a cada login (sem fixação de sessão)
    res.redirect('/?login=ok');
  } catch (error) {
    console.error('[ENTRA CALLBACK]', error?.errorCode || error?.code || error?.name || 'erro');
    res.redirect('/?login=erro&motivo=falha_microsoft');
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const telefone = await abrirTelefone(req.user.id, req.user.telefoneCifrado);
    res.set('Cache-Control', 'no-store').json({ ok: true, usuario: { ...req.user, telefone } });
  } catch (error) { next(error); }
});

router.post('/logout', requireSameOrigin, async (req, res) => {
  // Encerra no servidor também: a mesma sessão não volta a valer nem com uma cópia do cookie.
  const sessao = verifySession(req.cookies?.[COOKIE]);
  if (sessao) {
    try {
      await transaction(null, db => db.query('SELECT app.encerrar_sessao($1, to_timestamp($2))', [sidHash(sessao.sid), Number(sessao.exp)]));
    } catch (error) {
      console.error('[LOGOUT] não registrou o encerramento:', error.code || error.name);
      // Mantenha o cookie para permitir repetir a revogação; nunca confirme um logout incompleto.
      return res.status(503).set('Cache-Control', 'no-store').json({ ok: false, encerradaNoServidor: false,
        erro: 'Não foi possível encerrar a sessão no servidor. Tente sair novamente.' });
    }
  }
  clearSession(res); limparStepUp(res);
  res.set('Cache-Control', 'no-store').json({ ok: true, encerradaNoServidor: true });
});

/** Sair de todos os aparelhos: incrementa a versão da sessão no banco; todo cookie anterior deixa de valer. */
router.post('/logout-todos', requireSameOrigin, requireAuth, async (req, res, next) => {
  try {
    await transaction(req.user, async db => {
      await db.query('SELECT app.encerrar_minhas_sessoes()');
      await registrarEvento('sessao.encerrar_todas', req.user, {}, db);
    });
    clearSession(res); limparStepUp(res);
    res.set('Cache-Control', 'no-store').json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
