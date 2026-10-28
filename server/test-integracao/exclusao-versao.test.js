'use strict';
// Exclusão de SCI/SCM por perfil (checkExclusao) e a versão obrigatória (428 sem expectedVersion, 409 com versão velha).
// Tudo pela API, com o app real contra PGlite + migrations + RLS. Dados fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h, U;
test.before(async () => {
  h = await subirApp({
    sol: 'tecnico', outro: 'tecnico', lider: 'lider', liderOutro: 'lider', gest: 'gestor',
    almox: 'almoxarife', pcm: 'pcm', adm: 'admin', visu: 'viewer'
  });
  U = h.users;
  const g1 = (await h.q(`INSERT INTO core.grupo(codigo,nome,responsavel_id) VALUES('ev-a','Grupo A',$1) RETURNING id`, [U.lider.id])).rows[0].id;
  const g2 = (await h.q(`INSERT INTO core.grupo(codigo,nome,responsavel_id) VALUES('ev-b','Grupo B',$1) RETURNING id`, [U.liderOutro.id])).rows[0].id;
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id = ANY($2::uuid[])', [g1, [U.sol.id, U.lider.id]]);
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id = ANY($2::uuid[])', [g2, [U.outro.id, U.liderOutro.id]]);
  for (const u of Object.values(U)) u.sv = (await h.q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [u.id])).rows[0].sessao_versao;
});
test.after(() => h?.fechar());

const itens = () => [{ id: 'i1', descricao: 'Rolamento 6205', quantidade: 2, unidade: 'PÇ' }];
const scm = (u, extra = {}) => ({
  codigo: 'SCM-T', solicitanteId: u.id, solicitanteNome: 'x', status: 'pendente_aprovacao_lider',
  tipoPedido: 'compra_material', tipoSolicitacao: 'OPEX', tipoFornecedor: 'Qualquer', numeroOM: 'OM00048601', itens: itens(), ...extra
});
const sci = (u, extra = {}) => ({ codigo: 'SCI-T', solicitanteId: u.id, solicitanteNome: 'x', status: 'aberto', familia: 'Rolamentos', descricao: 'Rolamento 6205 2RS', ...extra });
const put = (u, ns, id, payload, extra = {}) => h.api(u, 'PUT', `/api/data/${ns}/${id}`, { payload: { id, ...payload }, ...extra });
/** Cria (versão 0) e devolve { payload, version }. */
async function cria(u, ns, id, payload) {
  const r = await put(u, ns, id, payload, { expectedVersion: 0 });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  return { payload: r.j.row.payload, version: r.j.row.version };
}
async function estado(u, ns, id) { const r = await h.api(u, 'GET', `/api/data/${ns}`); return r.j.rows.find(x => x.recordId === id); }
const apaga = (u, ns, id, reg, extra = {}) => put(u, ns, id, reg.payload, { deleted: true, expectedVersion: reg.version, ...extra });
function recusado(r, msg) { assert.equal(r.s, 403, `${msg} → ${r.s} ${JSON.stringify(r.j)}`); }

test('SCM: quem não é a gestão nem o solicitante em revisão não exclui; nada é gravado', async () => {
  const reg = await cria(U.sol, 'scm', 'ev-scm-1', scm(U.sol));
  for (const [k, msg] of [['outro', 'técnico de outro grupo'], ['liderOutro', 'líder de outro grupo'], ['visu', 'viewer (sem escrita no módulo)'], ['sol', 'solicitante aguardando aprovação']]) {
    recusado(await apaga(U[k], 'scm', 'ev-scm-1', reg), msg);
  }
  // líder/gestor que APROVAM não excluem (a exclusão é da compra ou do solicitante em revisão); PCM só em SCM de serviço
  recusado(await apaga(U.lider, 'scm', 'ev-scm-1', reg), 'líder aprovador');
  recusado(await apaga(U.pcm, 'scm', 'ev-scm-1', reg), 'PCM em SCM de material');
  const aindaLa = await estado(U.adm, 'scm', 'ev-scm-1');
  assert.ok(aindaLa && aindaLa.deleted !== true, 'registro intacto');
  assert.equal(aindaLa.version, reg.version, 'versão não andou');
});

test('SCM aprovada: o próprio solicitante não exclui mais; o almoxarifado exclui e a trilha guarda quem fez', async () => {
  const reg = await cria(U.sol, 'scm', 'ev-scm-2', scm(U.sol));
  const ap = await put(U.lider, 'scm', 'ev-scm-2', { ...reg.payload, status: 'aprovada' }, { expectedVersion: reg.version });
  assert.equal(ap.s, 200, JSON.stringify(ap.j));
  const aprovada = { payload: ap.j.row.payload, version: ap.j.row.version };
  recusado(await apaga(U.sol, 'scm', 'ev-scm-2', aprovada), 'solicitante com a SCM aprovada');
  recusado(await apaga(U.outro, 'scm', 'ev-scm-2', aprovada), 'outro técnico');
  recusado(await apaga(U.visu, 'scm', 'ev-scm-2', aprovada), 'viewer');
  // payload forjado do solicitante dizendo "revisao_solicitada" não engana: vale o status do banco
  recusado(await apaga(U.sol, 'scm', 'ev-scm-2', { payload: { ...aprovada.payload, status: 'revisao_solicitada' }, version: aprovada.version }), 'status forjado');
  const r = await apaga(U.almox, 'scm', 'ev-scm-2', { payload: { ...aprovada.payload, codigo: 'FORJADO', itens: [] }, version: aprovada.version });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.row.deleted, true);
  assert.equal(r.j.row.payload.codigo, 'SCM-T', 'grava o before do banco, não o payload do cliente');
  assert.equal(r.j.row.payload.itens.length, 1);
  const ult = r.j.row.payload.historico.at(-1);
  assert.deepEqual([ult.para, ult.evento, ult.porId, ult.perfil], ['excluida', 'exclusao', U.almox.id, 'almoxarife']);
});

test('SCM de serviço: o PCM exclui (é da compra); em SCM de material não', async () => {
  const reg = await cria(U.sol, 'scm', 'ev-scm-3', scm(U.sol, { tipoPedido: 'contratacao_servico_pcm' }));
  const r = await apaga(U.pcm, 'scm', 'ev-scm-3', reg);
  assert.equal(r.s, 200, JSON.stringify(r.j));
});

test('SCI: outro técnico, viewer e líder não excluem; solicitante exclui a própria enquanto aberta; cadastro exclui a de qualquer um', async () => {
  const reg = await cria(U.sol, 'sci', 'ev-sci-1', sci(U.sol));
  recusado(await apaga(U.outro, 'sci', 'ev-sci-1', reg), 'outro técnico');
  recusado(await apaga(U.visu, 'sci', 'ev-sci-1', reg), 'viewer');
  recusado(await apaga(U.liderOutro, 'sci', 'ev-sci-1', reg), 'líder de outro grupo');
  recusado(await apaga(U.pcm, 'sci', 'ev-sci-1', reg), 'PCM não trata SCI');
  assert.equal((await apaga(U.sol, 'sci', 'ev-sci-1', reg)).s, 200, 'solicitante, SCI aberta');
  const reg2 = await cria(U.outro, 'sci', 'ev-sci-2', sci(U.outro));
  const r = await apaga(U.almox, 'sci', 'ev-sci-2', reg2);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.row.payload.historico.at(-1).evento, 'exclusao');
  // SCI em tratamento pelo cadastro: o solicitante deixa de poder excluir
  const reg3 = await cria(U.sol, 'sci', 'ev-sci-3', sci(U.sol));
  const tr = await put(U.almox, 'sci', 'ev-sci-3', { ...reg3.payload, status: 'aguardando_cadastro', numeroSolicitacaoCadastro: 'CAD-1' }, { expectedVersion: reg3.version });
  assert.equal(tr.s, 200, JSON.stringify(tr.j));
  recusado(await apaga(U.sol, 'sci', 'ev-sci-3', { payload: tr.j.row.payload, version: tr.j.row.version }), 'solicitante com a SCI em cadastro');
});

test('excluir registro inexistente ou já excluído não cria nem regrava', async () => {
  const r = await put(U.almox, 'scm', 'ev-scm-fantasma', scm(U.almox), { deleted: true, expectedVersion: 0 });
  assert.ok(r.s === 400 || r.s === 403, `${r.s} ${JSON.stringify(r.j)}`);
  assert.equal(await estado(U.adm, 'scm', 'ev-scm-fantasma'), undefined);
});

test('428 sem expectedVersion e 409 com versão velha, em SCM, SCI e na exclusão; nada muda', async () => {
  for (const [ns, id, base, novo] of [['scm', 'ev-v-scm', scm(U.sol), { descricaoExtra: 'a' }], ['sci', 'ev-v-sci', sci(U.sol), { descricao: 'Rolamento 6206' }]]) {
    const reg = await cria(U.sol, ns, id, base);
    // revisão para o solicitante poder editar: SCI 'aberto' já edita; SCM aguardando aprovação não, então testa pelo almoxarifado (compras)
    const quem = ns === 'scm' ? U.almox : U.sol;
    const sem = await put(quem, ns, id, { ...reg.payload, ...novo });
    assert.equal(sem.s, 428, `${ns} sem versão: ${JSON.stringify(sem.j)}`);
    for (const ruim of [null, undefined]) {
      assert.equal((await put(quem, ns, id, { ...reg.payload, ...novo }, { expectedVersion: ruim })).s, 428, `${ns} expectedVersion ${ruim}`);
    }
    for (const velha of [0, reg.version + 1, -1, 1.5, 'abc', '', [], {}, 1e308]) {
      const r = await put(quem, ns, id, { ...reg.payload, ...novo }, { expectedVersion: velha });
      assert.equal(r.s, 409, `${ns} versão ${JSON.stringify(velha)} → ${r.s} ${JSON.stringify(r.j).slice(0, 200)}`);
    }
    const del428 = await put(U.almox, ns, id, reg.payload, { deleted: true });
    assert.equal(del428.s, 428, 'exclusão sem versão');
    const del409 = await put(U.almox, ns, id, reg.payload, { deleted: true, expectedVersion: reg.version + 7 });
    assert.equal(del409.s, 409, 'exclusão com versão velha');
    const e = await estado(U.adm, ns, id);
    assert.equal(e.version, reg.version, 'nenhuma tentativa recusada mexeu no registro');
    assert.ok(!e.deleted);
  }
});

test('versão como string numérica "N" é aceita igual a N (a tela às vezes manda texto)', async () => {
  const reg = await cria(U.sol, 'sci', 'ev-v-str', sci(U.sol));
  const r = await put(U.sol, 'sci', 'ev-v-str', { ...reg.payload, descricao: 'Rolamento 6207' }, { expectedVersion: String(reg.version) });
  assert.equal(r.s, 200, JSON.stringify(r.j));
});

test('criação (registro novo) segue aceitando sem versão; o segundo envio igual vira 428', async () => {
  const novo = await put(U.sol, 'sci', 'ev-v-novo', sci(U.sol));
  assert.equal(novo.s, 200, JSON.stringify(novo.j));
  const repetido = await put(U.sol, 'sci', 'ev-v-novo', sci(U.sol));
  assert.equal(repetido.s, 428, 'repetir sem versão não sobrescreve');
});

test('duas gravações em paralelo com a mesma versão: uma vence, a outra leva 409', async () => {
  const reg = await cria(U.sol, 'sci', 'ev-v-par', sci(U.sol));
  const rs = await Promise.all([1, 2, 3, 4, 5].map(n => put(U.sol, 'sci', 'ev-v-par', { ...reg.payload, descricao: 'Rolamento paralelo ' + n }, { expectedVersion: reg.version })));
  const cont = s => rs.filter(r => r.s === s).length;
  assert.equal(cont(200), 1, rs.map(r => r.s).join());
  assert.equal(cont(409), 4, rs.map(r => r.s).join());
  assert.equal((await estado(U.adm, 'sci', 'ev-v-par')).version, reg.version + 1);
});

test('texto enorme e decimal com vírgula no payload não derrubam (sem 500)', async () => {
  const r = await put(U.sol, 'scm', 'ev-enorme', scm(U.sol, { itens: [{ id: 'i1', descricao: 'x'.repeat(200_000), quantidade: '1,5', unidade: 'PÇ' }] }), { expectedVersion: 0 });
  assert.ok(r.s < 500, `${r.s} ${JSON.stringify(r.j).slice(0, 200)}`);
});
