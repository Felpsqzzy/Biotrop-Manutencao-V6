'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRoute(name, dependencies) {
  const routes = {}, router = { use() {}, get(url, ...handlers) { routes['GET ' + url] = handlers.at(-1); }, post(url, ...handlers) { routes['POST ' + url] = handlers.at(-1); } };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes', name), 'utf8'), {
    require(key) { if (key === 'express') return { Router: () => router }; if (key in dependencies) return dependencies[key]; throw Error('Unexpected require ' + key); },
    module: mod, console: { error() {} }, Buffer, Date, Map, Set, setImmediate,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}
  });
  return { routes, exports: mod.exports };
}
function response() {
  return { code: 200, headers: {}, status(n) { this.code = n; return this; }, set(k, v) { this.headers[k] = v; return this; }, json(body) { this.body = body; return this; } };
}

test('logout failure is 503 without clearing retry cookie; retry succeeds only after durable revocation', async () => {
  let unavailable = true, cleared = 0, revoked = 0;
  const { routes } = loadRoute('auth.js', {
    '../config': { cookieSecure: true },
    '../db/pool': { transaction: async (_u, fn) => { if (unavailable) throw Object.assign(Error('synthetic db outage'), { code: 'ECONNREFUSED' }); return fn({ query: async () => { revoked++; } }); } },
    '../auth/entra': {},
    '../auth/session': { COOKIE: '__Host-biotrop_session', verifySession: () => ({ sid: 'synthetic', exp: 1900000000 }), clearSession: () => { cleared++; } },
    '../middleware/auth': { sidHash: () => 'synthetic-hash' }, '../middleware/security': {},
    './twofa': { limparStepUp() {} }, '../seguranca/eventos': {}, '../crypto/pessoais': {}, '../simulacao/identidade': {}
  });
  const req = { cookies: {} }, failed = response();
  await routes['POST /logout'](req, failed);
  assert.equal(failed.code, 503); assert.equal(failed.body.ok, false); assert.equal(failed.body.encerradaNoServidor, false);
  assert.equal(cleared, 0); assert.equal(revoked, 0);
  unavailable = false;
  const success = response(); await routes['POST /logout'](req, success);
  assert.equal(success.code, 200); assert.equal(success.body.encerradaNoServidor, true); assert.equal(cleared, 1); assert.equal(revoked, 1);
});

test('SSE delivers 501 equal-timestamp records across pages and resumes with exact microseconds', async () => {
  const at = '2026-10-06 12:00:00.123456+00';
  const all = Array.from({ length: 501 }, (_, i) => ({ namespace: 'sci', record_id: String(i).padStart(4, '0'),
    updated_at: new Date('2026-10-06T12:00:00.123Z'), cursor_at: at, payload: {}, version: 1 }));
  const queries = [], events = [];
  const { routes, exports } = loadRoute('realtime.js', {
    '../db/pool': { transaction: async (_u, fn) => fn({ query: async (sql, args) => {
      queries.push({ sql, args });
      // Synthetic SQL adapter exercises both query pages; an incorrect timestamp-only query drops page 2.
      let selected = all;
      if (args[0] === at) selected = sql.includes('(namespace, record_id) >') ? all.filter(r => r.record_id > args.at(-1)) : [];
      return { rows: selected.slice(0, 500) };
    } }) }, '../middleware/auth': {}, './read-scope': { buildReadScope: () => ({ sql: '', params: [] }) },
    './record-security': { exposeRecord: r => ({ recordId: r.record_id, payload: r.payload, version: 1, updatedAt: r.updated_at }) },
    '../crypto/registros': { abrirLinhas: async rows => rows }, '../seguranca/eventos': {},
    '../realtime/hub': { avisos: { on() {}, off() {} }, iniciar() {}, escutando: () => true }
  });
  const req = { user: { id: 'synthetic' }, query: { namespaces: 'sci', since: '2026-10-05' }, get: () => null, on() {} };
  const res = response(); res.flushHeaders = () => {}; res.write = s => events.push(s);
  await routes['GET /'](req, res);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.equal(events.filter(e => e.includes('event: change')).length, 501);
  assert.equal(queries[1].args[0], at, 'preserves PostgreSQL microseconds, without JS Date truncation');
  assert.equal(queries[1].args.at(-1), '0499');
  const final = events.filter(e => e.includes('event: change')).at(-1);
  const id = /^id: (.+)$/m.exec(final)[1];
  const cursor = exports._test.readCursor(id);
  assert.equal(cursor.at, at); assert.equal(cursor.recordId, '0500');
  assert.equal(exports._test.readCursor('invalid', '2026-10-05').namespace, null);
});
