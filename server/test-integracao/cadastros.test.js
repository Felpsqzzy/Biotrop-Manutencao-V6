'use strict';
// PCM · Cadastros (SCI × SCM): o que a tela grava tem de estar no banco — sob o RLS de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h;
test.before(async () => { h = await subirApp({ tec: 'tecnico', pcm: 'pcm', gestor: 'gestor', almox: 'almoxarife' }); });
test.after(() => h?.fechar());

const familia = async id => (await h.q('SELECT ativo FROM almox.familia WHERE id=$1', [id])).rows[0]?.ativo;
const campos = async id => (await h.q('SELECT count(*)::int n FROM almox.familia_campo WHERE familia_id=$1 AND ativo', [id])).rows[0].n;

test('almoxarifado desliga e religa família da SCI: o banco muda junto e os campos continuam', async () => {
  const id = (await h.q('SELECT familia_id id FROM almox.familia_campo WHERE ativo GROUP BY 1 ORDER BY count(*) DESC LIMIT 1')).rows[0].id;
  const n = await campos(id);
  assert.ok(n > 0);
  let r = await h.api(h.users.almox, 'POST', '/api/master-data?resource=familias', { id, nome: 'Família', ativo: false, somenteStatus: true });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(await familia(id), false, 'desligou no banco (antes o RLS ignorava e a tela mostrava "ok")');
  assert.equal(await campos(id), n, 'desligar não apaga os campos');
  r = await h.api(h.users.pcm, 'GET', '/api/master-data?resource=familias');
  assert.equal(r.j.rows.find(f => f.id === id).ativo, false);
  r = await h.api(h.users.almox, 'POST', '/api/master-data?resource=familias', { id, nome: 'Família', ativo: true, somenteStatus: true });
  assert.equal(r.s, 200);
  assert.equal(await familia(id), true);
  assert.equal(r.j.row.campos.length, n, 'religou com os mesmos campos');
  // DELETE (ocultar) também grava de verdade
  r = await h.api(h.users.gestor, 'DELETE', `/api/master-data?resource=familias&id=${encodeURIComponent(id)}`);
  assert.equal(r.s, 200); assert.equal(await familia(id), false); assert.equal(await campos(id), n);
});

test('família desligada do jeito antigo (campos desligados) volta com os campos ao religar', async () => {
  const id = (await h.q('SELECT familia_id id FROM almox.familia_campo GROUP BY 1 ORDER BY count(*) DESC OFFSET 1 LIMIT 1')).rows[0].id;
  await h.q('UPDATE almox.familia SET ativo=false WHERE id=$1', [id]);
  await h.q('UPDATE almox.familia_campo SET ativo=false WHERE familia_id=$1', [id]);
  const r = await h.api(h.users.almox, 'POST', '/api/master-data?resource=familias', { id, nome: 'X', ativo: true, somenteStatus: true });
  assert.equal(r.s, 200);
  assert.ok(r.j.row.campos.length > 0 && await campos(id) > 0);
});

test('almoxarifado liga e desliga opção da SCM e cria centro de custo novo', async () => {
  let r = await h.api(h.users.pcm, 'GET', '/api/master-data?resource=lista&list=scm_time');
  const op = r.j.rows[1];
  r = await h.api(h.users.almox, 'DELETE', `/api/master-data?resource=lista&list=scm_time&id=${op.id}`);
  assert.equal(r.s, 200);
  r = await h.api(h.users.almox, 'POST', '/api/master-data?resource=lista&list=scm_time', { ...op, ativo: true });
  assert.equal(r.s, 200); assert.equal(r.j.row.ativo, true);
  r = await h.api(h.users.pcm, 'GET', '/api/master-data?resource=lista&list=scm_time');
  assert.equal(r.j.rows.find(x => x.id === op.id).ativo, true);
  r = await h.api(h.users.almox, 'POST', '/api/master-data?resource=lista&list=scm_centro_custo', { codigo: 'cc_teste_pcm', nome: 'MANUTENÇÃO TESTE PCM', ativo: true });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.ok(r.j.row.metadata.centro_custo_id > 0, 'centro de custo criado em almox.centro_custo');
});

test('ocultar algo que não existe não responde "ok"; técnico não edita', async () => {
  let r = await h.api(h.users.almox, 'DELETE', '/api/master-data?resource=familias&id=nao-existe');
  assert.equal(r.s, 409);
  r = await h.api(h.users.tec, 'POST', '/api/master-data?resource=familias', { id: 'x', nome: 'x', ativo: true, somenteStatus: true });
  assert.equal(r.s, 403);
});

test('PCM não edita os cadastros do almoxarifado (API e banco)', async () => {
  const id = (await h.q('SELECT id FROM almox.familia LIMIT 1')).rows[0].id;
  let r = await h.api(h.users.pcm, 'POST', '/api/master-data?resource=familias', { id, nome: 'X', ativo: false, somenteStatus: true });
  assert.equal(r.s, 403);
  r = await h.api(h.users.pcm, 'POST', '/api/master-data?resource=lista&list=scm_time', { codigo: 'x', nome: 'X' });
  assert.equal(r.s, 403);
  // leitura continua aberta: os formulários precisam das listas
  r = await h.api(h.users.pcm, 'GET', '/api/master-data?resource=lista&list=scm_time');
  assert.equal(r.s, 200);
  // e o banco recusa mesmo se a API fosse contornada
  const n = await h.transaction({ id: h.users.pcm.id, email: h.users.pcm.email }, db => db.query('UPDATE almox.familia SET ativo=false WHERE id=$1', [id]).then(x => x.rowCount));
  assert.equal(n, 0);
});
