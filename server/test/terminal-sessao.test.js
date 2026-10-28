'use strict';
// Cookie do terminal (auth/terminal-sessao.js) separado do cookie do site; montagem da API do terminal no app.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

const T = require('../src/auth/terminal-sessao');
const site = require('../src/auth/session');
const UID = '0b9d2c1e-1111-4222-8333-944455556666';

test('cookie do terminal: assinado, com versão da credencial e validade de 30 min', () => {
  const agora = Date.UTC(2026, 9, 16, 12, 0, 0);
  const { valor, dados } = T.criarSessaoTerminal({ usuarioId: UID, versao: 3 }, agora);
  assert.equal(dados.exp - dados.iat, 30 * 60);
  const d = T.verificarSessaoTerminal(valor, agora + 60_000);
  assert.equal(d.sub, UID); assert.equal(d.cv, 3); assert.equal(d.sid, dados.sid);
  assert.equal(T.verificarSessaoTerminal(valor, agora + 30 * 60_000 + 1000), null, 'passou de 30 min');
  const [payload, sig] = valor.split('.');
  const outro = Buffer.from(JSON.stringify({ ...dados, cv: 4 })).toString('base64url');
  assert.equal(T.verificarSessaoTerminal(`${outro}.${sig}`, agora), null, 'payload adulterado');
  assert.equal(T.verificarSessaoTerminal(`${payload}.${sig.slice(0, -2)}xx`, agora), null, 'assinatura adulterada');
  const longo = Buffer.from(JSON.stringify({ ...dados, exp: dados.iat + 8 * 3600 })).toString('base64url');
  assert.equal(T.verificarSessaoTerminal(`${longo}.${sig}`, agora), null);
  assert.match(T.sidHash(dados.sid), /^[0-9a-f]{64}$/);
});

test('um cookie não vale no lugar do outro (chave HKDF e prefixo próprios)', () => {
  const term = T.criarSessaoTerminal({ usuarioId: UID, versao: 1 }).valor;
  const doSite = site.createSession({ id: UID, sessaoVersao: 1 }).valor;
  assert.equal(site.verifySession(term), null, 'terminal → site');
  assert.equal(T.verificarSessaoTerminal(doSite), null, 'site → terminal');
  assert.notEqual(T.COOKIE, site.COOKIE);
  assert.equal(T.COOKIE, require('../src/config').cookieSecure ? '__Host-biotrop_terminal' : 'biotrop_terminal');
});

test('opções do cookie: HttpOnly, SameSite=Strict, Path=/', () => {
  const chamadas = [];
  const res = { cookie: (...a) => chamadas.push(['set', ...a]), clearCookie: (...a) => chamadas.push(['clear', ...a]) };
  T.gravarCookieTerminal(res, 'v', Math.floor(Date.now() / 1000) + 1800);
  T.limparCookieTerminal(res);
  for (const [, nome, , op] of [chamadas[0]]) { assert.equal(nome, T.COOKIE); assert.equal(op.httpOnly, true); assert.equal(op.sameSite, 'strict'); assert.equal(op.path, '/'); assert.ok(op.maxAge > 1790_000); }
  assert.equal(chamadas[1][2].sameSite, 'strict');
});

test('app.js: limite geral do terminal antes do same-origin/JSON, o do login (matrícula) depois do JSON e antes da rota, /terminal antes do catch-all', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/app.js'), 'utf8');
  const geral = src.indexOf("bucket: 'terminal-api'"), origem = src.indexOf("app.use('/api', requireSameOrigin)"), json = src.indexOf('app.use(express.json(');
  const porMatricula = src.indexOf("bucket: 'terminal-login-matricula'"), limite = src.indexOf("bucket: 'terminal-login' }");
  const rota = src.indexOf("app.use('/api/terminal', require('./routes/terminal'))");
  const pagina = src.indexOf("app.get('/terminal'"), estatico = src.indexOf('app.use(express.static('), coringa = src.indexOf("app.get('*'");
  assert.ok(geral > 0 && geral < origem && origem < json);
  assert.ok(json < porMatricula && porMatricula < limite && limite < rota, 'IP+matrícula antes do limite por IP: o erro de um não gasta o do tablet');
  assert.ok(rota > origem);
  assert.ok(pagina > 0 && pagina < estatico && pagina < coringa);
  assert.match(src, /terminal\.html/);
  // o middleware do terminal não lê o cookie do site
  const mw = fs.readFileSync(path.resolve(__dirname, '../src/middleware/terminal.js'), 'utf8');
  assert.doesNotMatch(mw, /auth\/session'|biotrop_session|requireAuth/);
});

test('migration 41: tabelas fechadas (RLS restritivo), sem GRANT de tabela, funções com search_path fixo', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/41-terminal-acesso.sql'), 'utf8');
  for (const t of ['terminal_credencial', 'terminal_convite', 'terminal_tentativa', 'terminal_sessao']) {
    assert.match(sql, new RegExp(`ALTER TABLE emprestimo\\.${t} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ON emprestimo\\.${t} AS RESTRICTIVE FOR ALL TO PUBLIC USING \\(false\\) WITH CHECK \\(false\\)`));
  }
  assert.doesNotMatch(sql, /GRANT (SELECT|INSERT|UPDATE|DELETE)/);
  assert.doesNotMatch(sql, /DROP (TABLE|SCHEMA|FUNCTION)/, 'nada apagado ao reaplicar');
  const definer = sql.match(/LANGUAGE \w+ (?:STABLE )?SECURITY DEFINER[^\n]*/g);
  assert.ok(definer.length >= 12 && definer.every(l => /SET search_path = /.test(l)));
});
