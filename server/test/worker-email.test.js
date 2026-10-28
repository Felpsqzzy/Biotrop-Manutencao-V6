'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GraphError, loadConfig, databaseOptions, createGraphClient, processBatch, enfileirarAvisos, ciclo, ENFILEIRADORES, SQL_CLAIM, validateRow } = require('../src/worker-email');
function env(extra = {}) { return { DATABASE_WORKER_URL: 'postgresql://worker:secret@db:5432/biotrop', GRAPH_TENANT_ID: '00000000-0000-0000-0000-000000000001', GRAPH_CLIENT_ID: '00000000-0000-0000-0000-000000000002', GRAPH_CLIENT_SECRET: 'server-only', EMAIL_REMETENTE: 'manutencao@biotrop.com.br', EMAIL_MOTIVOS_ATIVOS: 'sci_revisao_solicitante', ...extra }; }
function row(id = 'mail-1') { return { id, remetente: 'manutencao@biotrop.com.br', destinatario: 'pessoa@biotrop.com.br', copia: [], assunto: 'Teste', corpo_html: '<p>ok</p>', motivo: 'sci_revisao_solicitante', tentativas: 0 }; }
function fakeDb(item) { let claimed = false; const updates = []; return { updates, query: async (sql, params) => { if (sql.includes('pg_try')) return { rows: [{ ok: true }] }; if (sql.includes('RETURNING f.id')) { if (claimed) return { rows: [] }; claimed = true; return { rows: [item] }; } if (sql.startsWith('UPDATE')) updates.push({ sql, params }); return { rows: [] }; } }; }

test('requires a separate server-side Graph credential', () => {
  assert.throws(() => loadConfig({ ...env(), GRAPH_CLIENT_SECRET: '' }), /GRAPH_CLIENT_SECRET/);
  assert.equal(loadConfig(env()).clientSecret, 'server-only');
});
test('database TLS verifies the configured CA', () => {
  assert.throws(() => databaseOptions(loadConfig(env({ DATABASE_SSL: 'true' }))), /DATABASE_SSL_CA/);
  assert.deepEqual(databaseOptions(loadConfig(env({ DATABASE_SSL: 'true', DATABASE_SSL_CA: 'test-ca' }))).ssl, { ca: 'test-ca', rejectUnauthorized: true, minVersion: 'TLSv1.2' });
});
test('Graph uses HTTPS, correlation id, and keeps secret out of URL', async () => {
  const calls = []; const fetch = async (url, options) => { calls.push({ url, options }); if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'token', expires_in: 3600 }), headers: new Headers() }; return { status: 202, headers: new Headers({ 'request-id': 'graph-id' }) }; };
  const result = await createGraphClient(loadConfig(env()), fetch).send(row(), 'stable-id');
  assert.equal(result.requestId, 'graph-id'); assert.ok(calls.every(call => call.url.startsWith('https://')));
  assert.equal(calls[1].options.headers['client-request-id'], 'stable-id'); assert.ok(!calls.some(call => call.url.includes('server-only')));
});
test('dry-run never calls Graph and never changes the queue', async () => {
  const queries = []; const db = { query: async sql => { queries.push(sql); if (sql.includes('pg_try')) return { rows: [{ ok: true }] }; if (sql.includes("status='pendente'")) return { rows: [row()], rowCount: 1 }; return { rows: [] }; } }; let sends = 0;
  const result = await processBatch({ cfg: loadConfig(env({ EMAIL_DRY_RUN: '1' })), db, graph: { send: async () => { sends += 1; } } });
  assert.equal(result.previewed, 1); assert.equal(sends, 0); assert.ok(!queries.some(sql => /^UPDATE/i.test(sql.trim())));
});
test('retries explicit throttling with one correlation id', async () => {
  const db = fakeDb(row()); const ids = []; let calls = 0; const graph = { send: async (_row, id) => { ids.push(id); if (++calls === 1) throw new GraphError('429', { retryable: true, retryAfterMs: 1 }); return { clientRequestId: id, requestId: 'rid' }; } };
  const result = await processBatch({ cfg: loadConfig(env({ EMAIL_LOTE: '1' })), db, graph, sleepFn: async () => {}, uuid: () => 'same-id' });
  assert.equal(result.sent, 1); assert.deepEqual(ids, ['same-id', 'same-id']); assert.ok(db.updates.some(update => update.params?.includes('crid:same-id rid:rid')));
});
test('does not retry an ambiguous network outcome', async () => {
  const db = fakeDb(row('mail-2')); let sends = 0; const graph = { send: async () => { sends += 1; throw new GraphError('unknown', { retryable: true, deliveryUnknown: true }); } };
  const result = await processBatch({ cfg: loadConfig(env({ EMAIL_LOTE: '1' })), db, graph, sleepFn: async () => {}, uuid: () => 'correlation-id' });
  assert.equal(sends, 1); assert.equal(result.failed, 1); assert.ok(db.updates.some(update => update.params?.includes('crid:correlation-id')));
});

// Empréstimo do almoxarifado (migration 42): o ciclo enfileira os avisos do banco antes de entregar a fila.
function cycleDb(item, falhas = {}) {
  const queries = []; let claimed = false;
  return { queries, query: async sql => {
    queries.push(sql);
    for (const [trecho, erro] of Object.entries(falhas)) if (sql.includes(trecho)) throw erro;
    if (sql.includes('pg_try')) return { rows: [{ ok: true }] };
    if (sql.includes('RETURNING f.id')) { if (claimed || !item) return { rows: [] }; claimed = true; return { rows: [item] }; }
    return { rows: [] };
  } };
}
const emprestimoRow = () => ({ ...row('mail-emp'), motivo: 'emprestimo_atraso' });
test('each cycle queues training and loan reminders before delivering the queue', async () => {
  const db = cycleDb(emprestimoRow()); const logs = [];
  const result = await ciclo({ cfg: loadConfig(env({ EMAIL_LOTE: '1', EMAIL_MOTIVOS_ATIVOS: 'emprestimo_atraso' })), db, graph: { send: async (_r, id) => ({ clientRequestId: id }) }, log: (...a) => logs.push(a), uuid: () => 'crid-emp' });
  const lms = db.queries.indexOf('SELECT lms.enfileirar_cobrancas_treinamento()'), emp = db.queries.indexOf('SELECT emprestimo.enfileirar_avisos()');
  const lock = db.queries.findIndex(sql => sql.includes('pg_try'));
  assert.ok(lms >= 0 && emp > lms && lock > emp, 'LMS, empréstimo e só depois a entrega');
  assert.equal(result.sent, 1); assert.deepEqual(logs, []);
  assert.deepEqual(ENFILEIRADORES.map(([nome]) => nome), ['LMS', 'EMPRESTIMO']);
});
test('a failing reminder function is logged by code only and does not stop the other one nor the delivery', async () => {
  const segredo = Object.assign(new Error('function emprestimo.enfileirar_avisos() does not exist DETAIL pessoa@biotrop.com.br'), { code: '42883' });
  const db = cycleDb(emprestimoRow(), { 'emprestimo.enfileirar_avisos': segredo, 'lms.enfileirar': new Error('sem código') }); const logs = [];
  const result = await ciclo({ cfg: loadConfig(env({ EMAIL_LOTE: '1', EMAIL_MOTIVOS_ATIVOS: 'emprestimo_atraso' })), db, graph: { send: async (_r, id) => ({ clientRequestId: id }) }, log: (...a) => logs.push(a), uuid: () => 'crid-emp' });
  assert.deepEqual(logs, [['[LMS]', 'WORKER_ERROR'], ['[EMPRESTIMO]', '42883']], 'só o código; nada da mensagem do banco');
  assert.equal(result.sent, 1, 'a fila continua sendo entregue');
  const db2 = cycleDb(null, { 'emprestimo.enfileirar_avisos': segredo }); const logs2 = [];
  await enfileirarAvisos(db2, (...a) => logs2.push(a));
  assert.ok(db2.queries.includes('SELECT lms.enfileirar_cobrancas_treinamento()'), 'o LMS roda mesmo com o empréstimo falhando');
});
test('loan reminder motives are documented and the worker only gets EXECUTE on the entry function', () => {
  const fs = require('node:fs'); const path = require('node:path'); const root = path.resolve(__dirname, '../..');
  const exemplo = fs.readFileSync(path.join(root, '.env.example'), 'utf8').match(/^EMAIL_MOTIVOS_ATIVOS=(.*)$/m)[1].split(',');
  for (const m of ['emprestimo_lembrete', 'emprestimo_vencimento', 'emprestimo_atraso', 'emprestimo_escalonamento', 'emprestimo_devolucao']) assert.ok(exemplo.includes(m), m);
  const mig = fs.readFileSync(path.join(root, 'database/migrations/42-emprestimo-avisos.sql'), 'utf8');
  const doWorker = mig.split(/\r?\n/).filter(l => /TO biotrop_worker/.test(l));
  assert.deepEqual(doWorker, ['GRANT USAGE ON SCHEMA emprestimo TO biotrop_worker;', 'GRANT EXECUTE ON FUNCTION emprestimo.enfileirar_avisos() TO biotrop_worker;']);
  assert.match(mig, /REVOKE ALL ON FUNCTION[\s\S]*emprestimo\.enfileirar_avisos_em\(timestamptz\)[\s\S]*FROM PUBLIC;/, 'a versão com horário simulado não é do worker');
});
test('cópia: a fila é lida como text[] (citext[] cru chega como texto e a cópia sumia) e endereço ruim em cópia não barra a mensagem', () => {
  assert.match(SQL_CLAIM, /f\.copia::text\[\] AS copia/);
  const cfg = loadConfig(env());
  const msg = validateRow({ ...row(), copia: ['gestao@teste.biotrop', 'GESTAO@teste.biotrop', 'nao-e-email', 'pessoa@biotrop.com.br'] }, cfg);
  assert.deepEqual(msg.cc, ['gestao@teste.biotrop'], 'repetido, inválido e o próprio destinatário saem da cópia');
  assert.equal(msg.to, 'pessoa@biotrop.com.br');
});
