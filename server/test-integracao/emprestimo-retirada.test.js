'use strict';
// Empréstimo (EM) × retirada (RM) e importação da planilha (migration 44) no banco de verdade, sob RLS: as travas do
// banco e das rotas que o demo (apps/web/src/terminal/demo.ts) não tem como provar:
// canal do terminal (até admin) sem gestão, perfis sem permissão, transação da importação, CHECKs, avisos e reaplicação.
// Dados fictícios: FMNT-R00x, unidades PAT-R0x.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirApp } = require('./_harness');

let h, U;
const API = '/api/emprestimo';
test.before(async () => {
  h = await subirApp({ adm: 'admin', ges: 'gestor', alm: 'almoxarife', tec: 'tecnico', term: 'terminal' });
  U = h.users;
});
test.after(() => h?.fechar());

function noTerminal(u, acao, p) {
  return h.transaction(u, async db => {
    await db.query("SELECT set_config('app.canal','terminal',true)");
    return (await db.query('SELECT emprestimo.executar($1,$2::jsonb) AS r', [acao, JSON.stringify(p)])).rows[0].r;
  });
}
function noPainel(u, acao, p) {
  return h.transaction(u, async db => {
    await db.query("SELECT set_config('app.canal','painel',true)");
    return (await db.query('SELECT emprestimo.executar($1,$2::jsonb) AS r', [acao, JSON.stringify(p)])).rows[0].r;
  });
}
let n = 0;
const chave = () => `retirada-teste-${++n}-${Date.now()}`;
const saldo = async codigo => (await h.q(`SELECT s.total, s.disponivel, s.emprestada, s.baixada FROM emprestimo.ferramenta_saldo s
  JOIN emprestimo.ferramenta f ON f.id = s.ferramenta_id WHERE f.codigo = $1`, [codigo])).rows[0];
const F = {};

test('preparo: colaborador do terminal e ferramentas importadas (uma retirável, uma individual retirável)', async () => {
  let r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa Terminal Retirada', email: U.term.email, matricula: 'R90001' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(U.alm, 'POST', `${API}/ferramentas/importar`, { linhas: [
    { codigo: 'FMNT-R001', nome: 'Disco de corte (teste)', retiravel: true, localizacao: 'Armário R CAMM 1' },
    { codigo: 'FMNT-R002', nome: 'Chave de teste só emprestada' }] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.criadas, r.j.ignoradas], [2, []]);
  r = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FMNT-R003', nome: 'Medidor individual (teste)', controle: 'individual', unidades: ['PAT-R01'], retiravel: true, codigoCompra: 'CC-R3', patrimonio: 'PAT-R01' });
  assert.equal(r.s, 201, JSON.stringify(r.j));
  for (const f of (await h.q("SELECT id, codigo FROM emprestimo.ferramenta WHERE codigo LIKE 'FMNT-R%'")).rows) F[f.codigo] = f.id;
  F.unidade = (await h.q('SELECT id FROM emprestimo.ferramenta_unidade WHERE ferramenta_id = $1', [F['FMNT-R003']])).rows[0].id;
  // cada linha importada é uma peça: quantidade, total 1, auditada com o número da linha; o lote também
  assert.deepEqual(await saldo('FMNT-R001'), { total: 1, disponivel: 1, emprestada: 0, baixada: 0 });
  const aud = (await h.q("SELECT tipo, detalhe FROM emprestimo.auditoria WHERE tipo IN ('ferramenta_importada','ferramentas_importadas') ORDER BY em, tipo")).rows;
  assert.deepEqual(aud.map(a => [a.tipo, a.detalhe.linha ?? a.detalhe.criadas]), [['ferramenta_importada', 1], ['ferramenta_importada', 2], ['ferramentas_importadas', 2]]);
});

test('permissões: técnico e perfil terminal recebem 403 na importação e na confirmação; no canal do terminal nem o admin confirma ou importa', async () => {
  const rm = await noTerminal(U.term, 'emprestar', { modalidade: 'retirada', chave: chave(), itens: [{ ferramentaId: F['FMNT-R001'], quantidade: '1' }] });
  F.rm = rm.id;
  for (const u of [U.tec, U.term]) {
    assert.equal((await h.api(u, 'POST', `${API}/ferramentas/importar`, { linhas: [{ codigo: 'FMNT-R099', nome: 'x' }] })).s, 403, `${u.perfil}: importar`);
    assert.equal((await h.api(u, 'POST', `${API}/emprestimos/${F.rm}/retirada`, { acao: 'confirmar' })).s, 403, `${u.perfil}: confirmar`);
    assert.equal((await h.api(u, 'POST', `${API}/emprestimos/${F.rm}/retirada`, { acao: 'recusar', justificativa: 'Sem permissão.' })).s, 403, `${u.perfil}: recusar`);
  }
  for (const acao of ['retirada_confirmar', 'retirada_recusar']) {
    await assert.rejects(noTerminal(U.adm, acao, { emprestimoId: F.rm, justificativa: 'Pelo tablet não.' }), e => e.code === '42501', `${acao} no canal terminal`);
    await assert.rejects(noTerminal(U.term, acao, { emprestimoId: F.rm, justificativa: 'Pelo tablet não.' }), e => e.code === '42501');
  }
  await assert.rejects(noTerminal(U.adm, 'ferramentas_importar', { linhas: [{ codigo: 'FMNT-R098', nome: 'x' }] }), e => e.code === '42501');
  await assert.rejects(noPainel(U.term, 'retirada_confirmar', { emprestimoId: F.rm }), e => e.code === '42501', 'perfil terminal no painel');
  assert.equal((await h.q("SELECT count(*)::int AS n FROM emprestimo.ferramenta WHERE codigo IN ('FMNT-R098','FMNT-R099')")).rows[0].n, 0);
  assert.equal((await h.q('SELECT status FROM emprestimo.emprestimo WHERE id = $1', [F.rm])).rows[0].status, 'aguardando_baixa');
});

test('banco: retirada sem prazo, status só da retirada (CHECK), não atrasa nem gera aviso, unidade baixada ao confirmar', async () => {
  const e = (await h.q('SELECT modalidade, status, prazo FROM emprestimo.emprestimo WHERE id = $1', [F.rm])).rows[0];
  assert.deepEqual(e, { modalidade: 'retirada', status: 'aguardando_baixa', prazo: null });
  // a role da API não grava direto; as CHECKs valem até para o dono do banco
  await assert.rejects(h.transaction(null, async db => { await db.query('SET LOCAL ROLE NONE'); await db.query("UPDATE emprestimo.emprestimo SET prazo = now() + interval '1 day' WHERE id = $1", [F.rm]); }), e2 => e2.code === '23514');
  await assert.rejects(h.transaction(null, async db => { await db.query('SET LOCAL ROLE NONE'); await db.query("UPDATE emprestimo.emprestimo SET status = 'em_andamento' WHERE id = $1", [F.rm]); }), e2 => e2.code === '23514');
  // avisos: a rotina do worker 30 dias depois não pega a retirada
  await h.transaction(null, async db => { await db.query('SET LOCAL ROLE NONE'); await db.query("SELECT emprestimo.enfileirar_avisos_em(now() + interval '30 days')"); });
  assert.equal((await h.q('SELECT count(*)::int AS n FROM emprestimo.aviso WHERE emprestimo_id = $1', [F.rm])).rows[0].n, 0);
  // material e ferramenta não retirável recusados; unidade individual retirável: confirmar deixa a unidade baixada
  await assert.rejects(noPainel(U.alm, 'emprestar', { modalidade: 'retirada', colaboradorId: U.term.id, chave: chave(), itens: [{ ferramentaId: F['FMNT-R002'], quantidade: '1' }] }),
    e2 => e2.code === '22023' && /não pode ser retirada, só emprestada/.test(e2.message));
  const r2 = await noPainel(U.alm, 'emprestar', { modalidade: 'retirada', colaboradorId: U.term.id, chave: chave(), itens: [{ ferramentaId: F['FMNT-R003'], unidadeId: F.unidade, quantidade: '1' }] });
  const c = await h.api(U.alm, 'POST', `${API}/emprestimos/${r2.id}/retirada`, { acao: 'confirmar', numeroBaixa: 'BX-R-01' });
  assert.equal(c.s, 200, JSON.stringify(c.j)); assert.equal(c.j.status, 'encerrado');
  assert.equal((await h.q('SELECT estado FROM emprestimo.ferramenta_unidade WHERE id = $1', [F.unidade])).rows[0].estado, 'baixada');
  assert.deepEqual(await saldo('FMNT-R003'), { total: 1, disponivel: 0, emprestada: 0, baixada: 1 });
  const ev = (await h.q("SELECT tipo, quantidade::int AS q FROM emprestimo.emprestimo_evento WHERE emprestimo_id = $1 ORDER BY em, tipo DESC", [r2.id])).rows;
  assert.deepEqual(ev.map(v => v.tipo), ['retirada', 'baixa'], 'histórico: retirada e baixa');
});

test('importação: transação única (linha inválida no meio não grava nada) e código já cadastrado vira "ignorada" sem sobrescrever', async () => {
  await assert.rejects(noPainel(U.alm, 'ferramentas_importar', { linhas: [{ codigo: 'FMNT-R010', nome: 'Boa' }, { codigo: 'fora do formato', nome: 'Ruim' }] }),
    e => e.code === '22023' && /Linha 2/.test(e.message));
  assert.equal((await h.q("SELECT count(*)::int AS n FROM emprestimo.ferramenta WHERE codigo = 'FMNT-R010'")).rows[0].n, 0, 'rollback: a linha 1 também não ficou');
  const r = await h.api(U.alm, 'POST', `${API}/ferramentas/importar`, { linhas: [{ codigo: 'FMNT-R001', nome: 'De novo' }, { codigo: 'FMNT-R011', nome: 'Nova' }] });
  assert.deepEqual([r.s, r.j.criadas, r.j.ignoradas], [200, 1, [{ codigo: 'FMNT-R001', motivo: 'Código já cadastrado' }]]);
  assert.equal((await h.q("SELECT nome FROM emprestimo.ferramenta WHERE codigo = 'FMNT-R001'")).rows[0].nome, 'Disco de corte (teste)', 'não sobrescreveu');
  assert.equal((await h.api(U.alm, 'POST', `${API}/ferramentas/importar`, { linhas: 'x' })).s, 400);
  assert.equal((await h.api(U.alm, 'POST', `${API}/ferramentas/importar`, { linhas: [{ codigo: 'FMNT-R012', nome: 'N'.repeat(161) }] })).j.erro, 'Linha 1: Descrição com mais de 160 caracteres.');
});

test('reaplicar as migrations 40 e 44 (como o deploy) não perde retirada, status nem campos da planilha', async () => {
  const antes = (await h.q("SELECT e.id, e.modalidade, e.status, e.prazo FROM emprestimo.emprestimo e ORDER BY e.id")).rows;
  const ferr = (await h.q("SELECT codigo, retiravel, codigo_compra, patrimonio FROM emprestimo.ferramenta ORDER BY codigo")).rows;
  const MIG = path.resolve(__dirname, '../../database/migrations');
  for (const f of ['40-emprestimo.sql', '44-emprestimo-retirada.sql']) await h.db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  h.srv.closeIdleConnections?.();   // o PGlite trava o event loop no exec: keep-alive vencido (ver emprestimo-cobertura)
  assert.deepEqual((await h.q("SELECT e.id, e.modalidade, e.status, e.prazo FROM emprestimo.emprestimo e ORDER BY e.id")).rows, antes);
  assert.deepEqual((await h.q("SELECT codigo, retiravel, codigo_compra, patrimonio FROM emprestimo.ferramenta ORDER BY codigo")).rows, ferr);
  assert.ok(ferr.some(f => f.codigo === 'FMNT-R003' && f.retiravel && f.codigo_compra === 'CC-R3' && f.patrimonio === 'PAT-R01'));
});
