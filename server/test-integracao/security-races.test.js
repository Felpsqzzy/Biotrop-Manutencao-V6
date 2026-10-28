'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');
let h;
test.before(async () => { h = await subirApp(); });
test.after(async () => { if (h) await h.fechar(); });

test('SCM API denies forged attendance fields on creation and accepts a pending request', async () => {
  const user = h.users.tec;
  const base = { solicitanteId: user.id, solicitanteEmail: user.email, status: 'pendente_aprovacao_lider', itens: [{ id: 'item-synthetic', situacao: 'pendente' }] };
  for (const [i, patch] of [
    { numeroProcessoME: 'FORGED' }, { responsavelCompra: 'FORGED' }, { observacaoAlmoxarife: 'FORGED' }, { observacaoLider: 'FORGED' },
    { itens: [{ id: 'item-synthetic', situacao: 'atendido' }] }, { itens: [{ id: 'item-synthetic', atendidoPor: 'FORGED' }] },
    { itens: [{ id: 'item-synthetic', atendidoEm: '2026-10-06' }] }
  ].entries()) {
    const result = await h.api(user, 'PUT', `/api/data/scm/scm-forged-${i}`, { payload: { ...base, ...patch }, expectedVersion: 0 });
    assert.equal(result.s, 403, JSON.stringify(result.j));
    assert.equal((await h.q('SELECT count(*)::int AS n FROM app.sync_registro WHERE namespace=$1 AND record_id=$2', ['scm', `scm-forged-${i}`])).rows[0].n, 0);
  }
  const valid = await h.api(user, 'PUT', '/api/data/scm/scm-pending-synthetic', { payload: base, expectedVersion: 0 });
  assert.equal(valid.s, 200, JSON.stringify(valid.j));
});

test('SharePoint pending revision survives concurrent enqueue under PostgreSQL xmin semantics', async () => {
  const worker = require('../src/worker-sharepoint');
  const date = '2000-01-01';
  await h.q('INSERT INTO pcm.batelada_sharepoint(data,pendente) VALUES($1,true)', [date]);
  const cfg = { maxAttempts: 8, batch: 1, dryRun: false };
  const db = { query: async (sql, args) => /pg_(try_)?advisory_(un)?lock/.test(sql) ? { rows: [{ ok: true }] } : h.q(sql, args) };
  let calls = 0;
  const graph = { async gravarDia(_date, _counters, itemId) {
    calls++;
    if (calls === 1) await h.q('UPDATE pcm.batelada_sharepoint SET pendente=true,tentativas=0,atualizado_em=now() WHERE data=$1', [date]);
    else assert.equal(itemId, 'synthetic-created-item');
    return 'synthetic-created-item';
  } };
  await worker.processar({ cfg, db, graph });
  assert.equal((await h.q('SELECT pendente FROM pcm.batelada_sharepoint WHERE data=$1', [date])).rows[0].pendente, true);
  await worker.processar({ cfg, db, graph });
  assert.equal((await h.q('SELECT pendente FROM pcm.batelada_sharepoint WHERE data=$1', [date])).rows[0].pendente, false);
  assert.equal(calls, 2);
});

test('SSE SQL cursor fetches all 501 rows at the same PostgreSQL microsecond', async () => {
  const at = '2026-10-06 12:00:00.123456+00';
  const payload = { solicitanteId: h.users.tec.id, solicitanteEmail: h.users.tec.email, _ownerId: h.users.tec.id };
  await h.q(`INSERT INTO app.sync_registro(namespace,record_id,payload,updated_at,updated_by)
    SELECT 'sci','sse-synthetic-' || lpad(n::text,4,'0'),$1::jsonb,$2::timestamptz,$3::uuid FROM generate_series(1,501) n`, [JSON.stringify(payload), at, h.users.tec.id]);
  const { pageQuery, cursorFor, encodeCursor, readCursor } = require('../src/routes/realtime')._test;
  const user = { id: h.users.tec.id, email: h.users.tec.email, perfilId: 'tecnico' };
  const cursor = { at: '2026-10-06T12:00:00Z', namespace: null, recordId: null };
  const fetchPage = async c => {
    const page = pageQuery(user, ['sci'], c);
    return h.transaction(user, db => db.query(page.sql, page.args).then(r => r.rows));
  };
  const first = await fetchPage(cursor);
  assert.equal(first.length, 500);
  assert.match(first[0].cursor_at, /123456/);
  const last = readCursor(encodeCursor(cursorFor(first.at(-1))));
  const second = await fetchPage(last);
  assert.equal(second.length, 1);
  assert.equal(second[0].record_id, 'sse-synthetic-0501');
  assert.equal((await fetchPage(cursorFor(second[0]))).length, 0);
});
