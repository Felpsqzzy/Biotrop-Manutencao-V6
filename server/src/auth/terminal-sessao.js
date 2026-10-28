'use strict';
// Cookie da sessão do terminal do almoxarifado (tablet), separado da sessão do site:
//  • nome próprio (__Host-biotrop_terminal em produção), HttpOnly, SameSite=Strict, Path=/;
//  • assinado (HMAC-SHA256) com chave HKDF de finalidade "terminal": o cookie do site não vale aqui e este não vale
//    no site (requireAuth usa outra chave, outro nome e outro prefixo de assinatura);
//  • leva a versão da credencial (cv): troca de senha, redefinição e bloqueio a incrementam e derrubam na hora;
//  • validade absoluta de 30 min no próprio cookie. Inatividade, "Sair" e situação do colaborador são conferidos no
//    banco a cada requisição (emprestimo.terminal_sessao_validar, migration 41) — só o hash do sid fica lá.
const crypto = require('node:crypto');
const config = require('../config');
const { chave } = require('./session');

const COOKIE = config.cookieSecure ? '__Host-biotrop_terminal' : 'biotrop_terminal';
const VALIDADE_S = 30 * 60;
const K_TERMINAL = chave('terminal');

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sign(payload) { return crypto.createHmac('sha256', K_TERMINAL).update(`terminal.v1.${payload}`).digest('base64url'); }
function novoSid() { return crypto.randomBytes(24).toString('base64url'); }
/** Hash do sid: é o que o banco guarda (o cookie nunca é gravado). */
function sidHash(sid) { return crypto.createHash('sha256').update(`terminal:${sid}`).digest('hex'); }

/** O sid é criado antes (vai em hash para o banco junto com o login); o cookie é montado depois que o banco aceita. */
function criarSessaoTerminal({ usuarioId, versao, sid = novoSid() }, agora = Date.now()) {
  const now = Math.floor(agora / 1000);
  const dados = { v: 1, sub: String(usuarioId), cv: Number(versao), sid, iat: now, exp: now + VALIDADE_S };
  const payload = encode(dados);
  return { valor: `${payload}.${sign(payload)}`, dados };
}

function verificarSessaoTerminal(raw, agora = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 1024 || !raw.includes('.')) return null;
  const [payload, assinatura] = raw.split('.');
  const a = Buffer.from(assinatura || ''), b = Buffer.from(sign(payload || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = agora / 1000;
    if (d.v !== 1 || !/^[0-9a-f-]{36}$/i.test(String(d.sub)) || !Number.isInteger(d.cv) || d.cv < 1) return null;
    if (typeof d.sid !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(d.sid)) return null;
    if (!(Number(d.exp) > now) || Number(d.iat) > now + 60 || Number(d.exp) - Number(d.iat) > VALIDADE_S + 60) return null;
    return d;
  } catch { return null; }
}

function opcoes(maxAge) { return { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', ...(maxAge == null ? {} : { maxAge }) }; }
function gravarCookieTerminal(res, valor, expSegundos) {
  res.cookie(COOKIE, valor, opcoes(Math.max(0, Math.round(expSegundos * 1000 - Date.now()))));
}
function limparCookieTerminal(res) { res.clearCookie(COOKIE, opcoes()); }

module.exports = { COOKIE, VALIDADE_S, novoSid, sidHash, criarSessaoTerminal, verificarSessaoTerminal, gravarCookieTerminal, limparCookieTerminal };
