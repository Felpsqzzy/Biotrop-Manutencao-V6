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

const { rateLimit, requireSameOrigin } = require('../src/middleware/security');

function response() {
  return { statusCode: 200, headers: {}, body: null,
    set(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

test('rejects cross-origin API mutations', () => {
  const res = response();
  let passed = false;
  requireSameOrigin({ method: 'POST', get: key => key === 'origin' ? 'https://evil.example' : null }, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test('accepts same-origin API mutations', () => {
  const res = response();
  let passed = false;
  requireSameOrigin({ method: 'POST', get: key => key === 'origin' ? 'https://manutencao.example.test' : null }, res, () => { passed = true; });
  assert.equal(passed, true);
});

test('limits repeated requests by client address', () => {
  const guard = rateLimit({ limit: 2, windowMs: 60_000 });
  const req = { ip: '127.0.0.9' };
  const first = response(); const second = response(); const third = response();
  let passed = 0;
  guard(req, first, () => { passed += 1; });
  guard(req, second, () => { passed += 1; });
  guard(req, third, () => { passed += 1; });
  assert.equal(passed, 2);
  assert.equal(third.statusCode, 429);
});

test('porUsuario: atrás do mesmo IP (NAT da fábrica) cada pessoa da sessão tem o próprio balde; sem sessão válida, o IP', () => {
  const { createSession, COOKIE } = require('../src/auth/session');
  const guard = rateLimit({ limit: 2, windowMs: 60_000, porUsuario: true });
  const cookie = id => ({ [COOKIE]: createSession({ id, sessaoVersao: 1 }).valor });
  const pessoaA = { ip: '10.9.9.9', cookies: cookie('00000000-0000-4000-8000-00000000000a') };
  const pessoaB = { ip: '10.9.9.9', cookies: cookie('00000000-0000-4000-8000-00000000000b') };
  const semSessao = { ip: '10.9.9.9', cookies: {} };
  const forjada = { ip: '10.9.9.9', cookies: { [COOKIE]: 'eyJ2IjoyfQ.assinatura-falsa' } };
  const passa = req => { const res = response(); let ok = false; guard(req, res, () => { ok = true; }); return ok ? 200 : res.statusCode; };
  assert.deepEqual([passa(pessoaA), passa(pessoaA), passa(pessoaA)], [200, 200, 429]);
  assert.deepEqual([passa(pessoaB), passa(pessoaB)], [200, 200], 'B não herda o limite de A');
  assert.deepEqual([passa(semSessao), passa(semSessao)], [200, 200], 'sem sessão: balde do IP, separado das pessoas');
  assert.equal(passa(forjada), 429, 'cookie forjado conta como o IP (não cria balde novo)');
});

test('chave: IP + login separa quem erra a própria matrícula dos colegas no mesmo aparelho', () => {
  const guard = rateLimit({ limit: 1, windowMs: 60_000, chave: req => req.body.matricula });
  const passa = req => { let ok = false; guard(req, response(), () => { ok = true; }); return ok; };
  assert.deepEqual([passa({ ip: '10.1.1.1', body: { matricula: '700001' } }), passa({ ip: '10.1.1.1', body: { matricula: '700001' } })], [true, false]);
  assert.equal(passa({ ip: '10.1.1.1', body: { matricula: '700002' } }), true, 'outra matrícula, mesmo IP');
  assert.equal(passa({ ip: '10.1.1.2', body: { matricula: '700001' } }), true, 'mesma matrícula, outro IP');
});

test('soFalhas: login certo não gasta o limite; só os erros contam, por IP + matrícula', () => {
  const guard = rateLimit({ limit: 2, windowMs: 60_000, soFalhas: true, chave: req => req.body.matricula });
  const tenta = (matricula, status) => {
    const res = response(); const ouvintes = [];
    res.on = (ev, fn) => ouvintes.push(fn);
    let ok = false; guard({ ip: '10.2.2.2', body: { matricula } }, res, () => { ok = true; });
    if (ok) { res.statusCode = status; ouvintes.forEach(fn => fn()); }
    return ok ? status : res.statusCode;
  };
  for (let i = 0; i < 5; i += 1) assert.equal(tenta('700001', 200), 200, 'acertos não contam');
  assert.deepEqual([tenta('700002', 401), tenta('700002', 401), tenta('700002', 200)], [401, 401, 429], 'dois erros: a terceira tentativa para');
  assert.equal(tenta('700001', 200), 200, 'o colega no mesmo IP segue entrando');
  assert.deepEqual([tenta('700003', 401), tenta('700003', 200), tenta('700003', 401), tenta('700003', 401), tenta('700003', 200)], [401, 200, 401, 401, 429], 'o acerto zera os erros (contam os seguidos)');
});

test('requires leaders to belong to the record group before updates', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/data.js'), 'utf8');
  assert.match(source, /req\.user\.perfilId === 'lider'/);
  assert.match(source, /currentGroup !== String\(req\.user\.grupoId/);
  assert.match(source, /throw forbidden/);
});

test('realtime applies the same row scope and payload redaction as normal reads', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/realtime.js'), 'utf8');
  assert.match(source, /escopoMulti\(user, lista, 2\)/);
  assert.match(source, /pageQuery\(req\.user, lista, last\)/);
  assert.match(source, /buildReadScope\(user, ns, n \+ 1\)/);
  assert.match(source, /exposeRecord\(row, req\.user\)/);
  assert.doesNotMatch(source, /training_progress|training_enrollments/);
});

test('PostgreSQL also refuses viewer access to other peoples requests', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/13-sync-read-scope-hardening.sql'), 'utf8');
  assert.match(migration, /DROP POLICY IF EXISTS sync_registro_select/);
  assert.doesNotMatch(migration, /'almoxarife','viewer'/);
  assert.match(migration, /payload->>'solicitanteId'.*app\.usuario_atual/s);
  assert.match(migration, /app\.eh_do_meu_grupo/);
});

test('tempo real numa conexão só: cada módulo mantém o escopo de leitura da pessoa e a numeração dos parâmetros', () => {
  process.env.APP_BASE_URL ||= 'http://localhost:3000';
  const { escopoMulti } = require('../src/routes/realtime')._test;
  const tecnico = { id: 'u1', email: 'a@b.c', perfilId: 'tecnico' };
  const r = escopoMulti(tecnico, ['sci', 'lms_courses'], 2);
  // $1 é a data; sci = $2 (+ id e e-mail $3/$4); lms_courses = $5
  assert.match(r.sql, /^\(namespace=\$2 AND \(payload->>'_ownerId'=\$3/);
  assert.match(r.sql, /\(namespace=\$5 AND payload->>'status'='publicado'/);
  assert.deepEqual(r.params, ['sci', 'u1', 'a@b.c', 'lms_courses']);
});
