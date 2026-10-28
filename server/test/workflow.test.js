const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('../src/routes/workflow');

const tecnico = { id: 't1', email: 'tec@x', perfilId: 'tecnico' };
const lider = { id: 'l1', email: 'lider@x', perfilId: 'lider' };
const almox = { id: 'a1', email: 'almox@x', perfilId: 'almoxarife' };
const gestor = { id: 'g1', email: 'gestor@x', perfilId: 'gestor' };
const scm = (status, extra) => ({ solicitanteId: 't1', status, aprovadorId: 'l1', solicitanteEmailLider: 'lider@x', ...extra });

test('SCM criação recusa campos de atendimento e itens já atendidos, inclusive para gestores solicitantes', () => {
  for (const actor of [tecnico, almox, gestor]) {
    const base = { solicitanteId: actor.id, status: 'pendente_aprovacao_lider', itens: [{ id: 'item', situacao: 'pendente' }] };
    assert.equal(check('scm', null, base, actor), null);
    for (const key of ['numeroProcessoME', 'responsavelCompra', 'observacaoAlmoxarife', 'observacaoLider']) {
      assert.match(check('scm', null, { ...base, [key]: 'forjado' }, actor), /campos de aprovação ou atendimento/);
    }
    for (const item of [{ id: 'item', situacao: 'atendido' }, { id: 'item', situacao: 'cancelado' },
      { id: 'item', atendidoPor: 'forjado' }, { id: 'item', atendidoEm: '2026-10-06' }]) {
      assert.match(check('scm', null, { ...base, itens: [item] }, actor), /almoxarifado/);
    }
  }
});

test('SCM: only the group approver (or management) decides, never the requester', () => {
  assert.equal(check('scm', scm('pendente_aprovacao_lider'), scm('aprovada'), lider), null);
  assert.equal(check('scm', scm('pendente_aprovacao_lider'), scm('aprovada'), gestor), null);
  assert.match(check('scm', scm('pendente_aprovacao_lider'), scm('aprovada'), tecnico), /própria/);
  assert.match(check('scm', scm('pendente_aprovacao_lider'), scm('aprovada'), almox), /responsável do grupo/);
  const outroLider = { id: 'l2', email: 'outro@x', perfilId: 'lider' };
  assert.match(check('scm', scm('pendente_aprovacao_lider'), scm('aprovada'), outroLider), /responsável do grupo/);
  assert.equal(check('scm', scm('pendente_aprovacao_lider'), scm('aprovada'), { ...outroLider, lideraSolicitante: true }), null);
  // gestor que abriu a própria SCM também não aprova sozinho
  const propria = scm('pendente_aprovacao_lider', { solicitanteId: 'g1' });
  assert.match(check('scm', propria, { ...propria, status: 'aprovada' }, gestor), /própria/);
});

test('SCM: steps cannot be skipped and decisions need a reason', () => {
  assert.match(check('scm', scm('pendente_aprovacao_lider'), scm('concluida'), almox), /não pode ir/);
  assert.match(check('scm', scm('pendente_aprovacao_lider'), scm('reprovada'), lider), /motivo/);
  assert.equal(check('scm', scm('pendente_aprovacao_lider'), scm('reprovada', { observacaoLider: 'sem verba' }), lider), null);
  // abrir a RC ("em_tratativa" = RC aberta) exige o nº do processo no ME
  assert.match(check('scm', scm('aprovada'), scm('em_tratativa'), almox), /processo no ME/);
  assert.equal(check('scm', scm('aprovada'), scm('em_tratativa', { numeroProcessoME: 'ME-1' }), almox), null);
  assert.match(check('scm', scm('aprovada'), scm('em_tratativa', { numeroProcessoME: 'ME-1' }), lider), /almoxarifado/);
  assert.match(check('scm', scm('em_tratativa'), scm('concluida'), almox), /processo no ME/);
  assert.equal(check('scm', scm('em_tratativa'), scm('concluida', { numeroProcessoME: 'ME-1' }), almox), null);
  assert.match(check('scm', scm('concluida'), scm('aprovada'), gestor), /não pode ir/);
  assert.equal(check('scm', scm('revisao_solicitada'), scm('pendente_aprovacao_lider'), tecnico), null);
  assert.match(check('scm', scm('revisao_solicitada'), scm('pendente_aprovacao_lider'), lider), /quem abriu/);
});

test('SCM: requester edits only when revision is asked; never after approval', () => {
  assert.match(check('scm', scm('revisao_solicitada'), scm('revisao_solicitada', { aprovadorId: 't9', solicitanteEmailLider: 'amigo@x' }), tecnico), /aprovador/);
  assert.match(check('scm', scm('pendente_aprovacao_lider'), scm('pendente_aprovacao_lider', { descricaoUso: 'nova' }), tecnico), /Nesta etapa/, 'aguardando o gestor: não edita');
  assert.equal(check('scm', scm('revisao_solicitada'), scm('revisao_solicitada', { descricaoUso: 'nova' }), tecnico), null);
  assert.match(check('scm', scm('aprovada'), scm('aprovada', { itens: [] }), tecnico), /Nesta etapa/);
  assert.match(check('scm', null, { solicitanteId: 'outro', status: 'pendente_aprovacao_lider' }, tecnico), /próprio nome/);
  assert.match(check('scm', null, { solicitanteId: 't1', status: 'aprovada' }, tecnico), /primeiro passo/);
  assert.match(check('scm', scm('aprovada'), scm('aprovada', { solicitanteId: 'x' }), almox), /solicitante não pode/);
});

test('SCM: almoxarifado pede revisão depois de aprovada; o solicitante corrige e volta para o almoxarifado', () => {
  assert.match(check('scm', scm('aprovada'), scm('revisao_almoxarifado'), almox), /falta ou está errado/);
  const rev = scm('revisao_almoxarifado', { observacaoAlmoxarife: 'Falta a unidade do item 2' });
  assert.equal(check('scm', scm('aprovada'), rev, almox), null);
  assert.match(check('scm', scm('aprovada'), rev, tecnico), /almoxarifado/);
  assert.equal(check('scm', rev, { ...rev, descricaoUso: 'corrigido' }, tecnico), null, 'na revisão do almoxarifado o solicitante edita');
  assert.equal(check('scm', rev, { ...rev, status: 'aprovada' }, tecnico), null, 'reenvia: volta para o almoxarifado');
  assert.match(check('scm', rev, { ...rev, status: 'pendente_aprovacao_lider' }, tecnico), /não pode ir/);
});

test('SCM: campos do formulário conferidos no servidor (OM, CAPEX, fornecedor)', () => {
  const nova = extra => ({ solicitanteId: 't1', status: 'pendente_aprovacao_lider', ...extra });
  assert.match(check('scm', null, nova({ numeroOM: '48601' }), tecnico), /OM00000000/);
  assert.equal(check('scm', null, nova({ numeroOM: 'OM00048601' }), tecnico), null);
  assert.match(check('scm', null, nova({ numeroOM: 'OM00048601', tipoSolicitacao: 'melhoria_capex' }), tecnico), /projeto/);
  assert.equal(check('scm', null, nova({ numeroOM: 'OM00048601', tipoSolicitacao: 'melhoria_capex', capexProjeto: 'PRJ-2026-07' }), tecnico), null);
  assert.match(check('scm', null, nova({ tipoFornecedor: 'exclusivo' }), tecnico), /fornecedor/);
  assert.equal(check('scm', null, nova({ tipoFornecedor: 'exclusivo', nomeFornecedor: 'GEMÜ' }), tecnico), null);
  // SCM antiga com OM fora do formato: só é cobrada quando a OM muda
  assert.equal(check('scm', scm('aprovada', { numeroOM: '48601' }), scm('em_tratativa', { numeroOM: '48601', numeroProcessoME: '1' }), almox), null);
});

test('SCM: PCM trata só as SCMs de contratação de serviço; SCI não é do PCM', () => {
  const pcm = { id: 'p1', email: 'pcm@x', perfilId: 'pcm' };
  const serv = extra => scm('aprovada', { tipoPedido: 'contratacao_servico_pcm', ...extra });
  assert.equal(check('scm', serv(), serv({ status: 'em_tratativa', numeroProcessoME: 'ME-9' }), pcm), null);
  assert.match(check('scm', scm('aprovada', { tipoPedido: 'compra_material' }), scm('em_tratativa', { tipoPedido: 'compra_material', numeroProcessoME: 'ME-9' }), pcm), /almoxarifado/);
  const sci = (status, extra) => ({ solicitanteId: 't1', status, ...extra });
  assert.match(check('sci', sci('aberto'), sci('aguardando_cadastro', { numeroSolicitacaoCadastro: '77' }), pcm), /almoxarifado/);
});

test('SCI: almoxarifado handles it, requester resubmits, legacy names are not a change', () => {
  const sci = (status, extra) => ({ solicitanteId: 't1', status, ...extra });
  assert.equal(check('sci', sci('pendente'), sci('aberto'), tecnico), null, 'conversão de nome antigo');
  assert.match(check('sci', sci('aberto'), sci('aguardando_cadastro'), almox), /solicitação de cadastro/, 'nº da solicitação de cadastro é obrigatório');
  assert.equal(check('sci', sci('aberto'), sci('aguardando_cadastro', { numeroSolicitacaoCadastro: '77' }), almox), null);
  assert.match(check('sci', sci('aberto'), sci('aguardando_cadastro', { numeroSolicitacaoCadastro: '77' }), tecnico), /almoxarifado/);
  assert.match(check('sci', sci('aberto'), sci('em_compra'), almox), /não pode ir/, '"Enviar para compra" saiu da SCI');
  assert.match(check('sci', sci('aguardando_cadastro'), sci('cadastrado'), almox), /código do item/);
  assert.equal(check('sci', sci('aguardando_cadastro'), sci('cadastrado', { codigoItem: '123' }), almox), null);
  assert.match(check('sci', sci('aberto'), sci('revisao_solicitante'), almox), /corrigir/);
  assert.equal(check('sci', sci('revisao_solicitante'), sci('pendente_aprovacao'), tecnico), null);
  assert.match(check('sci', sci('cadastrado'), sci('aberto'), gestor), /não pode ir/);
});

test('the server owns approver identity and decision history', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.resolve(__dirname, '../src/routes/data.js'), 'utf8');
  assert.match(route, /incoming\.aprovadorId = before\.aprovadorId/);
  assert.match(route, /incoming\.historico = history\.slice\(-200\)/);
  assert.match(route, /porId: req\.user\.id/);
  assert.match(route, /delete incoming\._resposta/);
});

test('SCM: RC aberta parcial — itens sem código ficam fora da RC e entram depois', () => {
  const itens = (...s) => s.map((x, i) => ({ id: 'it' + i, codigoSistema: 'MAN' + i, quantidade: 1, ...(x ? { situacao: x } : {}) }));
  const me = { numeroProcessoME: 'ME-77' };
  const antes = scm('aprovada', { itens: itens(null, null, null, null, null) });
  // 4 itens com código entram na RC; o quinto ainda espera o cadastro
  assert.equal(check('scm', antes, scm('parcial', { ...me, itens: itens('atendido', 'atendido', 'atendido', 'atendido', 'pendente') }), almox), null);
  assert.match(check('scm', antes, scm('parcial', { ...me, itens: itens(null, null, null, null, null) }), almox), /ao menos um item/);
  assert.match(check('scm', antes, scm('parcial', { ...me, itens: itens('atendido', 'atendido', 'atendido', 'atendido', 'cancelado') }), almox), /RC aberta/);
  assert.match(check('scm', antes, scm('parcial', { itens: itens('atendido', 'pendente', 'pendente', 'pendente', 'pendente') }), almox), /processo no ME/);
  assert.match(check('scm', antes, scm('em_tratativa', { ...me, itens: itens('atendido', 'pendente', 'atendido', 'atendido', 'atendido') }), almox), /fora da RC/);
  const parcial = scm('parcial', { ...me, itens: itens('atendido', 'atendido', 'atendido', 'atendido', 'pendente') });
  assert.match(check('scm', parcial, { ...parcial, status: 'concluida' }, almox), /sem RC/);
  assert.equal(check('scm', parcial, { ...parcial, status: 'em_tratativa', itens: itens('atendido', 'atendido', 'atendido', 'atendido', 'atendido') }, almox), null, 'o quinto entrou: RC aberta');
  assert.equal(check('scm', parcial, { ...parcial, status: 'concluida', itens: itens('atendido', 'atendido', 'atendido', 'atendido', 'cancelado') }, almox), null, 'item que não vai ser comprado pode ser cancelado');
  assert.equal(check('scm', parcial, { ...parcial, itens: itens('atendido', 'atendido', 'atendido', 'atendido', 'pendente') }, almox), null);
  assert.match(check('scm', parcial, { ...parcial, itens: itens('atendido', 'atendido', 'x', 'atendido', 'pendente') }, almox), /inválida/);
  assert.match(check('scm', parcial, { ...parcial, itens: itens('atendido', 'pendente', 'pendente', 'pendente', 'pendente') }, lider), /não pode alterar|almoxarifado/);
  // SCM antiga, sem situação por item: abrir a RC direto continua valendo
  assert.equal(check('scm', scm('aprovada'), scm('em_tratativa', { numeroProcessoME: '1' }), almox), null);
});

test('SCM em revisão: o solicitante corrige o pedido, mas não o que é do almoxarifado', () => {
  const rev = scm('revisao_solicitada', { observacaoLider: 'ajustar quantidade', itens: [{ id: 'a', quantidade: 5 }] });
  assert.equal(check('scm', rev, { ...rev, status: 'pendente_aprovacao_lider', itens: [{ id: 'a', quantidade: 3 }, { id: 'b', quantidade: 1 }], centroCusto: 'Outro CC' }, tecnico), null);
  assert.equal(check('scm', rev, { ...rev, descricaoUso: 'nova descrição' }, tecnico), null, 'salvar sem reenviar');
  assert.match(check('scm', rev, { ...rev, numeroProcessoME: '999' }, tecnico), /almoxarifado/);
  assert.match(check('scm', rev, { ...rev, itens: [{ id: 'a', quantidade: 5, situacao: 'atendido' }] }, tecnico), /almoxarifado/);
  assert.match(check('scm', scm('aprovada'), scm('aprovada', { descricaoUso: 'mudou' }), tecnico), /não pode alterar/);
});

test('exclusão (checkExclusao): gestão sempre; solicitante só enquanto pode corrigir; líder não; registro inexistente não', () => {
  const { checkExclusao } = require('../src/routes/workflow');
  assert.equal(checkExclusao('scm', scm('aprovada'), almox), null);
  assert.equal(checkExclusao('scm', scm('revisao_solicitada'), tecnico), null);
  assert.match(checkExclusao('scm', scm('pendente_aprovacao_lider'), tecnico), /antes da aprovação/);
  assert.match(checkExclusao('scm', scm('revisao_solicitada'), lider), /antes da aprovação/, 'aprovador não exclui o pedido de outra pessoa');
  assert.equal(checkExclusao('sci', { solicitanteId: 't1', status: 'pendente' }, tecnico), null, 'SCI aberta (nome antigo "pendente")');
  assert.match(checkExclusao('sci', { solicitanteId: 't1', status: 'cadastrado' }, tecnico), /antes da aprovação/);
  assert.match(checkExclusao('scm', null, gestor), /inexistente ou já excluída/);
});
