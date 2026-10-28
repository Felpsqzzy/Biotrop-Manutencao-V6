'use strict';
// Utilidades: o técnico não aponta leitura menor que a anterior (trava no servidor, migration 28); o PCM corrige.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h;
test.before(async () => { h = await subirApp({ tec: 'tecnico', tec2: 'tecnico', pcm: 'pcm' }); });
test.after(() => h?.fechar());

const grava = (u, id, reading, at) => h.api(u, 'PUT', `/api/data/utility_readings/${id}`, { payload: { id, meterId: 'CAMM1-AGUA-01', reading, at, user: 'x' } });

test('leitura menor que a anterior: técnico é barrado (mesmo de outro técnico); PCM corrige', async () => {
  let r = await grava(h.users.tec, 'rA', 1000, '2026-09-01T08:00:00.000Z');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await grava(h.users.tec2, 'rB', 990, '2026-09-02T08:00:00.000Z');
  assert.equal(r.s, 403, 'outro técnico também não aponta abaixo (a conferência vê leituras que ele não enxerga)');
  assert.match(r.j.erro, /menor que a anterior/);
  r = await grava(h.users.tec2, 'rB', 1015.5, '2026-09-02T08:00:00.000Z');
  assert.equal(r.s, 200);
  r = await grava(h.users.tec, 'rC', 1001, '2026-08-31T08:00:00.000Z');
  assert.equal(r.s, 200, 'leitura de data anterior compara só com o que veio antes dela');
  r = await grava(h.users.pcm, 'rD', 900, '2026-09-03T08:00:00.000Z');
  assert.equal(r.s, 200, 'PCM corrige/lança sem a trava');
  r = await grava(h.users.tec, 'rE', -1, '2026-09-04T08:00:00.000Z');
  assert.equal(r.s, 400);
});
