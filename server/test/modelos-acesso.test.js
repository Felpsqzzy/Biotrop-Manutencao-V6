'use strict';
// Teste de comportamento (app real, sem banco): o modelo de planilha só sai com sessão válida,
// e caminhos codificados/duplicados — que antes contornavam o bloqueio — não entregam o arquivo.
process.env.NODE_ENV = 'test';
process.env.APP_BASE_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgres://ninguem:x@127.0.0.1:1/nada';
process.env.SESSION_SECRET = 'teste-'.padEnd(48, 'x');
process.env.ENTRA_TENANT_ID = '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET = 'segredo-de-teste';
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

async function servidor(fn) {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('modelo sem sessão: 401 e nada de planilha', () => servidor(async base => {
  const r = await fetch(`${base}/assets/modelos/prontuario-diafragmas-rev12.xlsx`);
  assert.equal(r.status, 401);
  assert.ok(!String(r.headers.get('content-type')).includes('spreadsheet'));
}));

test('caminhos codificados, duplicados ou com ../ não entregam o arquivo', () => servidor(async base => {
  for (const p of ['/assets/%6Dodelos/prontuario-diafragmas-rev12.xlsx', '/assets/modelo%73/prontuario-diafragmas-rev12.xlsx',
    '/assets//modelos/prontuario-diafragmas-rev12.xlsx', '/assets/modelos/../modelos/prontuario-diafragmas-rev12.xlsx',
    '/server/modelos/prontuario-diafragmas-rev12.xlsx', '/modelos/prontuario-diafragmas-rev12.xlsx']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    const tipo = String(r.headers.get('content-type') || '');
    const corpo = Buffer.from(await r.arrayBuffer());
    assert.ok(!tipo.includes(XLSX) && corpo.subarray(0, 2).toString() !== 'PK', `${p} devolveu a planilha (${r.status} ${tipo})`);
  }
}));

test('sessão forjada (assinatura errada) é recusada', () => servidor(async base => {
  const r = await fetch(`${base}/assets/modelos/prontuario-diafragmas-rev12.xlsx`, { headers: { cookie: 'biotrop_session=eyJ2IjoyfQ.assinatura-falsa' } });
  assert.equal(r.status, 401);
}));

test('mutação sem Origin/Referer é recusada; de outra origem também', () => servidor(async base => {
  let r = await fetch(`${base}/api/data/sci/x`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/api/data/sci/x`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://atacante.exemplo' }, body: '{}' });
  assert.equal(r.status, 403);
}));

test('cabeçalhos de segurança: sem HSTS duplicado no app, CSP e nosniff presentes', () => servidor(async base => {
  const r = await fetch(`${base}/`);
  assert.equal(r.headers.get('strict-transport-security'), null, 'HSTS fica só no nginx');
  assert.ok(r.headers.get('content-security-policy'));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
}));
