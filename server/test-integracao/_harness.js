'use strict';
// Sobe o app de verdade contra PostgreSQL real (PGlite) com TODAS as migrations, rodando como biotrop_app
// (o papel do app em produção, sob RLS). Usado pelos testes de integração mais novos.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

process.env.NODE_ENV = 'test';
process.env.APP_BASE_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgres://x:x@127.0.0.1:1/x';
process.env.SESSION_SECRET ||= crypto.randomBytes(32).toString('base64');
process.env.ENTRA_TENANT_ID = '11111111-1111-1111-1111-111111111111';
process.env.ENTRA_CLIENT_ID = '22222222-2222-2222-2222-222222222222';
process.env.ENTRA_CLIENT_SECRET = 'teste';
process.env.KMS_PROVEDOR = 'local';
process.env.BIOMANUT_KEK_LOCAL ||= crypto.randomBytes(32).toString('base64');
// Estático: o build de exemplo (mesma forma do apps/web/dist), para os testes não dependerem do build do front.
process.env.WEB_DIR ||= path.join(__dirname, '..', 'test', 'fixtures', 'web-dist');

const MIG = path.resolve(__dirname, '../../database/migrations');

async function subirApp(perfis = { tec: 'tecnico', pcm: 'pcm', admin: 'admin' }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const ext = {};
  for (const n of ['pgcrypto', 'citext', 'pg_trgm', 'unaccent']) ext[n] = (await import(`@electric-sql/pglite/contrib/${n}`))[n];
  const db = new PGlite({ extensions: ext, parsers: { 1082: v => { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); } } });
  const q = (s, p) => db.query(s, p);
  for (const f of fs.readdirSync(MIG).filter(f => /^\d.*\.sql$/.test(f)).sort()) await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));

  // PGlite tem uma conexão só: as transações entram em fila; dentro de uma, chamadas ao pool reaproveitam a mesma
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();
  let chain = Promise.resolve();
  const cliente = { query: async (s, p) => { const r = await q(s, p); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } };
  async function transaction(identity, fn) {
    if (als.getStore()) return fn(cliente);
    const run = () => als.run(true, async () => {
      await db.exec('BEGIN');
      try {
        await q('SET LOCAL ROLE biotrop_app');
        if (identity?.id) { await q("select set_config('app.usuario_id',$1,true)", [String(identity.id)]); await q("select set_config('app.usuario_email',$1,true)", [String(identity.email || '')]); }
        const out = await fn(cliente); await db.exec('COMMIT'); return out;
      } catch (e) { await db.exec('ROLLBACK'); throw e; }
    });
    const p = chain.then(run, run); chain = p.catch(() => {}); return p;
  }
  const pool = {
    query: (s, p) => transaction(null, c => c.query(s, p)),
    connect: async () => ({ query: (s, p) => cliente.query(s, p), release() {} })
  };

  const users = {};
  for (const [k, perfil] of Object.entries(perfis)) {
    const email = `${k}@teste.biotrop`;
    await q(`INSERT INTO core.email_autorizado(email, perfil_padrao, ativo) VALUES($1,$2,true) ON CONFLICT (email) DO NOTHING`, [email, perfil]);
    const r = await q(`INSERT INTO core.usuario(nome,email,perfil_id) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET nome=excluded.nome RETURNING id, sessao_versao`, [`Pessoa ${k}`, email, perfil]);
    users[k] = { id: r.rows[0].id, email, sv: r.rows[0].sessao_versao, perfil };
  }
  // Step-up das ações administrativas: os testes de regra de negócio (mais antigos) seguem sem o código do autenticador;
  // passoExtra.exigir = true liga o middleware VERDADEIRO (test-integracao/step-up.test.js).
  const passoExtra = { exigir: false };
  const orig = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === '../db/pool' || req === '../../db/pool') return { transaction, pool };
    const mod = orig.call(this, req, parent, ...rest);
    if (req === './twofa' && mod.requireStepUpAdmin) {
      return { ...mod, requireStepUpAdmin: perfis => { const real = mod.requireStepUpAdmin(perfis); return (rq, rs, nx) => (passoExtra.exigir ? real(rq, rs, nx) : nx()); } };
    }
    return mod;
  };
  const app = require('../src/app');
  const srv = app.listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r));
  const raiz = `http://127.0.0.1:${srv.address().port}`;
  const { createSession } = require('../src/auth/session');
  async function api(u, method, url, body) {
    const r = await fetch(raiz + url, { method, headers: { cookie: `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv }).valor}`, origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j };
  }
  /** Resposta crua (cabeçalhos, binário). u=null → sem sessão. */
  function raw(u, method, url) {
    const headers = { origin: 'http://localhost:3000' };
    if (u) headers.cookie = `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv }).valor}`;
    return fetch(raiz + url, { method, headers });
  }
  return { q, db, users, raiz, api, raw, transaction, srv, passoExtra, fechar: () => new Promise(r => srv.close(r)) };
}

module.exports = { subirApp };
