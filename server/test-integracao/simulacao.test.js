'use strict';
// Modo de teste: vários usuários virtuais usando o sistema ao mesmo tempo, pela API real, sob RLS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h;
test.before(async () => { h = await subirApp({ admin: 'admin', tec: 'tecnico', pcm: 'pcm', gestor: 'gestor' }); });
test.after(() => h?.fechar());
const espera = ms => new Promise(r => setTimeout(r, ms));

test('só o admin abre o modo de teste', async () => {
  for (const k of ['tec', 'pcm', 'gestor']) assert.equal((await h.api(h.users[k], 'GET', '/api/admin/simulacao/estado')).s, 403);
  const r = await h.api(h.users.admin, 'GET', '/api/admin/simulacao/estado');
  assert.equal(r.s, 200); assert.equal(r.j.estado, 'parado'); assert.equal(r.j.permitido, true);
  assert.equal(r.j.equipeReal.tecnico, 1);
});

test('simulação: todos os perfis ao mesmo tempo, sem erro de servidor e com a segurança de pé', async () => {
  let r = await h.api(h.users.admin, 'POST', '/api/admin/simulacao/iniciar', {
    quantidades: { tecnico: 5, lider: 1, almoxarife: 2, pcm: 1, gestor: 1, viewer: 1 }, minutos: 0.4, ritmo: 'pico', rede: 'ips' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await h.api(h.users.admin, 'POST', '/api/admin/simulacao/iniciar', { quantidades: { tecnico: 1 } })).s, 409, 'uma por vez');
  for (let i = 0; i < 120; i++) { await espera(1000); r = await h.api(h.users.admin, 'GET', '/api/admin/simulacao/estado'); if (r.j.estado === 'parado') break; }
  const e = r.j;
  assert.equal(e.estado, 'parado');
  assert.equal(e.usuarios.length, 11);
  assert.ok(e.kpis.req > 50, `poucas requisições: ${e.kpis.req}`);
  const erros = e.eventos.filter(x => x.tipo === 'erro');
  assert.equal(e.kpis.erros, 0, JSON.stringify(erros.slice(0, 5)));
  assert.equal(e.kpis.limite, 0);
  assert.ok(e.criados.sci > 0 && e.criados.scm > 0, JSON.stringify(e.criados));
  assert.ok(e.kpis.seguranca > 0, 'fez tentativas indevidas');
  assert.equal(e.kpis.segurancaFalhas, 0, JSON.stringify(e.seguranca));
  assert.ok(e.resultado.length > 0 && e.resultado.every(x => x.tom !== 'ruim'), JSON.stringify(e.resultado));
  // fluxo andou: alguma SCM aprovada/tratada pelo líder/almoxarife virtuais
  const fluxo = (await h.q(`SELECT payload->>'status' st, count(*)::int n FROM app.sync_registro WHERE namespace='scm' AND payload->>'_simulacao'='true' GROUP BY 1`)).rows;
  assert.ok(fluxo.some(x => x.st !== 'pendente_aprovacao_lider'), JSON.stringify(fluxo));
});

test('isolamento: gestão real não vê os registros de teste; o admin vê; não dá para forjar a marca', async () => {
  const sim = (await h.q(`SELECT count(*)::int n FROM app.sync_registro WHERE payload->>'_simulacao'='true'`)).rows[0].n;
  assert.ok(sim > 0);
  for (const k of ['pcm', 'gestor']) {
    const r = await h.api(h.users[k], 'GET', '/api/data/sci');
    assert.equal(r.j.rows.filter(x => x.payload?._simulacao).length, 0, `${k} não pode ver dado de teste`);
  }
  const a = await h.api(h.users.admin, 'GET', '/api/data/sci');
  assert.ok(a.j.rows.some(x => x.payload?._simulacao === true));
  // técnico real tentando esconder uma SCI dos gestores com a marca de teste: o servidor tira a marca
  const id = 'sci-real-1';
  let r = await h.api(h.users.tec, 'PUT', `/api/data/sci/${id}`, { expectedVersion: 0, payload: { id, solicitanteId: h.users.tec.id, status: 'pendente', familiaId: 'outros', _simulacao: true } });
  assert.equal(r.s, 200);
  r = await h.api(h.users.gestor, 'GET', '/api/data/sci');
  assert.ok(r.j.rows.some(x => x.recordId === id), 'registro real continua visível para a gestão');
});

test('limpar: apaga os registros de teste e desativa os usuários virtuais', async () => {
  const r = await h.api(h.users.admin, 'POST', '/api/admin/simulacao/limpar');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await h.q(`SELECT count(*)::int n FROM app.sync_registro WHERE payload->>'_simulacao'='true' OR record_id LIKE 'SIM-%'`)).rows[0].n, 0);
  assert.equal((await h.q(`SELECT count(*)::int n FROM core.usuario WHERE email LIKE '%@simulacao.biomanut.local' AND ativo`)).rows[0].n, 0);
  assert.equal((await h.q(`SELECT count(*)::int n FROM app.sync_registro WHERE record_id='sci-real-1'`)).rows[0].n, 1, 'dado real não é apagado');
});
