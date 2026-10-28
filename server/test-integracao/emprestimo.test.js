'use strict';
// Empréstimo de ferramentas e material (migration 40) pela API e pelo banco de verdade, sob RLS. Dados fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirApp } = require('./_harness');

let h, U;
const API = '/api/emprestimo';
test.before(async () => {
  h = await subirApp({ adm: 'admin', ges: 'gestor', alm: 'almoxarife', tec: 'tecnico', term: 'terminal', term2: 'terminal' });
  U = h.users;
});
test.after(() => h?.fechar());

/** Mesma função do banco, pelo canal do terminal (como a API do tablet fará). */
function noTerminal(u, acao, p) {
  return h.transaction(u, async db => {
    await db.query("SELECT set_config('app.canal','terminal',true)");
    return (await db.query('SELECT emprestimo.executar($1,$2::jsonb) AS r', [acao, JSON.stringify(p)])).rows[0].r;
  });
}
function lerComo(u, canal, sql, params) {
  return h.transaction(u, async db => { await db.query("SELECT set_config('app.canal',$1,true)", [canal]); return (await db.query(sql, params)).rows; });
}
const saldo = async codigo => (await h.q(`SELECT s.* FROM emprestimo.ferramenta_saldo s JOIN emprestimo.ferramenta f ON f.id=s.ferramenta_id WHERE f.codigo=$1`, [codigo])).rows[0];
let chaveN = 0;
const chave = () => `teste-chave-${++chaveN}-${Date.now()}`;
const F = {};

test('cadastro: ferramenta por quantidade e por unidade; código único; só almoxarifado e gestão', async () => {
  let r = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'fer-0001', nome: 'Chave combinada 13 mm (teste)', categoria: 'Manual', controle: 'quantidade', total: 3, localizacao: 'Armário A' });
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.chave = r.j.id; assert.equal(r.j.codigo, 'FER-0001');
  r = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-0002', nome: 'Furadeira de impacto (teste)', categoria: 'Elétrica', controle: 'individual', unidades: ['PAT-T1', 'PAT-T2'] });
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.furadeira = r.j.id;
  assert.deepEqual(await saldo('FER-0002'), { ferramenta_id: F.furadeira, total: 2, disponivel: 2, emprestada: 0, em_conferencia: 0, manutencao: 0, baixada: 0 });
  assert.equal((await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-0001', nome: 'Outra', controle: 'quantidade', total: 1 })).s, 409, 'código repetido');
  assert.equal((await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'x', nome: 'Inválida', controle: 'quantidade', total: 1 })).s, 400);
  assert.equal((await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-0009', nome: 'Sem unidades', controle: 'individual', unidades: [] })).s, 400);
  for (const u of [U.tec, U.term]) {
    assert.equal((await h.api(u, 'GET', `${API}/ferramentas`)).s, 403);
    assert.equal((await h.api(u, 'POST', `${API}/ferramentas`, { codigo: 'FER-0010', nome: 'X', controle: 'quantidade', total: 1 })).s, 403);
  }
  r = await h.api(U.alm, 'GET', `${API}/ferramentas?q=furadeira`);
  assert.deepEqual(r.j.rows.map(x => x.codigo), ['FER-0002']);
  r = await h.api(U.alm, 'GET', `${API}/ferramentas?q=armario`);
  assert.deepEqual(r.j.rows.map(x => x.codigo), ['FER-0001'], 'busca sem acento pela localização');
  // material do catálogo (para o empréstimo de material do REG.0306)
  r = await h.api(U.alm, 'POST', '/api/almox/materiais/importar', { linhas: [{ codigo: 'MAN-E1', descricao: 'Cabo flexível 2,5 mm (teste)', unidade: 'M' }], campos: ['descricao', 'unidade'] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
});

test('colaboradores: vincula quem já existe, cria pessoa só do terminal, matrícula única', async () => {
  let r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa term', email: U.term.email, matricula: 'T1001', setor: 'Manutenção', centroCusto: 'CC-T1' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.usuarioId, U.term.id, 'mesma pessoa, sem duplicar');
  r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa term2', email: U.term2.email, matricula: 'T1002', setor: 'Utilidades', centroCusto: 'CC-T2' });
  assert.equal(r.s, 200);
  r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Nova Pessoa Teste', email: 'nova.pessoa@teste.biotrop', matricula: 'T1003', setor: 'Produção' });
  assert.equal(r.s, 200); assert.equal(r.j.perfil, 'terminal', 'quem não tinha conta nasce com o perfil mínimo');
  r = await h.api(U.ges, 'POST', `${API}/colaboradores`, { nome: 'Admin', email: U.adm.email, matricula: 'T1001' });
  assert.equal(r.s, 409, 'matrícula de outra pessoa');
  r = await h.api(U.ges, 'POST', `${API}/colaboradores`, { nome: 'Admin', email: U.adm.email, matricula: 't1002' });
  assert.equal(r.s, 409, 'a mesma matrícula com outra caixa também é de outra pessoa');
  // conta de administrador ou gestor: cadastro no terminal só pela gerência (o almoxarife não liga, desliga nem troca a matrícula)
  r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Admin', email: U.adm.email, matricula: 'A0001', setor: 'Gestão' });
  assert.deepEqual([r.s, r.j.erro], [403, 'Cadastro de administrador ou gestor no terminal só pela gerência.']);
  r = await h.api(U.ges, 'POST', `${API}/colaboradores`, { nome: 'Admin', email: U.adm.email, matricula: 'A0001', setor: 'Gestão' });
  assert.equal(r.s, 200); assert.equal(r.j.perfil, 'admin', 'vincular não muda o perfil');
  for (const corpo of [{ ativo: false }, { matricula: 'A0009' }, {}]) {
    r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Admin', email: U.adm.email, matricula: 'A0001', setor: 'Gestão', ...corpo });
    assert.equal(r.s, 403, `almoxarife editando o administrador: ${JSON.stringify(corpo)}`);
  }
  assert.deepEqual((await h.q('SELECT matricula, ativo FROM emprestimo.colaborador WHERE usuario_id=$1', [U.adm.id])).rows[0], { matricula: 'A0001', ativo: true }, 'nada mudou');
  assert.equal((await h.api(U.tec, 'POST', `${API}/colaboradores`, { nome: 'X Y Z', email: 'x@teste.biotrop', matricula: 'X0001' })).s, 403);
  r = await h.api(U.alm, 'GET', `${API}/colaboradores?q=t100`);
  assert.equal(r.j.rows.length, 3);
});

test('retirada pelo painel: saldo cai, número único, clique duplo não duplica e saldo insuficiente é recusado', async () => {
  const k = chave();
  const corpo = { colaboradorId: U.term.id, chave: k, finalidade: 'om', finalidadeRef: 'OM-123', itens: [{ ferramentaId: F.chave, quantidade: 2 }, { materialCodigo: 'man-e1', quantidade: '5.5' }] };
  let r = await h.api(U.alm, 'POST', `${API}/emprestimos`, corpo);
  assert.equal(r.s, 201, JSON.stringify(r.j)); assert.match(r.j.numero, /^EMP-\d{6}$/); F.emp1 = r.j.id;
  r = await h.api(U.alm, 'POST', `${API}/emprestimos`, corpo);
  assert.equal(r.s, 200); assert.equal(r.j.repetido, true); assert.equal(r.j.id, F.emp1);
  const s = await saldo('FER-0001'); assert.equal(s.disponivel, 1); assert.equal(s.emprestada, 2);
  const antes = (await h.q('SELECT count(*)::int n FROM emprestimo.emprestimo')).rows[0].n;
  r = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term2.id, chave: chave(), itens: [{ ferramentaId: F.chave, quantidade: 2 }] });
  assert.equal(r.s, 409); assert.match(r.j.erro, /Saldo insuficiente/);
  assert.equal((await h.q('SELECT count(*)::int n FROM emprestimo.emprestimo')).rows[0].n, antes, 'nada gravado da retirada recusada');
  r = await h.api(U.alm, 'GET', `${API}/emprestimos/${F.emp1}`);
  assert.equal(r.j.emprestimo.matricula, 'T1001'); assert.equal(r.j.emprestimo.centroCusto, 'CC-T1'); assert.equal(r.j.emprestimo.atendenteNome, 'Pessoa alm');
  assert.equal(r.j.emprestimo.origem, 'painel'); assert.equal(r.j.emprestimo.itensLista.length, 2);
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.tec.id, chave: chave(), itens: [{ ferramentaId: F.chave, quantidade: 1 }] })).s, 403, 'sem cadastro no terminal');
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term.id, chave: chave(), itens: [{ ferramentaId: F.chave, quantidade: 1 }, { ferramentaId: F.chave, quantidade: 1 }] })).s, 400, 'item repetido');
});

test('última unidade: duas retiradas ao mesmo tempo, só uma passa', async () => {
  const pedir = u => noTerminal(u, 'emprestar', { chave: chave(), itens: [{ ferramentaId: F.chave, quantidade: 1 }] }).then(() => 'ok', e => e.code || e.message);
  const r = await Promise.all([pedir(U.term), pedir(U.term2)]);
  assert.deepEqual(r.sort(), ['P0001', 'ok']);
  const s = await saldo('FER-0001'); assert.equal(s.disponivel, 0); assert.equal(s.emprestada, 3);
});

test('unidade individual: escolhe a unidade; a mesma não sai duas vezes', async () => {
  const unid = (await h.q("SELECT id, identificador FROM emprestimo.ferramenta_unidade WHERE ferramenta_id=$1 ORDER BY identificador", [F.furadeira])).rows;
  F.u1 = unid[0].id; F.u2 = unid[1].id;
  await assert.rejects(noTerminal(U.term, 'emprestar', { chave: chave(), itens: [{ ferramentaId: F.furadeira, quantidade: 1 }] }), e => e.code === '22023');
  const r = await noTerminal(U.term, 'emprestar', { chave: chave(), itens: [{ ferramentaId: F.furadeira, unidadeId: F.u1, quantidade: 1 }] });
  F.empU = r.id;
  await assert.rejects(noTerminal(U.term2, 'emprestar', { chave: chave(), itens: [{ ferramentaId: F.furadeira, unidadeId: F.u1, quantidade: 1 }] }), e => e.code === 'P0001');
  assert.equal((await h.q('SELECT estado FROM emprestimo.ferramenta_unidade WHERE id=$1', [F.u1])).rows[0].estado, 'emprestada');
});

test('no terminal todo mundo é só colaborador: só para si, sem gestão, e só vê o que é seu', async () => {
  // ferramenta própria do caso (o terminal só empresta ferramenta: material no canal terminal é recusado no banco)
  const nova = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-0098', nome: 'Trena do terminal (teste)', controle: 'quantidade', total: 3 });
  assert.equal(nova.s, 201, JSON.stringify(nova.j));
  const trena = [{ ferramentaId: nova.j.id, quantidade: 1 }];
  await assert.rejects(noTerminal(U.term, 'emprestar', { colaboradorId: U.term2.id, chave: chave(), itens: trena }), e => e.code === '42501');
  // administrador com cadastro no terminal: no tablet não confere, não estorna, não ajusta
  await assert.rejects(noTerminal(U.adm, 'conferir', { emprestimoId: F.emp1, itens: [] }), e => e.code === '42501');
  await assert.rejects(noTerminal(U.adm, 'estornar', { emprestimoId: F.emp1, justificativa: 'tentativa pelo tablet' }), e => e.code === '42501');
  await assert.rejects(noTerminal(U.adm, 'ferramenta_salvar', { codigo: 'FER-0099', nome: 'X', controle: 'quantidade', total: '1' }), e => e.code === '42501');
  await assert.rejects(noTerminal(U.adm, 'emprestar', { colaboradorId: U.term.id, chave: chave(), itens: trena }), e => e.code === '42501',
    'nem o admin registra para outra pessoa pelo tablet');
  const r = await noTerminal(U.adm, 'emprestar', { chave: chave(), itens: trena });
  const dono = (await h.q('SELECT colaborador_id, origem, atendente_id FROM emprestimo.emprestimo WHERE id=$1', [r.id])).rows[0];
  assert.deepEqual(dono, { colaborador_id: U.adm.id, origem: 'terminal', atendente_id: null });
  const vistos = await lerComo(U.adm, 'terminal', 'SELECT DISTINCT colaborador_id FROM emprestimo.emprestimo');
  assert.deepEqual(vistos.map(x => x.colaborador_id), [U.adm.id], 'RLS: no tablet o admin só vê os dele');
  assert.equal((await lerComo(U.adm, 'terminal', 'SELECT * FROM emprestimo.auditoria')).length, 0);
  const doTerm = await lerComo(U.term, 'painel', 'SELECT DISTINCT colaborador_id FROM emprestimo.emprestimo');
  assert.deepEqual(doTerm.map(x => x.colaborador_id), [U.term.id]);
  assert.equal((await lerComo(U.tec, 'painel', 'SELECT * FROM emprestimo.emprestimo')).length, 0, 'técnico sem cadastro não vê nada');
  assert.equal((await lerComo(U.tec, 'painel', 'SELECT * FROM emprestimo.ferramenta')).length, 0);
  await assert.rejects(noTerminal(U.tec, 'emprestar', { chave: chave(), itens: trena }), e => e.code === '42501', 'sem cadastro no terminal');
});

test('devolução parcial, conferência, avaria e baixa do material (fluxo do REG.0306)', async () => {
  const det = async () => (await h.api(U.alm, 'GET', `${API}/emprestimos/${F.emp1}`)).j.emprestimo;
  let d = await det();
  const ferr = d.itensLista.find(i => i.tipo === 'ferramenta'), mat = d.itensLista.find(i => i.tipo === 'material');
  await assert.rejects(noTerminal(U.term2, 'devolver', { emprestimoId: F.emp1, itens: [{ itemId: ferr.id, quantidade: '1' }] }), e => e.code === '42501', 'empréstimo de outra pessoa');
  await assert.rejects(noTerminal(U.term, 'devolver', { emprestimoId: F.emp1, itens: [{ itemId: ferr.id, quantidade: '3' }] }), e => e.code === 'P0001', 'mais que o pendente');
  await assert.rejects(noTerminal(U.term, 'devolver', { emprestimoId: F.emp1, itens: [{ itemId: ferr.id, quantidade: '0.5' }] }), e => e.code === '22023', 'ferramenta em unidade inteira');
  let r = await noTerminal(U.term, 'devolver', { emprestimoId: F.emp1, itens: [{ itemId: ferr.id, quantidade: '1', condicao: 'boa' }] });
  assert.equal(r.status, 'aguardando_conferencia');
  assert.equal((await saldo('FER-0001')).em_conferencia, 1);
  await assert.rejects(noTerminal(U.term, 'conferir', { emprestimoId: F.emp1, itens: [{ itemId: ferr.id, quantidade: '1', resultado: 'boa' }] }), e => e.code === '42501', 'quem devolve não confere');
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/conferencias`, { itens: [{ itemId: ferr.id, quantidade: 1, resultado: 'boa' }] });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, 'parcialmente_devolvido');
  let s = await saldo('FER-0001'); assert.equal(s.disponivel, 1); assert.equal(s.em_conferencia, 0);
  // a outra volta avariada: sem explicação a conferência recusa; com explicação vai para manutenção
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/devolucoes`, { itens: [{ itemId: ferr.id, quantidade: 1, condicao: 'avaria' }] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/conferencias`, { itens: [{ itemId: ferr.id, quantidade: 1, resultado: 'avaria' }] })).s, 400);
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/conferencias`, { itens: [{ itemId: ferr.id, quantidade: 1, resultado: 'avaria', observacao: 'Boca da chave espanada' }] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  s = await saldo('FER-0001'); assert.equal(s.manutencao, 1); assert.equal(s.total, 3);
  // material: volta 2,5 (conferido) e o resto (3) é consumo, com o nº da baixa no Dynamics
  // (as mensagens mostram a quantidade no formato do Brasil: "5,5", nunca "5.500" nem "1.000")
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/devolucoes`, { itens: [{ itemId: mat.id, quantidade: '9' }] });
  assert.deepEqual([r.s, r.j.erro], [409, 'A quantidade devolvida de Cabo flexível 2,5 mm (teste) passa do que está pendente (5,5).']);
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/devolucoes`, { itens: [{ itemId: mat.id, quantidade: '2.5' }] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/conferencias`, { itens: [{ itemId: mat.id, quantidade: 3, resultado: 'boa' }] });
  assert.deepEqual([r.s, r.j.erro], [409, 'Só há 2,5 de Cabo flexível 2,5 mm (teste) aguardando conferência.']);
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/conferencias`, { itens: [{ itemId: mat.id, quantidade: 2.5, resultado: 'boa' }] })).s, 200);
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/baixas`, { itemId: mat.id, quantidade: 3, motivo: 'consumo', justificativa: 'ok' })).s, 400, 'baixa sem explicação');
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/baixas`, { itemId: mat.id, quantidade: 4, motivo: 'consumo', justificativa: 'Usado na OM-123' });
  assert.deepEqual([r.s, r.j.erro], [409, 'A baixa passa do que está pendente (3).'], 'baixa maior que o pendente');
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/baixas`, { itemId: mat.id, quantidade: 3, motivo: 'consumo', justificativa: 'Usado na OM-123', numeroBaixa: 'BX-778' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, 'encerrado');
  d = await det();
  const m2 = d.itensLista.find(i => i.tipo === 'material');
  assert.deepEqual([m2.quantidade, m2.devolvida, m2.baixa, m2.pendente, m2.numeroBaixa], [5.5, 2.5, 3, 0, 'BX-778'], 'QTD, QTD DEVOLUÇÃO e QTD P/ BAIXA do REG.0306');
  assert.deepEqual(d.eventos.map(v => v.tipo), ['retirada', 'retirada', 'devolucao', 'conferencia', 'devolucao', 'avaria', 'devolucao', 'conferencia', 'consumo']);
  assert.ok(d.eventos.every(v => v.por && v.em), 'cada evento tem autor e hora');
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${F.emp1}/devolucoes`, { itens: [{ itemId: ferr.id, quantidade: 1 }] })).s, 409, 'fechado não reabre');
});

test('extravio de unidade individual e estorno só pela gerência', async () => {
  const d = (await h.api(U.alm, 'GET', `${API}/emprestimos/${F.empU}`)).j.emprestimo;
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${F.empU}/baixas`, { itemId: d.itensLista[0].id, quantidade: 1, motivo: 'consumo', justificativa: 'Não é material' })).s, 400);
  let r = await h.api(U.alm, 'POST', `${API}/emprestimos/${F.empU}/baixas`, { itemId: d.itensLista[0].id, quantidade: 1, motivo: 'extravio', justificativa: 'Perdida na área 3' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, 'encerrado');
  assert.equal((await h.q('SELECT estado FROM emprestimo.ferramenta_unidade WHERE id=$1', [F.u1])).rows[0].estado, 'baixada');
  assert.equal((await saldo('FER-0002')).baixada, 1);
  // estorno: almoxarife não; gestor sim, e só sem devolução
  r = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term2.id, chave: chave(), itens: [{ ferramentaId: F.furadeira, unidadeId: F.u2, quantidade: 1 }] });
  assert.equal(r.s, 201); const emp = r.j.id;
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/estorno`, { justificativa: 'Lançado errado' })).s, 403);
  assert.equal((await h.api(U.ges, 'POST', `${API}/emprestimos/${emp}/estorno`, { justificativa: 'x' })).s, 400);
  r = await h.api(U.ges, 'POST', `${API}/emprestimos/${emp}/estorno`, { justificativa: 'Lançado para a pessoa errada' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, 'estornado');
  assert.equal((await h.q('SELECT estado FROM emprestimo.ferramenta_unidade WHERE id=$1', [F.u2])).rows[0].estado, 'disponivel');
  // estornado não deixa nada pendente (o estorno não mexe nas quantidades do item): ficha, lista e o tablet dizem 0
  const est = (await h.api(U.alm, 'GET', `${API}/emprestimos/${emp}`)).j.emprestimo;
  assert.deepEqual([est.status, est.pendente, est.atrasado, est.itensLista.map(i => [i.quantidade, i.pendente])], ['estornado', 0, false, [[1, 0]]]);
  const linha = (await h.api(U.alm, 'GET', `${API}/emprestimos?status=estornado`)).j.rows.find(x => x.id === emp);
  assert.equal(linha.pendente, 0);
  assert.equal((await h.api(U.ges, 'POST', `${API}/emprestimos/${F.emp1}/estorno`, { justificativa: 'Tentativa depois da devolução' })).s, 409);
});

test('ajuste de saldo auditado, nunca negativo; configuração só da gerência', async () => {
  assert.equal((await h.api(U.alm, 'POST', `${API}/ferramentas/${F.chave}/ajustes`, { movimento: 'entrada', quantidade: 2, justificativa: 'Compra nova' })).s, 403);
  let r = await h.api(U.ges, 'POST', `${API}/ferramentas/${F.chave}/ajustes`, { movimento: 'de_manutencao', quantidade: 1, justificativa: 'Voltou do conserto' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(U.ges, 'POST', `${API}/ferramentas/${F.chave}/ajustes`, { movimento: 'para_manutencao', quantidade: 9, justificativa: 'Mais do que existe' });
  assert.equal(r.s, 400, 'saldo negativo é recusado pelo banco');
  r = await h.api(U.ges, 'POST', `${API}/ferramentas/${F.chave}/ajustes`, { movimento: 'entrada', quantidade: 2, justificativa: 'Compra nova' });
  assert.equal(r.s, 200);
  const s = await saldo('FER-0001');
  assert.equal(s.total, s.disponivel + s.emprestada + s.em_conferencia + s.manutencao + s.baixada); assert.equal(s.total, 5);
  r = await h.api(U.alm, 'GET', `${API}/ferramentas/${F.chave}`);
  assert.ok(r.j.ferramenta.historico.some(x => x.tipo === 'saldo_ajustado' && x.por === 'Pessoa ges'));
  assert.ok(r.j.ferramenta.historico.some(x => x.tipo === 'avaria' && x.colaborador === 'Pessoa term'), 'histórico por ferramenta inclui os empréstimos');
  assert.equal((await h.api(U.alm, 'PUT', `${API}/config`, { prazoPadraoHoras: 48 })).s, 403);
  assert.equal((await h.api(U.ges, 'PUT', `${API}/config`, { prazoPadraoHoras: 99999 })).s, 400);
  r = await h.api(U.ges, 'PUT', `${API}/config`, { prazoPadraoHoras: 48, inatividadeSegundos: 60 });
  assert.equal(r.s, 200); assert.equal(r.j.config.prazo_padrao_horas, 48);
});

test('atrasos, novo prazo com justificativa e filtros da lista', async () => {
  const r0 = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term2.id, chave: chave(), itens: [{ materialCodigo: 'MAN-E1', quantidade: 1 }] });
  await h.q("UPDATE emprestimo.emprestimo SET prazo = now() - interval '2 days' WHERE id=$1", [r0.j.id]);
  let r = await h.api(U.alm, 'GET', `${API}/emprestimos?atrasados=1`);
  assert.ok(r.j.rows.some(x => x.id === r0.j.id && x.atrasado && x.colaboradorNome === 'Pessoa term2'));
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${r0.j.id}/prazo`, { prazo: new Date(Date.now() + 864e5).toISOString(), justificativa: '' })).s, 400);
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${r0.j.id}/prazo`, { prazo: new Date(Date.now() + 864e5).toISOString(), justificativa: 'Serviço estendido' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(U.alm, 'GET', `${API}/emprestimos?atrasados=1`);
  assert.ok(!r.j.rows.some(x => x.id === r0.j.id));
  r = await h.api(U.alm, 'GET', `${API}/emprestimos?centroCusto=CC-T1&status=encerrado`);
  assert.ok(r.j.rows.length >= 1 && r.j.rows.every(x => x.centroCusto === 'CC-T1' && x.status === 'encerrado'));
  r = await h.api(U.alm, 'GET', `${API}/emprestimos?q=cabo`);
  assert.ok(r.j.rows.length >= 1);
});

test('rodada 2: segunda baixa sem número mantém o nº do Dynamics; histórico do prazo na hora de Brasília; e-mail acima de 254 recusado', async () => {
  const r0 = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term2.id, chave: chave(), itens: [{ materialCodigo: 'MAN-E1', quantidade: 2 }] });
  assert.equal(r0.s, 201, JSON.stringify(r0.j));
  const item = (await h.api(U.alm, 'GET', `${API}/emprestimos/${r0.j.id}`)).j.emprestimo.itensLista[0];
  // prazo antigo 12:45 UTC = 09:45 em Brasília; o evento imutável deve trazer a hora que a tela mostrava
  await h.q("UPDATE emprestimo.emprestimo SET prazo = '2026-10-18T12:45:00Z' WHERE id=$1", [r0.j.id]);
  let r = await h.api(U.alm, 'POST', `${API}/emprestimos/${r0.j.id}/prazo`, { prazo: new Date(Date.now() + 864e5).toISOString(), justificativa: 'Prazo teste' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const ev = (await h.api(U.alm, 'GET', `${API}/emprestimos/${r0.j.id}`)).j.emprestimo.eventos.find(v => v.tipo === 'prazo');
  assert.match(ev.justificativa, /\(de 18\/10\/2026 09:45\)$/, 'prazo antigo na hora de Brasília');
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${r0.j.id}/baixas`, { itemId: item.id, quantidade: 1, motivo: 'consumo', justificativa: 'Baixa teste 1', numeroBaixa: 'BX-DYN-100' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${r0.j.id}/baixas`, { itemId: item.id, quantidade: 1, motivo: 'consumo', justificativa: 'Baixa teste 2', numeroBaixa: '' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const it2 = (await h.api(U.alm, 'GET', `${API}/emprestimos/${r0.j.id}`)).j.emprestimo.itensLista[0];
  assert.deepEqual([it2.baixa, it2.numeroBaixa], [2, 'BX-DYN-100'], 'a segunda baixa, sem número, não apaga o nº já registrado');
  const longo = 'a'.repeat(250) + '@teste.biotrop';
  r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa Email Longo', email: longo, matricula: 'T9254' });
  assert.equal(r.s, 400, JSON.stringify(r.j));
  assert.equal((await h.q('SELECT count(*)::int AS n FROM core.usuario WHERE email = $1', [longo])).rows[0].n, 0, 'nenhum usuário criado');
});

test('filtro por ferramenta (Relatórios): ferramenta=<id> traz só o empréstimo da ferramenta exata, não a de código parecido', async () => {
  // o q é busca por trecho: FER-7001 também acha FER-7001-B e FER-70011; o id da ferramenta não
  const ids = {};
  for (const codigo of ['FER-7001', 'FER-7001-B', 'FER-70011']) {
    const r = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo, nome: `Trena ${codigo} (teste)`, controle: 'quantidade', total: 2 });
    assert.equal(r.s, 201, JSON.stringify(r.j)); ids[codigo] = r.j.id;
  }
  const emp = {};
  for (const codigo of Object.keys(ids)) {
    const r = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term2.id, chave: chave(), itens: [{ ferramentaId: ids[codigo], quantidade: 1 }] });
    assert.equal(r.s, 201, JSON.stringify(r.j)); emp[codigo] = r.j.id;
  }
  const lista = async qs => (await h.api(U.alm, 'GET', `${API}/emprestimos?${qs}`)).j.rows.map(x => x.id).sort();
  assert.deepEqual(await lista('q=FER-7001'), Object.values(emp).sort(), 'por trecho: os três');
  assert.deepEqual(await lista(`ferramenta=${ids['FER-7001']}&q=FER-7001`), [emp['FER-7001']], 'como a tela manda: só a exata');
  assert.deepEqual(await lista(`ferramenta=${ids['FER-7001-B']}`), [emp['FER-7001-B']]);
  assert.equal((await h.api(U.alm, 'GET', `${API}/emprestimos?ferramenta=nao-e-uuid`)).s, 400);
  for (const codigo of Object.keys(emp)) await h.api(U.ges, 'POST', `${API}/emprestimos/${emp[codigo]}/estorno`, { justificativa: 'Fim do teste do filtro' });
});

test('reenvio com a mesma chave de operação: ajuste, baixa e conferência não se aplicam duas vezes (resposta perdida, clique de novo)', async () => {
  let r = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-0201', nome: 'Torquímetro de reenvio (teste)', controle: 'quantidade', total: 3 });
  assert.equal(r.s, 201, JSON.stringify(r.j)); const fer = r.j.id;
  const ajuste = { movimento: 'entrada', quantidade: 5, justificativa: 'Compra de reposição', chave: chave() };
  r = await h.api(U.ges, 'POST', `${API}/ferramentas/${fer}/ajustes`, ajuste);
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.repetido, undefined);
  r = await h.api(U.ges, 'POST', `${API}/ferramentas/${fer}/ajustes`, ajuste);
  assert.deepEqual([r.s, r.j.repetido], [200, true]);
  assert.equal((await saldo('FER-0201')).total, 8, 'entraram 5, não 10');
  assert.equal((await h.api(U.ges, 'POST', `${API}/ferramentas/${fer}/ajustes`, { ...ajuste, chave: 'curta' })).s, 400, 'chave fora do formato');
  // empréstimo de 3: baixa parcial e conferência parcial (o mesmo item dividido em duas linhas) reenviadas
  r = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term.id, chave: chave(), itens: [{ ferramentaId: fer, quantidade: 3 }] });
  assert.equal(r.s, 201, JSON.stringify(r.j)); const emp = r.j.id;
  const item = (await h.api(U.alm, 'GET', `${API}/emprestimos/${emp}`)).j.emprestimo.itensLista[0].id;
  const bx = { itemId: item, quantidade: 1, motivo: 'extravio', justificativa: 'Perdida na área 7', chave: chave() };
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/baixas`, bx);
  assert.deepEqual([r.s, r.j.repetido], [200, undefined], JSON.stringify(r.j));
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/baixas`, bx);
  assert.deepEqual([r.s, r.j.repetido], [200, true]);
  assert.equal((await saldo('FER-0201')).baixada, 1, 'uma baixa só');
  assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/devolucoes`, { itens: [{ itemId: item, quantidade: 2 }] })).s, 200);
  const cf = { itens: [{ itemId: item, quantidade: 1, resultado: 'boa' }, { itemId: item, quantidade: 1, resultado: 'avaria', observacao: 'Escala apagada' }], chave: chave() };
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/conferencias`, cf);
  assert.deepEqual([r.s, r.j.status], [200, 'encerrado'], JSON.stringify(r.j));
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/conferencias`, cf);
  assert.deepEqual([r.s, r.j.repetido, r.j.status], [200, true, 'encerrado']);
  const s = await saldo('FER-0201');
  assert.deepEqual([s.total, s.disponivel, s.emprestada, s.em_conferencia, s.manutencao, s.baixada], [8, 6, 0, 0, 1, 1], 'cada movimento uma vez');
  // a chave de uma operação não serve para outra
  r = await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/devolucoes`, { itens: [{ itemId: item, quantidade: 1 }], chave: bx.chave });
  assert.deepEqual([r.s, r.j.erro], [400, 'Chave de operação já usada em outra operação.']);
  const eventos = (await h.q('SELECT tipo, chave FROM emprestimo.emprestimo_evento WHERE emprestimo_id=$1 AND chave IS NOT NULL ORDER BY em, id', [emp])).rows;
  assert.deepEqual(eventos, [{ tipo: 'extravio', chave: bx.chave }, { tipo: 'conferencia', chave: cf.chave }], 'a chave fica no evento (uma vez por operação)');
});

test('período (de/até) pelo dia de Brasília, não pelo fuso da sessão do banco: a retirada das 22:30 de 15/10 é do dia 15', async () => {
  const tz = Object.values((await h.q('SHOW TimeZone')).rows[0])[0];
  assert.notEqual(tz, 'America/Sao_Paulo', 'o banco do teste está em outro fuso (como o Azure, em UTC): o teste vale');
  const novo = async quando => {
    const r = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term2.id, chave: chave(), itens: [{ materialCodigo: 'MAN-E1', quantidade: 1 }] });
    await h.q('UPDATE emprestimo.emprestimo SET criado_em = $2::timestamptz WHERE id=$1', [r.j.id, quando]);
    return r.j.id;
  };
  const noite = await novo('2026-10-15 22:30:00-03'), madrugada = await novo('2026-10-16 00:30:00-03'), cedo = await novo('2026-10-15 00:10:00-03');
  const ids = async (de, ate) => (await h.api(U.alm, 'GET', `${API}/emprestimos?de=${de}&ate=${ate}`)).j.rows.map(x => x.id).filter(x => [noite, madrugada, cedo].includes(x)).sort();
  assert.deepEqual(await ids('2026-10-15', '2026-10-15'), [noite, cedo].sort());
  assert.deepEqual(await ids('2026-10-16', '2026-10-16'), [madrugada]);
  assert.deepEqual(await ids('2026-10-14', '2026-10-14'), []);
  assert.deepEqual(await ids('2026-10-15', '2026-10-16'), [noite, madrugada, cedo].sort());
});

test('lista de empréstimos: abertos primeiro (prazo mais próximo), fechados do mais novo para o mais antigo; limite e página trazem tudo sem repetir', async () => {
  const ABERTO = ['em_andamento', 'parcialmente_devolvido', 'aguardando_conferencia'];
  const todos = (await h.api(U.alm, 'GET', `${API}/emprestimos?limite=500`)).j.rows;
  const abertos = todos.filter(x => ABERTO.includes(x.status)), fechados = todos.filter(x => !ABERTO.includes(x.status));
  assert.ok(abertos.length >= 2 && fechados.length >= 2, `${abertos.length} abertos, ${fechados.length} fechados`);
  assert.deepEqual(todos.map(x => x.id), [...abertos, ...fechados].map(x => x.id), 'abertos antes dos fechados');
  for (let i = 1; i < abertos.length; i += 1) assert.ok(new Date(abertos[i - 1].prazo) <= new Date(abertos[i].prazo), 'abertos pelo prazo');
  for (let i = 1; i < fechados.length; i += 1) assert.ok(new Date(fechados[i - 1].criadoEm) >= new Date(fechados[i].criadoEm), 'fechados do mais novo para o mais antigo');
  const paginas = [];
  for (let p = 1; p < 50; p += 1) {
    const rows = (await h.api(U.alm, 'GET', `${API}/emprestimos?limite=2&pagina=${p}`)).j.rows;
    paginas.push(...rows.map(x => x.id));
    if (rows.length < 2) break;
  }
  assert.deepEqual(paginas, todos.map(x => x.id), 'página a página dá a mesma lista');
  assert.equal((await h.api(U.alm, 'GET', `${API}/emprestimos?limite=1`)).j.rows.length, 1);
  assert.equal((await h.api(U.alm, 'GET', `${API}/emprestimos?limite=abc&pagina=-3`)).j.rows.length, Math.min(todos.length, 200), 'valores ruins viram o padrão');
});

test('retirada, devolução e conferência movem o saldo das ferramentas na mesma ordem (id da ferramenta): duas operações simultâneas não se travam', async () => {
  // gatilho só neste banco de teste: anota a ordem em que cada operação atualiza (e trava) o saldo
  await h.db.exec(`CREATE TABLE public.teste_ordem_saldo (n serial PRIMARY KEY, ferramenta uuid);
    CREATE FUNCTION public.teste_ordem_saldo_reg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO public.teste_ordem_saldo (ferramenta) VALUES (NEW.ferramenta_id); RETURN NEW; END $$;
    CREATE TRIGGER teste_ordem_saldo AFTER UPDATE ON emprestimo.ferramenta_saldo FOR EACH ROW EXECUTE FUNCTION public.teste_ordem_saldo_reg();`);
  const ordem = async () => { const r = (await h.q('SELECT ferramenta FROM public.teste_ordem_saldo ORDER BY n')).rows.map(x => x.ferramenta); await h.q('TRUNCATE public.teste_ordem_saldo'); return r; };
  try {
    const ids = [];
    for (const c of ['FER-0301', 'FER-0302']) ids.push((await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: c, nome: `Ordem ${c} (teste)`, controle: 'quantidade', total: 60 })).j.id);
    const crescente = [...ids].sort();
    // um empréstimo cujos itens, pelo id do item, vêm na ordem contrária à das ferramentas (o caso do impasse)
    let emp = null, itens = null;
    for (let i = 0; i < 40 && !emp; i += 1) {
      const r = await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term.id, chave: chave(), itens: [{ ferramentaId: crescente[1], quantidade: 1 }, { ferramentaId: crescente[0], quantidade: 1 }] });
      assert.equal(r.s, 201, JSON.stringify(r.j));
      const its = (await h.q('SELECT id::text, ferramenta_id FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1 ORDER BY id::text', [r.j.id])).rows;
      if (its[0].ferramenta_id === crescente[1]) { emp = r.j.id; itens = its; }
    }
    assert.ok(emp, 'achou o caso em que a ordem dos itens é a contrária');
    await ordem();
    await h.api(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.term2.id, chave: chave(), itens: [{ ferramentaId: crescente[1], quantidade: 1 }, { ferramentaId: crescente[0], quantidade: 1 }] });
    assert.deepEqual(await ordem(), crescente, 'retirada');
    assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/devolucoes`, { itens: itens.map(i => ({ itemId: i.id, quantidade: 1 })) })).s, 200);
    assert.deepEqual(await ordem(), crescente, 'devolução');
    assert.equal((await h.api(U.alm, 'POST', `${API}/emprestimos/${emp}/conferencias`, { itens: itens.map(i => ({ itemId: i.id, quantidade: 1, resultado: 'boa' })) })).s, 200);
    assert.deepEqual(await ordem(), crescente, 'conferência');
  } finally {
    await h.db.exec('DROP TRIGGER IF EXISTS teste_ordem_saldo ON emprestimo.ferramenta_saldo; DROP FUNCTION IF EXISTS public.teste_ordem_saldo_reg(); DROP TABLE IF EXISTS public.teste_ordem_saldo;');
  }
});

test('histórico imutável e empréstimo não se apaga (nem pelo dono do banco)', async () => {
  await assert.rejects(h.q('DELETE FROM emprestimo.emprestimo_evento'), /histórico não pode/);
  await assert.rejects(h.q("UPDATE emprestimo.auditoria SET tipo='x'"), /histórico não pode/);
  await assert.rejects(h.q('DELETE FROM emprestimo.emprestimo'), /não são apagados/);
  await assert.rejects(h.transaction(U.adm, db => db.query("UPDATE emprestimo.emprestimo SET status='devolvido'")), e => e.code === '42501', 'a API não tem DML direto');
});

test('perfil terminal não enxerga nada do site principal', async () => {
  assert.deepEqual((await h.api(U.term, 'GET', '/api/data/utility_meters')).j?.rows || [], []);
  assert.deepEqual((await h.api(U.term, 'GET', '/api/data/sci')).j?.rows || [], []);
  assert.equal((await h.api(U.term, 'GET', '/api/almox/materiais')).s, 403);
  const camp = await h.api(U.term, 'GET', '/api/inventario/campanhas');
  assert.deepEqual(camp.j?.campanhas || [], [], 'rota aberta a quem está logado, mas o RLS não devolve nada');
  assert.equal((await h.api(U.term, 'GET', '/api/inventario/usuarios')).s, 403);
  assert.equal((await h.api(U.term, 'GET', `${API}/emprestimos`)).s, 403);
});

test('reaplicar a migration (como o deploy faz) não perde nada', async () => {
  const antes = (await h.q('SELECT (SELECT count(*) FROM emprestimo.emprestimo)::int e, (SELECT count(*) FROM emprestimo.emprestimo_evento)::int v, (SELECT count(*) FROM emprestimo.colaborador)::int c')).rows[0];
  await h.db.exec(fs.readFileSync(path.resolve(__dirname, '../../database/migrations/40-emprestimo.sql'), 'utf8'));
  const depois = (await h.q('SELECT (SELECT count(*) FROM emprestimo.emprestimo)::int e, (SELECT count(*) FROM emprestimo.emprestimo_evento)::int v, (SELECT count(*) FROM emprestimo.colaborador)::int c')).rows[0];
  assert.deepEqual(depois, antes);
  assert.equal((await h.q('SELECT prazo_padrao_horas FROM emprestimo.config')).rows[0].prazo_padrao_horas, 48, 'configuração mantida');
});
