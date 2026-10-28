'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/worker-sharepoint');

const ENV = { GRAPH_TENANT_ID: '11111111-1111-1111-1111-111111111111', GRAPH_CLIENT_ID: '22222222-2222-2222-2222-222222222222', GRAPH_CLIENT_SECRET: 'x',
  SHAREPOINT_SITE: 'bioaqua.sharepoint.com:/sites/InteligenciaDados', SHAREPOINT_LISTA_BATELADAS: 'd07b105d-58cf-4bbd-b406-e6628fc635ab', DATABASE_WORKER_URL: 'postgres://x' };

test('nomes de coluna e data da lista', () => {
  assert.equal(W.colunaDoTanque('FTD01'), 'FTD 01');
  assert.equal(W.colunaDoTanque('BLD02'), 'BLR 02');
  assert.equal(W.colunaDoTanque('XYZ01'), null);
  assert.equal(W.diaBrasilia('2026-10-05T03:00:00Z'), '2026-10-05', 'meia-noite de Brasília gravada em UTC');
  assert.equal(W.diaBrasilia('2026-10-05T02:59:00Z'), '2026-10-04');
  assert.throws(() => W.loadConfig({ ...ENV, SHAREPOINT_SITE: 'https://evil.example/x' }), /SHAREPOINT_SITE/);
});

/** Graph de mentira: lista com um item para 2026-10-04 e colunas com nome interno codificado. */
function graphFalso() {
  const chamadas = [], itens = new Map([['7', { Data: '2026-10-04T03:00:00Z' }]]);
  let proximo = 8;
  const res = (status, j) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
  const fetch = async (url, o = {}) => {
    const m = o.method || 'GET';
    chamadas.push(`${m} ${url.replace('https://graph.microsoft.com/v1.0', '')}`);
    if (url.includes('/oauth2/')) return res(200, { access_token: 't', expires_in: 3600 });
    if (url.includes('/columns')) return res(200, { value: [{ displayName: 'Data', name: 'Data' }, { displayName: 'FTD 01', name: 'FTD_x0020_01' }, { displayName: 'BLR 02', name: 'BLR_x0020_02' }] });
    if (/\/sites\/bioaqua/.test(url)) return res(200, { id: 'site-1' });
    if (m === 'GET' && url.includes('/items?')) return res(200, { value: [...itens].map(([id, f]) => ({ id, fields: f })) });
    if (m === 'PATCH') { const id = /items\/(\d+)\/fields/.exec(url)[1]; Object.assign(itens.get(id), JSON.parse(o.body)); return res(200, {}); }
    if (m === 'POST') { const id = String(proximo++); itens.set(id, JSON.parse(o.body).fields); return res(201, { id }); }
    return res(404, {});
  };
  return { fetch, chamadas, itens };
}
function dbFalso(fila) {
  const linhas = new Map(fila.map(f => [f.data, { ...f, pendente: true, tentativas: 0, revisao: '1' }])), log = [];
  return { linhas, log, query: async (sql, p = []) => {
    log.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }] };
    if (/FROM pcm.batelada_sharepoint/.test(sql)) return { rows: [...linhas.values()].filter(l => l.pendente).map(l => ({ ...l })) };
    if (/batelada_contadores_em/.test(sql)) return { rows: [{ codigo: 'FTD01', acumulado: p[0] === '2026-10-04' ? 98 : 99 }, { codigo: 'BLD02', acumulado: 150 }, { codigo: 'PGD99', acumulado: 1 }] };
    if (/SET pendente=/.test(sql)) { const l = linhas.get(p[0]); Object.assign(l, { pendente: l.revisao !== p[2], item_id: p[1] }); return { rows: [] }; }
    if (/tentativas=tentativas\+1/.test(sql)) { const l = linhas.get(p[0]); if (l.revisao === p[2]) { l.tentativas++; l.erro = p[1]; } return { rows: [] }; }
    return { rows: [] };
  } };
}

test('worker atualiza a linha do dia que já existe e cria a que falta, com os nomes internos das colunas', async () => {
  const cfg = W.loadConfig(ENV), g = graphFalso(), db = dbFalso([{ data: '2026-10-04' }, { data: '2026-10-05' }]);
  const r = await W.processar({ cfg, db, graph: W.createGraph(cfg, g.fetch) });
  assert.deepEqual(r, { enviados: 2, falhas: 0 });
  assert.deepEqual(g.itens.get('7'), { Data: '2026-10-04T03:00:00Z', FTD_x0020_01: 98, BLR_x0020_02: 150 }, 'dia existente: só os contadores mudam');
  assert.deepEqual(g.itens.get('8'), { FTD_x0020_01: 99, BLR_x0020_02: 150, Data: '2026-10-05T12:00:00Z' }, 'dia novo: cria a linha');
  assert.equal(db.linhas.get('2026-10-04').item_id, '7');
  assert.ok(!g.chamadas.some(c => /PGD/.test(c)), 'tanque sem coluna na lista é ignorado');
});

test('alteração durante envio continua pendente e reutiliza o item criado no próximo envio', async () => {
  const cfg = W.loadConfig(ENV), db = dbFalso([{ data: '2026-10-04' }]);
  let writes = 0;
  const graph = { async gravarDia(_dia, _contadores, id) {
    writes++;
    if (writes === 1) { assert.equal(id, undefined); db.linhas.get('2026-10-04').revisao = '2'; }
    else assert.equal(id, 'created-once');
    return 'created-once';
  } };
  await W.processar({ cfg, db, graph });
  assert.equal(db.linhas.get('2026-10-04').pendente, true);
  await W.processar({ cfg, db, graph });
  assert.equal(db.linhas.get('2026-10-04').pendente, false);
  assert.equal(writes, 2);
});

test('falha de envio antigo não aumenta tentativas de uma alteração reenfileirada durante envio', async () => {
  const cfg = W.loadConfig(ENV), db = dbFalso([{ data: '2026-10-04' }]);
  await W.processar({ cfg, db, graph: { async gravarDia() {
    db.linhas.get('2026-10-04').revisao = '2'; throw new Error('synthetic failure');
  } } });
  assert.equal(db.linhas.get('2026-10-04').pendente, true);
  assert.equal(db.linhas.get('2026-10-04').tentativas, 0);
});

test('sem permissão (403): marca o erro e para o lote', async () => {
  const cfg = W.loadConfig(ENV), db = dbFalso([{ data: '2026-10-04' }, { data: '2026-10-05' }]);
  const fetch = async url => url.includes('/oauth2/') ? { ok: true, status: 200, json: async () => ({ access_token: 't' }) }
    : { ok: false, status: 403, json: async () => ({}), text: async () => { throw new Error('must not read sensitive external error body'); } };
  const r = await W.processar({ cfg, db, graph: W.createGraph(cfg, fetch) });
  assert.deepEqual(r, { enviados: 0, falhas: 1 });
  assert.match(db.linhas.get('2026-10-04').erro, /403/);
  assert.equal(db.linhas.get('2026-10-05').tentativas, 0, 'não insiste nos outros dias sem permissão');
});
