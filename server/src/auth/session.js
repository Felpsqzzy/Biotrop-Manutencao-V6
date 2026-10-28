const crypto = require('node:crypto');
const config = require('../config');

// Cookie de sessão:
//  • nome com prefixo __Host- quando Secure (obrigatório em produção): só HTTPS, só este host, Path=/, sem Domain;
//  • conteúdo assinado (HMAC-SHA256) com chave derivada por HKDF só para sessões — o estado OAuth e outros
//    usos têm chaves próprias, então um token de um propósito nunca vale em outro;
//  • não carrega e-mail nem nome (o usuário é recarregado do banco a cada requisição);
//  • sv = versão da sessão no banco: incrementá-la (sair de todos os aparelhos, bloqueio, troca de perfil)
//    invalida na hora todos os cookies anteriores;
//  • expira por inatividade (ia) e por validade absoluta (exp); sid identifica a sessão para vincular o step-up.
const COOKIE = config.cookieSecure ? '__Host-biotrop_session' : 'biotrop_session';
const RENOVAR_APOS_S = 5 * 60;

function chave(proposito) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(config.sessionSecret, 'utf8'), Buffer.from('biomanut-hkdf-sal-v1'), Buffer.from(`biomanut:${proposito}`), 32));
}
const K_SESSAO = chave('sessao');

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sign(value) { return crypto.createHmac('sha256', K_SESSAO).update(`sessao.v2.${value}`).digest('base64url'); }

function createSession(user, agora = Date.now()) {
  const now = Math.floor(agora / 1000);
  const dados = {
    v: 2,
    sub: String(user.id),
    sv: Number(user.sessaoVersao || 1),
    sid: user.sid || crypto.randomBytes(16).toString('base64url'),
    iat: user.iat || now,
    ia: now,
    exp: user.exp || now + config.sessionHours * 3600
  };
  const payload = encode(dados);
  return { valor: `${payload}.${sign(payload)}`, dados };
}

function verifySession(raw, agora = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.includes('.')) return null;
  const [payload, signature] = raw.split('.');
  const a = Buffer.from(signature || '');
  const b = Buffer.from(sign(payload || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = agora / 1000;
    if (d.v !== 2 || !/^[0-9a-f-]{36}$/i.test(String(d.sub)) || !Number.isInteger(d.sv) || typeof d.sid !== 'string') return null;
    if (!(Number(d.exp) > now) || Number(d.iat) > now + 60) return null;
    if (Number(d.exp) - Number(d.iat) > config.sessionHours * 3600 + 60) return null;
    if (Number(d.ia) + config.sessionIdleMinutes * 60 <= now) return null;   // inatividade
    return d;
  } catch { return null; }
}

function precisaRenovar(d, agora = Date.now()) { return agora / 1000 - Number(d.ia) >= RENOVAR_APOS_S; }

function cookieOptions(expSegundos) {
  const maxAge = Math.max(0, Math.round(expSegundos * 1000 - Date.now()));
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge };
}

/** Cria (login) ou renova (atividade) a sessão, mantendo sid/iat/exp da original na renovação. */
function setSession(res, user) {
  const { valor, dados } = createSession(user);
  res.cookie(COOKIE, valor, cookieOptions(dados.exp));
  return dados;
}
function clearSession(res) { res.clearCookie(COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' }); }

module.exports = { COOKIE, chave, createSession, verifySession, precisaRenovar, setSession, clearSession };
