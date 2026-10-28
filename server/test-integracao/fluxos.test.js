'use strict';
// Teste de estresse dos fluxos de SCM e SCI (pedido de 05/10/2026: "testar e estressar bem os fluxos antes de usar").
// Roda o app de verdade contra PostgreSQL (PGlite) com todas as migrations e o RLS ligado, com cada perfil agindo
// pela API. Cada passo certo é seguido das tentativas erradas que o servidor precisa barrar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h, U, mec, aut, semResp;
test.before(async () => {
  h = await subirApp({
    sol: 'tecnico', sol2: 'tecnico', solAut: 'tecnico', lider: 'lider', lider2: 'lider',
    gest: 'gestor', almox: 'almoxarife', pcm: 'pcm', adm: 'admin'
  });
  U = h.users;
  mec = (await h.q(`INSERT INTO core.grupo(codigo,nome,responsavel_id) VALUES('f-mec','Manutenção/Predial',$1) RETURNING id`, [U.lider.id])).rows[0].id;
  aut = (await h.q(`INSERT INTO core.grupo(codigo,nome,responsavel_id) VALUES('f-aut','Automação',$1) RETURNING id`, [U.lider2.id])).rows[0].id;
  semResp = (await h.q(`INSERT INTO core.grupo(codigo,nome) VALUES('f-sem','Sem responsável') RETURNING id`)).rows[0].id;
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id = ANY($2::uuid[])', [mec, [U.sol.id, U.lider.id]]);
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id = ANY($2::uuid[])', [aut, [U.solAut.id, U.lider2.id]]);
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id=$2', [semResp, U.sol2.id]);
  for (const u of Object.values(U)) u.sv = (await h.q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [u.id])).rows[0].sessao_versao;
});
test.after(() => h?.fechar());

/* ------------------------------------------------------------------ ajudantes */
const atual = {};   // último payload gravado de cada registro (como a tela guarda)
const versao = {};  // e a versão dele: a tela (core/sync.js) manda sempre; sem ela o servidor responde 428
async function grava(u, ns, id, payload, extra = {}) {
  const r = await h.api(u, 'PUT', `/api/data/${ns}/${id}`, { payload: { id, ...payload }, expectedVersion: versao[id] ?? 0, ...extra });
  if (r.s === 200) { atual[id] = r.j.row.payload; versao[id] = r.j.row.version; }
  return r;
}
/** Muda o registro a partir do último estado gravado. */
const muda = (u, ns, id, mudancas, extra) => grava(u, ns, id, { ...atual[id], ...mudancas }, extra);
const ok = (r, msg) => assert.equal(r.s, 200, `${msg || ''} → ${JSON.stringify(r.j)}`);
function barra(r, padrao, msg) {
  assert.ok(r.s === 403 || r.s === 400, `${msg || 'deveria ser recusado'} (veio ${r.s}: ${JSON.stringify(r.j)})`);
  if (padrao) assert.match(String(r.j && r.j.erro), padrao, msg);
}
const itens = () => [{ id: 'i1', descricao: 'Rolamento 6205', quantidade: 2, unidade: 'PÇ' }, { id: 'i2', descricao: 'Retentor sem código', quantidade: 4, unidade: 'PÇ' }];
const scm = (u, extra = {}) => ({
  codigo: 'SCM-T', solicitanteId: u.id, solicitanteNome: `Pessoa ${u.email.split('@')[0]}`, status: 'pendente_aprovacao_lider',
  tipoPedido: 'compra_material', tipoSolicitacao: 'OPEX', tipoFornecedor: 'Qualquer', numeroOM: 'OM00048601', itens: itens(), ...extra
});
async function enxerga(u, ns, id) { const r = await h.api(u, 'GET', `/api/data/${ns}`); return r.j.rows.some(x => x.recordId === id); }

/* ------------------------------------------------------------------ SCM */
test('SCM · abertura: só em nome próprio, no primeiro passo e com os campos conferidos', async () => {
  barra(await grava(U.sol, 'scm', 'scm-x1', scm(U.sol2)), /próprio nome/, 'abrir em nome de outra pessoa');
  barra(await grava(U.sol, 'scm', 'scm-x2', scm(U.sol, { status: 'aprovada' })), /primeiro passo/, 'nascer aprovada');
  barra(await grava(U.sol, 'scm', 'scm-x3', scm(U.sol, { numeroOM: '48601' })), /OM00000000/, 'OM fora do formato');
  barra(await grava(U.sol, 'scm', 'scm-x4', scm(U.sol, { tipoSolicitacao: 'CAPEX' })), /projeto/, 'CAPEX sem projeto');
  barra(await grava(U.sol, 'scm', 'scm-x5', scm(U.sol, { tipoFornecedor: 'Exclusivo' })), /fornecedor/, 'exclusivo sem nome');
  const r = await grava(U.sol, 'scm', 'scm-1', scm(U.sol, { aprovadorId: U.gest.id, solicitanteEmailLider: U.gest.email }));
  ok(r, 'abertura válida');
  assert.equal(r.j.row.payload.aprovadorId, U.lider.id, 'o aprovador vem do grupo (o responsável), não do que o navegador mandou');
  assert.deepEqual(r.j.row.payload.historico, [], 'a trilha começa vazia no servidor');
});

test('SCM · leitura: líder do grupo vê; líder de outro grupo e outro técnico não veem', async () => {
  assert.equal(await enxerga(U.lider, 'scm', 'scm-1'), true, 'líder do solicitante');
  assert.equal(await enxerga(U.lider2, 'scm', 'scm-1'), false, 'líder de outro grupo');
  assert.equal(await enxerga(U.solAut, 'scm', 'scm-1'), false, 'outro técnico');
  assert.equal(await enxerga(U.gest, 'scm', 'scm-1'), true, 'gestão');
});

test('SCM · aprovação: ninguém fora o responsável (ou a gestão) decide; ninguém aprova o próprio pedido', async () => {
  barra(await muda(U.sol, 'scm', 'scm-1', { status: 'aprovada' }), /própria/, 'aprovar o próprio');
  barra(await muda(U.lider2, 'scm', 'scm-1', { status: 'aprovada' }), null, 'líder de outro grupo');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'aprovada' }), null, 'almoxarife');
  barra(await muda(U.pcm, 'scm', 'scm-1', { status: 'aprovada' }), null, 'PCM não aprova');
  barra(await muda(U.sol, 'scm', 'scm-1', { itens: [itens()[0]] }), /não pode alterar/, 'solicitante editando fora da revisão');
  barra(await muda(U.lider, 'scm', 'scm-1', { status: 'reprovada' }), /motivo/, 'reprovar sem motivo');
  barra(await muda(U.lider, 'scm', 'scm-1', { status: 'revisao_solicitada' }), /revisado/, 'revisão sem dizer o quê');
  barra(await muda(U.lider, 'scm', 'scm-1', { status: 'em_tratativa', numeroProcessoME: 'ME-1' }), /não pode ir/, 'pular etapas');
});

test('SCM · revisão do líder: solicitante corrige e reenvia, sem mexer no que é do almoxarifado', async () => {
  ok(await muda(U.lider, 'scm', 'scm-1', { status: 'revisao_solicitada', observacaoLider: 'Falta a unidade do item 2.' }));
  barra(await muda(U.sol, 'scm', 'scm-1', { numeroProcessoME: 'ME-999' }), /almoxarifado/, 'solicitante preenchendo o ME');
  barra(await muda(U.sol, 'scm', 'scm-1', { aprovadorId: U.sol2.id }), /aprovador/, 'solicitante trocando o aprovador');
  barra(await muda(U.sol, 'scm', 'scm-1', { itens: itens().map(i => ({ ...i, situacao: 'atendido' })) }), /almoxarifado marca/, 'solicitante marcando item na RC');
  ok(await muda(U.sol, 'scm', 'scm-1', { itens: [itens()[0], { ...itens()[1], unidade: 'UN', quantidade: 5 }] }), 'correção do pedido');
  barra(await muda(U.solAut, 'scm', 'scm-1', { status: 'pendente_aprovacao_lider' }), null, 'outra pessoa reenviando');
  ok(await muda(U.sol, 'scm', 'scm-1', { status: 'pendente_aprovacao_lider' }), 'reenvio');
  barra(await muda(U.lider, 'scm', 'scm-1', { status: 'reprovada' }), /motivo/, 'a observação da revisão anterior não vale como motivo da reprovação');
  ok(await muda(U.lider, 'scm', 'scm-1', { status: 'aprovada' }), 'aprovação pelo responsável');
  barra(await muda(U.sol, 'scm', 'scm-1', { itens: [itens()[0]] }), /não pode alterar/, 'aprovada não se edita mais');
  const hist = atual['scm-1'].historico.map(x => `${x.de}>${x.para}`);
  assert.deepEqual(hist, ['pendente_aprovacao_lider>revisao_solicitada', 'revisao_solicitada>pendente_aprovacao_lider', 'pendente_aprovacao_lider>aprovada']);
  assert.equal(atual['scm-1'].historico[2].porId, U.lider.id, 'a trilha registra quem decidiu');
});

test('SCM · almoxarifado devolve ao solicitante e recebe de volta', async () => {
  barra(await muda(U.sol, 'scm', 'scm-1', { status: 'revisao_almoxarifado', observacaoAlmoxarife: 'x' }), null, 'solicitante não se devolve');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'revisao_almoxarifado' }), /falta/, 'devolver sem dizer o quê');
  ok(await muda(U.almox, 'scm', 'scm-1', { status: 'revisao_almoxarifado', observacaoAlmoxarife: 'Informe a marca aceita do retentor.' }));
  barra(await muda(U.sol, 'scm', 'scm-1', { observacaoAlmoxarife: 'apagado' }), /almoxarifado/, 'solicitante apagando a observação do almoxarifado');
  ok(await muda(U.sol, 'scm', 'scm-1', { itens: [itens()[0], { ...itens()[1], marcasHomologadas: 'Sabó' }] }));
  barra(await muda(U.sol, 'scm', 'scm-1', { status: 'pendente_aprovacao_lider' }), /não pode ir/, 'reenvio pula a aprovação de novo? não: volta direto ao almoxarifado');
  ok(await muda(U.sol, 'scm', 'scm-1', { status: 'aprovada' }), 'reenvio ao almoxarifado');
});

test('SCM · RC aberta parcial e completa: só almoxarifado, com nº do ME e itens coerentes', async () => {
  barra(await muda(U.sol, 'scm', 'scm-1', { status: 'em_tratativa', numeroProcessoME: 'ME-1' }), null, 'solicitante abrindo RC');
  barra(await muda(U.lider, 'scm', 'scm-1', { status: 'em_tratativa', numeroProcessoME: 'ME-1' }), null, 'líder abrindo RC');
  barra(await muda(U.pcm, 'scm', 'scm-1', { status: 'em_tratativa', numeroProcessoME: 'ME-1' }), /PCM, nas SCMs de serviço/, 'PCM em SCM de material');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'em_tratativa' }), /ME/, 'RC sem nº do ME');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'parcial', numeroProcessoME: 'ME-1' }), /ao menos um item/, 'parcial sem item marcado');
  const [a, b] = atual['scm-1'].itens;
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'parcial', numeroProcessoME: 'ME-1', itens: [{ ...a, situacao: 'atendido' }, { ...b, situacao: 'atendido' }] }), /RC aberta/, 'parcial com todos os itens');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'parcial', numeroProcessoME: 'ME-1', itens: [{ ...a, situacao: 'qualquer' }, b] }), /inválida/, 'situação inventada');
  ok(await muda(U.almox, 'scm', 'scm-1', { status: 'parcial', numeroProcessoME: 'ME-1', itens: [{ ...a, situacao: 'atendido' }, b] }), 'RC parcial');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'concluida' }), /sem RC/, 'concluir com item fora da RC');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'em_tratativa' }), /fora da RC/, 'RC completa ainda com item de fora');
  const [a2, b2] = atual['scm-1'].itens;
  ok(await muda(U.almox, 'scm', 'scm-1', { status: 'em_tratativa', itens: [a2, { ...b2, situacao: 'atendido', codigo: 'MAN9001', codigoOriginal: '' }] }), 'item cadastrado entra na RC');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'aprovada' }), /não pode ir/, 'RC aberta não volta para aprovada');
  ok(await muda(U.almox, 'scm', 'scm-1', { status: 'concluida' }), 'conclusão');
  barra(await muda(U.almox, 'scm', 'scm-1', { status: 'em_tratativa' }), /não pode ir/, 'concluída não reabre');
});

test('SCM de serviço: o PCM abre a RC; sem responsável no grupo, a gestão aprova', async () => {
  const r = await grava(U.sol2, 'scm', 'scm-2', scm(U.sol2, { tipoPedido: 'contratacao_servico_pcm', numeroOM: 'OM00000777' }));
  ok(r);
  assert.equal(r.j.row.payload.aprovadorId, null, 'grupo sem responsável');
  assert.equal(r.j.row.payload.aprovadorOrigem, 'gestao');
  barra(await muda(U.lider, 'scm', 'scm-2', { status: 'aprovada' }), null, 'líder de outro grupo');
  ok(await muda(U.gest, 'scm', 'scm-2', { status: 'aprovada' }), 'gestão aprova');
  ok(await muda(U.pcm, 'scm', 'scm-2', { status: 'em_tratativa', numeroProcessoME: 'ME-77' }), 'PCM abre a RC do serviço');
  ok(await muda(U.pcm, 'scm', 'scm-2', { status: 'concluida' }));
});

test('SCM · exclusão e concorrência', async () => {
  ok(await grava(U.solAut, 'scm', 'scm-3', scm(U.solAut)));
  barra(await muda(U.solAut, 'scm', 'scm-3', {}, { deleted: true }), /antes da aprovação/, 'solicitante apaga só em revisão');
  ok(await muda(U.lider2, 'scm', 'scm-3', { status: 'revisao_solicitada', observacaoLider: 'Pedido duplicado?' }));
  const versao = (await h.api(U.solAut, 'GET', '/api/data/scm')).j.rows.find(x => x.recordId === 'scm-3').version;
  ok(await muda(U.solAut, 'scm', 'scm-3', { itens: [itens()[0]] }, { expectedVersion: versao }));
  const conflito = await muda(U.solAut, 'scm', 'scm-3', { itens: itens() }, { expectedVersion: versao });
  assert.equal(conflito.s, 409, 'gravação em cima de versão velha vira conflito, não sobrescreve');
  // sem a versão lida, a alteração é recusada (428) e nada muda: antes o "último grava vence" passava por cima
  const semVersao = await h.api(U.solAut, 'PUT', '/api/data/scm/scm-3', { payload: { ...atual['scm-3'], itens: itens() } });
  assert.equal(semVersao.s, 428, JSON.stringify(semVersao.j));
  assert.match(semVersao.j.erro, /versão/);
  const antes = atual['scm-3'];
  // a exclusão grava o registro do banco: trilha, aprovador e campos mandados pelo navegador são ignorados
  const r = await muda(U.solAut, 'scm', 'scm-3', { aprovadorId: U.solAut.id, solicitanteEmailLider: U.solAut.email, historico: [], codigo: 'SCM-FORJADA', itens: [] }, { deleted: true });
  ok(r, 'apaga o próprio pedido em revisão');
  assert.equal(r.j.row.deleted, true);
  assert.equal(r.j.row.payload.aprovadorId, antes.aprovadorId, 'aprovador continua o do servidor');
  assert.equal(r.j.row.payload.codigo, 'SCM-T');
  assert.deepEqual(r.j.row.payload.itens, antes.itens);
  assert.deepEqual(r.j.row.payload.historico.slice(0, -1), antes.historico, 'trilha anterior preservada');
  const ultimo = r.j.row.payload.historico.at(-1);
  assert.deepEqual([ultimo.de, ultimo.para, ultimo.evento, ultimo.porId], ['revisao_solicitada', 'excluida', 'exclusao', U.solAut.id], 'evento de exclusão no fim da trilha');
  barra(await muda(U.almox, 'scm', 'scm-3', {}, { deleted: true }), /inexistente ou já excluída/, 'excluir de novo (ou o que não existe) não grava nada');
});

/* ------------------------------------------------------------------ SCI */
const sci = (u, extra = {}) => ({ codigo: 'SCI-T', solicitanteId: u.id, solicitanteNome: 'x', status: 'aberto', familia: 'Rolamentos', descricao: 'Rolamento 6205 2RS', ...extra });

test('SCI · cadastro do item: só o almoxarifado trata, com nº da solicitação e código', async () => {
  barra(await grava(U.sol, 'sci', 'sci-x', sci(U.sol, { status: 'aguardando_cadastro' })), /primeiro passo/);
  ok(await grava(U.sol, 'sci', 'sci-1', sci(U.sol)));
  barra(await muda(U.sol, 'sci', 'sci-1', { status: 'aguardando_cadastro', numeroSolicitacaoCadastro: '1' }), null, 'solicitante tratando');
  barra(await muda(U.pcm, 'sci', 'sci-1', { status: 'aguardando_cadastro', numeroSolicitacaoCadastro: '1' }), /almoxarifado/, 'PCM não trata SCI');
  barra(await muda(U.lider, 'sci', 'sci-1', { status: 'aguardando_cadastro', numeroSolicitacaoCadastro: '1' }), null, 'líder não trata SCI');
  barra(await muda(U.almox, 'sci', 'sci-1', { status: 'em_compra' }), /não pode ir/, '"Enviar para compra" saiu');
  barra(await muda(U.almox, 'sci', 'sci-1', { status: 'aguardando_cadastro' }), /solicitação de cadastro/, 'sem o nº da solicitação');
  ok(await muda(U.almox, 'sci', 'sci-1', { status: 'aguardando_cadastro', numeroSolicitacaoCadastro: 'SC-2026-0101' }));
  barra(await muda(U.sol, 'sci', 'sci-1', { descricao: 'mudou' }), /não pode alterar/, 'solicitante editando em cadastro');
  barra(await muda(U.almox, 'sci', 'sci-1', { status: 'cadastrado' }), /código/, 'cadastrado sem código');
  ok(await muda(U.almox, 'sci', 'sci-1', { status: 'cadastrado', codigoItem: 'MAN9001' }));
  barra(await muda(U.almox, 'sci', 'sci-1', { status: 'aberto' }), /não pode ir/, 'cadastrada não reabre');
});

test('SCI · revisão pelo almoxarifado: solicitante edita e reenvia; rejeição exige motivo', async () => {
  ok(await grava(U.sol, 'sci', 'sci-2', sci(U.sol)));
  ok(await muda(U.sol, 'sci', 'sci-2', { descricao: 'Rolamento 6205 2RS C3' }), 'solicitante edita enquanto aberta');
  barra(await muda(U.almox, 'sci', 'sci-2', { status: 'revisao_solicitante' }), /corrigir/, 'revisão sem dizer o quê');
  ok(await muda(U.almox, 'sci', 'sci-2', { status: 'revisao_solicitante', observacaoAlmoxarife: 'Informe a folga (C3?).' }));
  ok(await muda(U.sol, 'sci', 'sci-2', { descricao: 'Rolamento 6205 2RS folga C3' }), 'edita na revisão');
  barra(await muda(U.solAut, 'sci', 'sci-2', { status: 'pendente_aprovacao' }), null, 'outra pessoa reenviando');
  ok(await muda(U.sol, 'sci', 'sci-2', { status: 'pendente_aprovacao' }), 'reenvio');
  barra(await muda(U.almox, 'sci', 'sci-2', { status: 'rejeitada' }), /motivo/, 'rejeitar sem motivo');
  ok(await muda(U.almox, 'sci', 'sci-2', { status: 'rejeitada', observacaoAlmoxarife: 'Item já existe: MAN9001.' }));
  assert.deepEqual(atual['sci-2'].historico.map(x => x.para), ['revisao_solicitante', 'pendente_aprovacao', 'rejeitada']);
  assert.deepEqual(atual['sci-2'].historico.map(x => x.nota), ['Informe a folga (C3?).', '', 'Item já existe: MAN9001.'], 'a trilha não repete a observação antiga no reenvio');
});

test('estresse: 40 SCMs abertas por 3 pessoas em paralelo, todas com o aprovador certo e sem perder gravação', async () => {
  const quem = [U.sol, U.solAut, U.sol2];
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => grava(quem[i % 3], 'scm', `scm-p${i}`, scm(quem[i % 3], { codigo: `SCM-P${i}` }))));
  rs.forEach((r, i) => ok(r, `scm-p${i}`));
  const esperado = { [U.sol.id]: U.lider.id, [U.solAut.id]: U.lider2.id, [U.sol2.id]: null };
  rs.forEach(r => assert.equal(r.j.row.payload.aprovadorId, esperado[r.j.row.payload.solicitanteId]));
  // e cada líder aprova só os do próprio grupo, em paralelo
  const dec = await Promise.all(Array.from({ length: 40 }, (_, i) => muda(i % 2 ? U.lider : U.lider2, 'scm', `scm-p${i}`, { status: 'aprovada' })));
  dec.forEach((r, i) => {
    const dono = quem[i % 3], lider = i % 2 ? U.lider : U.lider2;
    const pode = esperado[dono.id] === lider.id;
    assert.equal(r.s === 200, pode, `scm-p${i}: ${pode ? 'deveria aprovar' : 'não deveria aprovar'} (${r.s})`);
  });
  const n = (await h.q(`SELECT count(*)::int AS n FROM app.sync_registro WHERE namespace='scm' AND record_id LIKE 'scm-p%'`)).rows[0].n;
  assert.equal(n, 40);
});
