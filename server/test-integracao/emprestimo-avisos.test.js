'use strict';
// Avisos automáticos do empréstimo por e-mail (migration 42) no banco de verdade (PGlite, sob RLS) e pela API.
// O tempo é simulado com emprestimo.enfileirar_avisos_em(p_agora); o worker só alcança emprestimo.enfileirar_avisos().
// Dados fictícios: pessoas "Pessoa xxx" do harness, ferramentas AV-000x, matrículas TA00x.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirApp } = require('./_harness');
const { SQL_CLAIM, validateRow } = require('../src/worker-email');

let h, U;
const API = '/api/emprestimo';
const AV = '/api/emprestimo/avisos';
const HORA = 3600e3;
const F = {};
let chaveN = 0;
const chave = () => `aviso-chave-${++chaveN}-${Date.now()}`;

/** Mesma função de escrita do painel/terminal (a rota só valida a forma); poupa requisições ao limite por IP. */
function exec(u, acao, p, canal = 'painel') {
  return h.transaction(u, async db => {
    await db.query("SELECT set_config('app.canal',$1,true)", [canal]);
    return (await db.query('SELECT emprestimo.executar($1,$2::jsonb) AS r', [acao, JSON.stringify(p)])).rows[0].r;
  });
}
/** Um ciclo do worker no instante t (como dono do banco: a versão com horário simulado não é do worker). */
const rodar = t => h.transaction(null, async db => { await db.query('SET LOCAL ROLE NONE'); return (await db.query('SELECT emprestimo.enfileirar_avisos_em($1::timestamptz) AS n', [t.toISOString()])).rows[0].n; });
const comoWorker = sql => h.transaction(null, async db => { await db.query('SET LOCAL ROLE biotrop_worker'); return (await db.query(sql)).rows; });
const em = (e, horas) => new Date(e.prazo.getTime() + horas * HORA);
const fila = async () => (await h.q('SELECT count(*)::int n FROM core.email_fila')).rows[0].n;
async function emprestar(atendente, colab, itens, horasAtePrazo = 72) {
  const r = await exec(atendente, 'emprestar', { colaboradorId: colab.id, chave: chave(), prazo: new Date(Date.now() + horasAtePrazo * HORA).toISOString(), itens });
  const e = (await h.q('SELECT id, numero, prazo FROM emprestimo.emprestimo WHERE id=$1', [r.id])).rows[0];
  return { id: e.id, numero: e.numero, prazo: new Date(e.prazo) };
}
const itens = async e => (await h.q(`SELECT id, codigo, qtd_conferencia::int AS conf, (quantidade - qtd_conferencia - qtd_devolvida - qtd_baixa)::int AS pendente
  FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1 ORDER BY codigo`, [e.id])).rows;
async function avisos(e) {
  return (await h.q(`SELECT a.tipo, a.janela, a.observacao, a.email_id, f.destinatario::text AS para, f.copia::text[] AS cc, f.assunto, f.corpo_html AS html,
      f.motivo, f.status::text AS status, f.erro
    FROM emprestimo.aviso a LEFT JOIN core.email_fila f ON f.id = a.email_id WHERE a.emprestimo_id=$1 ORDER BY a.criado_em, a.tipo`, [e.id])).rows;
}
const doTipo = async (e, tipo) => (await avisos(e)).filter(a => a.tipo === tipo);
/** Devolução registrada pelo almoxarife (com chave de operação, para valer também se a devolução passar a exigi-la). */
const devolver = (e, lista) => exec(U.alm, 'devolver', { emprestimoId: e.id, chave: chave(), itens: lista });
/** Devolve e confere tudo (isola um teste do outro: empréstimo fechado não recebe aviso). */
async function fechar(e) {
  const pend = (await itens(e)).filter(i => i.pendente > 0);
  if (pend.length) await devolver(e, pend.map(i => ({ itemId: i.id, quantidade: String(i.pendente) })));
  const conf = (await itens(e)).filter(i => i.conf > 0);
  if (conf.length) await exec(U.alm, 'conferir', { emprestimoId: e.id, itens: conf.map(i => ({ itemId: i.id, quantidade: String(i.conf), resultado: 'boa' })) });
}

test.before(async () => {
  h = await subirApp({ adm: 'admin', ges: 'gestor', alm: 'almoxarife', alm2: 'almoxarife', tec: 'tecnico', term: 'terminal', term2: 'terminal', semmail: 'terminal' });
  U = h.users;
  F.chave = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'AV-0001', nome: 'Chave de teste <b>aviso</b> (fictícia)', controle: 'quantidade', total: '30', localizacao: 'Armário T' })).id;
  F.alicate = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'AV-0002', nome: 'Alicate de teste (fictício)', controle: 'quantidade', total: '30' })).id;
  for (const [k, m] of [['term', 'TA001'], ['term2', 'TA002'], ['semmail', 'TA003']]) {
    await exec(U.alm, 'colaborador_salvar', { nome: `Pessoa ${k}`, email: U[k].email, matricula: m, setor: 'Setor Sigilo', centroCusto: 'CC-SIGILO-1' });
  }
});
test.after(() => h?.fechar());

test('configuração dos avisos: técnico 403, almoxarife lê e não grava, gestor grava com limites e auditoria', async () => {
  for (const u of [U.tec, U.term]) {
    assert.equal((await h.api(u, 'GET', `${AV}/config`)).s, 403);
    assert.equal((await h.api(u, 'PUT', `${AV}/config`, { avisosAtivos: false })).s, 403);
    assert.equal((await h.api(u, 'GET', AV)).s, 403);
  }
  assert.equal((await h.raw(null, 'GET', `${AV}/config`)).status, 401);
  const cru = await h.raw(U.alm, 'GET', `${AV}/config`);
  assert.equal(cru.status, 200); assert.equal(cru.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await cru.json()).config, { avisosAtivos: true, avisoNoVencimento: true, escalarAposHoras: 48, avisoDevolucao: false, lembreteAntesHoras: 24, atrasoIntervaloHoras: 24 });
  let r = await h.api(U.alm, 'PUT', `${AV}/config`, { escalarAposHoras: 72 });
  assert.equal(r.s, 403, 'almoxarife não grava');
  for (const corpo of [{ escalarAposHoras: 0 }, { escalarAposHoras: 721 }, { escalarAposHoras: 1.5 }, { escalarAposHoras: 'abc' }, { escalarAposHoras: true },
    { escalarAposHoras: null }, { avisosAtivos: 'talvez' }, { avisoDevolucao: 1 }, {}, []]) {
    r = await h.api(U.ges, 'PUT', `${AV}/config`, corpo);
    assert.equal(r.s, 400, JSON.stringify(corpo)); assert.equal(r.j.ok, false);
  }
  r = await h.api(U.ges, 'PUT', `${AV}/config`, { escalarAposHoras: '72', avisoDevolucao: true, lembreteAntesHoras: 1 });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.config, { avisosAtivos: true, avisoNoVencimento: true, escalarAposHoras: 72, avisoDevolucao: true, lembreteAntesHoras: 24, atrasoIntervaloHoras: 24 },
    'lembrete e intervalo continuam no PUT /api/emprestimo/config');
  const aud = (await h.q("SELECT detalhe, por FROM emprestimo.auditoria WHERE tipo='avisos_config_salva' ORDER BY em DESC LIMIT 1")).rows[0];
  assert.equal(aud.por, U.ges.id); assert.equal(aud.detalhe.antes.escalarAposHoras, 48); assert.equal(aud.detalhe.depois.escalarAposHoras, 72);
  assert.ok((await h.q('SELECT aviso_devolucao_desde FROM emprestimo.config')).rows[0].aviso_devolucao_desde, 'ligar marca desde quando');
  // o banco confere de novo, sem depender da rota; a API não tem UPDATE direto; no canal do terminal nem o admin grava
  await assert.rejects(h.transaction(U.alm, db => db.query(`SELECT emprestimo.avisos_config_salvar('{"avisosAtivos":false}'::jsonb)`)), e => e.code === '42501');
  await assert.rejects(h.transaction(U.adm, db => db.query('UPDATE emprestimo.config SET avisos_ativos = false')), e => e.code === '42501');
  await assert.rejects(h.transaction(U.adm, async db => {
    await db.query("SELECT set_config('app.canal','terminal',true)");
    return db.query(`SELECT emprestimo.avisos_config_salvar('{"avisosAtivos":false}'::jsonb)`);
  }), e => e.code === '42501');
  await assert.rejects(h.transaction(U.ges, db => db.query(`SELECT emprestimo.avisos_config_salvar('{"escalarAposHoras":"9999"}'::jsonb)`)), e => e.code === '22023', 'tipo conferido no banco também');
  r = await h.api(U.adm, 'PUT', `${AV}/config`, { escalarAposHoras: 48, avisoDevolucao: 'false' });
  assert.equal(r.s, 200); assert.equal(r.j.config.escalarAposHoras, 48); assert.equal(r.j.config.avisoDevolucao, false);
  r = await h.api(U.alm, 'GET', AV);
  assert.equal(r.s, 200); assert.deepEqual(r.j.rows, []);
});

test('lembrete antes do prazo e aviso no vencimento, sem duplicidade em chamadas repetidas ou simultâneas', async () => {
  const e = await emprestar(U.alm, U.term, [{ ferramentaId: F.chave, quantidade: 2 }], 72);
  await rodar(em(e, -48));
  assert.equal((await avisos(e)).length, 0, 'fora da janela do lembrete');
  await rodar(em(e, -10));
  let l = await doTipo(e, 'lembrete');
  assert.equal(l.length, 1);
  assert.equal(l[0].para, U.term.email); assert.equal(l[0].motivo, 'emprestimo_lembrete'); assert.equal(l[0].status, 'pendente');
  assert.match(l[0].assunto, new RegExp(`^\\[Lembrete\\] Empréstimo ${e.numero} vence em \\d{2}/\\d{2} às \\d{2}:\\d{2}$`));
  assert.match(l[0].html, /AV-0001/); assert.match(l[0].html, /<b>2<\/b>/);
  assert.match(l[0].html, /Chave de teste &lt;b&gt;aviso&lt;\/b&gt;/, 'escape de HTML do que vem do banco');
  assert.doesNotMatch(l[0].html, /<b>aviso<\/b>/);
  assert.doesNotMatch(l[0].html, /TA001|CC-SIGILO|Setor Sigilo/, 'sem matrícula, centro de custo nem setor');
  assert.match(l[0].html, /Devolva no <b>Almoxarifado<\/b>/);
  // repetir não duplica; três ciclos seguidos "ao mesmo tempo" (worker + duas chamadas) também não
  assert.equal(await rodar(em(e, -9)), 0);
  await Promise.all([rodar(em(e, -8)), rodar(em(e, -8)), comoWorker('SELECT emprestimo.enfileirar_avisos()')]);
  assert.equal((await doTipo(e, 'lembrete')).length, 1, 'um lembrete só');
  await assert.rejects(h.q('INSERT INTO emprestimo.aviso (emprestimo_id, tipo, janela) SELECT emprestimo_id, tipo, janela FROM emprestimo.aviso WHERE emprestimo_id=$1', [e.id]),
    err => err.code === '23505', 'a chave única é a garantia entre dois workers');
  // no vencimento: um aviso, uma vez
  await rodar(em(e, 1));
  const v = await doTipo(e, 'vencimento');
  assert.equal(v.length, 1); assert.equal(v[0].motivo, 'emprestimo_vencimento'); assert.match(v[0].assunto, /o prazo de devolução venceu/);
  await rodar(em(e, 2)); await rodar(em(e, 23));
  assert.equal((await doTipo(e, 'vencimento')).length, 1);
  assert.equal((await doTipo(e, 'atraso')).length, 0, 'atraso só depois do primeiro intervalo');
  // prazo curto (menor que a janela do lembrete): sem lembrete na saída do balcão, mas com aviso no vencimento
  const curto = await emprestar(U.alm, U.term, [{ ferramentaId: F.alicate, quantidade: 1 }], 10);
  await rodar(em(curto, -5));
  assert.equal((await doTipo(curto, 'lembrete')).length, 0);
  await rodar(em(curto, 0.5));
  assert.equal((await doTipo(curto, 'vencimento')).length, 1);
  // novo prazo: o que ainda esperava na fila sobre o prazo antigo é cancelado
  await exec(U.alm, 'prazo', { emprestimoId: e.id, prazo: new Date(Date.now() + 96 * HORA).toISOString(), justificativa: 'Serviço estendido (teste)' });
  await rodar(new Date());
  const antigos = await avisos(e);
  assert.deepEqual(antigos.map(a => a.status), ['cancelado', 'cancelado']);
  assert.ok(antigos.every(a => a.erro === 'Cancelado: o prazo do empréstimo mudou'));
  await fechar(e); await fechar(curto);
  await rodar(new Date());
  assert.equal((await doTipo(curto, 'vencimento'))[0].erro, 'Cancelado: não há mais pendência neste empréstimo');
});

test('atraso recorrente respeita o intervalo (mesmo quando ele muda) e o escalonamento vai ao almoxarifado com a gestão em cópia', async () => {
  await h.q("UPDATE core.usuario SET nome = 'Pessoa term2 & <i>Teste</i>' WHERE id=$1", [U.term2.id]);
  const e = await emprestar(U.alm2, U.term2, [{ ferramentaId: F.chave, quantidade: 1 }, { ferramentaId: F.alicate, quantidade: 3 }], 72);
  await rodar(em(e, 25));
  let a = await doTipo(e, 'atraso');
  assert.equal(a.length, 1); assert.equal(a[0].motivo, 'emprestimo_atraso'); assert.equal(a[0].para, U.term2.email);
  assert.match(a[0].assunto, /^\[Ação necessária\] Empréstimo EMP-\d{6} em atraso$/); assert.match(a[0].html, /\(1 dia\)/);
  assert.equal((await doTipo(e, 'vencimento')).length, 0, 'passou da janela do vencimento: vai direto ao atraso');
  await rodar(em(e, 30)); await rodar(em(e, 47));
  assert.equal((await doTipo(e, 'atraso')).length, 1, 'nada antes de completar o intervalo');
  assert.equal((await doTipo(e, 'escalonamento')).length, 0);
  await rodar(em(e, 49));
  a = await doTipo(e, 'atraso'); assert.equal(a.length, 2);
  const esc = await doTipo(e, 'escalonamento');
  assert.equal(esc.length, 1); assert.equal(esc[0].motivo, 'emprestimo_escalonamento');
  assert.equal(esc[0].para, U.alm2.email, 'o atendente do empréstimo');
  assert.deepEqual([...esc[0].cc].sort(), [U.alm.email, U.ges.email].sort(), 'os outros almoxarifes e os gestores; nem o colaborador nem o admin');
  // O worker lê a linha com as colunas do SQL_CLAIM: citext[] cru chega como texto '{...}' e a cópia sumia (rodada 2).
  const colunas = SQL_CLAIM.split('RETURNING ')[1];
  const linha = (await h.q(`SELECT ${colunas} FROM core.email_fila f WHERE f.id = $1`, [esc[0].email_id])).rows[0];
  const msg = validateRow(linha, { sender: String(linha.remetente || 'remetente@teste.biotrop').toLowerCase() });
  assert.deepEqual([...msg.cc].sort(), [U.alm.email, U.ges.email].map(x => x.toLowerCase()).sort(), 'a gestão em cópia chega ao envio do worker');
  assert.match(esc[0].assunto, /em atraso há 2 dias$/);
  assert.match(esc[0].html, /Pessoa term2 &amp; &lt;i&gt;Teste&lt;\/i&gt;/);
  assert.doesNotMatch(esc[0].html, /TA002|CC-SIGILO|Setor Sigilo/);
  assert.match(esc[0].html, /AV-0001[\s\S]*AV-0002/);
  await rodar(em(e, 60)); await rodar(em(e, 73.5));
  assert.equal((await doTipo(e, 'escalonamento')).length, 1, 'escalonamento uma vez por prazo');
  assert.equal((await doTipo(e, 'atraso')).length, 3, 'terceiro ciclo');
  // o intervalo muda para 12 h no meio do caminho: continua contando desde o último aviso
  await h.q('UPDATE emprestimo.config SET atraso_intervalo_horas = 12');
  await rodar(em(e, 80)); await rodar(em(e, 85));
  assert.equal((await doTipo(e, 'atraso')).length, 3, 'menos de 12 h desde o último');
  await rodar(em(e, 86));
  assert.equal((await doTipo(e, 'atraso')).length, 4);
  await h.q('UPDATE emprestimo.config SET atraso_intervalo_horas = 24');
  await fechar(e);
  // retirada no terminal (sem atendente): vai ao primeiro almoxarife, os outros e os gestores em cópia
  const t = await emprestar(U.alm, U.term, [{ ferramentaId: F.chave, quantidade: 1 }], 72);
  await h.q("UPDATE emprestimo.emprestimo SET atendente_id = NULL, origem = 'terminal' WHERE id=$1", [t.id]);
  await rodar(em(t, 50));
  const esc2 = await doTipo(t, 'escalonamento');
  assert.equal(esc2.length, 1); assert.equal(esc2[0].para, U.alm.email);
  assert.deepEqual([...esc2[0].cc].sort(), [U.alm2.email, U.ges.email].sort());
  await fechar(t);
});

test('intervalo do atraso aumentado no meio do atraso (12 h → 24 h): o próximo sai um intervalo depois do último, sem dias de silêncio', async () => {
  // Antes a janela era horas ÷ intervalo: com 24 h, as 48 h e as 72 h davam 2 e 3, números já usados com 12 h, e o
  // próximo atraso só saía às 96 h (59 h sem aviso). Agora a janela é o nº de ordem do atraso naquele prazo.
  await h.q('UPDATE emprestimo.config SET atraso_intervalo_horas = 12');
  const e = await emprestar(U.alm, U.term, [{ ferramentaId: F.chave, quantidade: 1 }], 72);
  const atrasos = async () => (await h.q(`SELECT janela, email_id, round(extract(epoch FROM criado_em - $2::timestamptz) / 3600)::int AS horas
    FROM emprestimo.aviso WHERE emprestimo_id=$1 AND tipo='atraso' ORDER BY criado_em`, [e.id, e.prazo.toISOString()])).rows;
  try {
    for (const hh of [13, 25, 37]) await rodar(em(e, hh));
    assert.deepEqual((await atrasos()).map(a => a.horas), [13, 25, 37]);
    await h.q('UPDATE emprestimo.config SET atraso_intervalo_horas = 24');
    for (let hh = 38; hh <= 100; hh++) await rodar(em(e, hh));                       // de hora em hora, como o worker
    let l = await atrasos();
    assert.deepEqual(l.map(a => a.horas), [13, 25, 37, 61, 85], '24 h depois do último (37 h), e não às 96 h');
    assert.deepEqual(l.map(a => a.janela.split(':')[1]), ['1', '2', '3', '4', '5'], 'nº de ordem, sem repetir número');
    assert.ok(l.every(a => a.email_id), 'todos foram ao colaborador');
    // e de volta para menos (24 h → 6 h): conta desde o último, sem dois no mesmo intervalo
    await h.q('UPDATE emprestimo.config SET atraso_intervalo_horas = 6');
    for (let hh = 86; hh <= 97; hh++) { await rodar(em(e, hh)); await rodar(em(e, hh)); }
    l = await atrasos();
    assert.deepEqual(l.map(a => a.horas).slice(5), [91, 97]);
    assert.equal(new Set(l.map(a => a.janela)).size, l.length);
  } finally {
    await h.q('UPDATE emprestimo.config SET atraso_intervalo_horas = 24');
    await fechar(e);
  }
});

test('devolução parcial avisa só o pendente; devolução total e estorno param os avisos e cancelam o que estava na fila', async () => {
  const e = await emprestar(U.alm, U.term, [{ ferramentaId: F.chave, quantidade: 3 }, { ferramentaId: F.alicate, quantidade: 1 }], 72);
  const [iChave, iAlic] = await itens(e);
  // devolve 1 chave e o alicate inteiro (ainda sem conferência): o pendente cai na hora
  await devolver(e, [{ itemId: iChave.id, quantidade: '1' }, { itemId: iAlic.id, quantidade: '1' }]);
  await rodar(em(e, 1));
  const v = (await doTipo(e, 'vencimento'))[0];
  assert.match(v.html, /AV-0001[\s\S]*?<b>2<\/b>/, 'só o que falta da chave (3 − 1)');
  assert.doesNotMatch(v.html, /AV-0002/, 'o alicate já voltou');
  // devolve o resto: a pendência acaba e o aviso que ainda esperava na fila é cancelado
  await devolver(e, [{ itemId: iChave.id, quantidade: '2' }]);
  await rodar(em(e, 2));
  const cancelado = (await doTipo(e, 'vencimento'))[0];
  assert.equal(cancelado.status, 'cancelado'); assert.equal(cancelado.erro, 'Cancelado: não há mais pendência neste empréstimo');
  await rodar(em(e, 30)); await rodar(em(e, 60));
  assert.deepEqual((await avisos(e)).map(a => a.tipo), ['vencimento'], 'tudo em conferência: nem atraso nem escalonamento');
  // a conferência recusa 1 (não voltou de fato): volta a ser pendente e os avisos voltam, só sobre ela
  await exec(U.alm, 'conferir', { emprestimoId: e.id, itens: [{ itemId: iChave.id, quantidade: '1', resultado: 'recusada', observacao: 'Não estava no balcão (teste)' },
    { itemId: iAlic.id, quantidade: '1', resultado: 'boa' }] });
  await exec(U.alm, 'conferir', { emprestimoId: e.id, itens: [{ itemId: iChave.id, quantidade: '2', resultado: 'boa' }] });
  await rodar(em(e, 61));
  const at = await doTipo(e, 'atraso');
  assert.equal(at.length, 1); assert.match(at[0].html, /AV-0001[\s\S]*?<b>1<\/b>/); assert.doesNotMatch(at[0].html, /AV-0002/);
  await fechar(e);
  await rodar(em(e, 62));
  assert.ok((await avisos(e)).filter(a => a.tipo !== 'vencimento').every(a => a.status === 'cancelado'), 'devolvido: nada mais sai');
  // estorno: o lembrete na fila é cancelado e nada mais é enfileirado
  const x = await emprestar(U.alm, U.term2, [{ ferramentaId: F.alicate, quantidade: 2 }], 72);
  await rodar(em(x, -10));
  assert.equal((await doTipo(x, 'lembrete'))[0].status, 'pendente');
  await exec(U.ges, 'estornar', { emprestimoId: x.id, justificativa: 'Lançado errado (teste)' });
  await rodar(em(x, -9));
  assert.equal((await doTipo(x, 'lembrete'))[0].status, 'cancelado');
  await rodar(em(x, 1)); await rodar(em(x, 50));
  assert.deepEqual((await avisos(x)).map(a => a.tipo), ['lembrete'], 'estornado não recebe aviso');
});

test('avisos desligados não enfileiram nada; vencimento é opcional; colaborador sem e-mail é pulado e registrado, sem quebrar', async () => {
  assert.equal((await h.api(U.ges, 'PUT', `${AV}/config`, { avisosAtivos: false })).s, 200);
  const a = await emprestar(U.alm, U.term, [{ ferramentaId: F.chave, quantidade: 1 }], 72);
  const antes = await fila();
  assert.equal(await rodar(em(a, -10)), 0); await rodar(em(a, 1)); await rodar(em(a, 60));
  assert.equal((await avisos(a)).length, 0); assert.equal(await fila(), antes);
  assert.equal((await h.api(U.ges, 'PUT', `${AV}/config`, { avisosAtivos: true, avisoNoVencimento: false })).s, 200);
  await rodar(em(a, 1));
  assert.equal((await avisos(a)).length, 0, 'sem aviso no vencimento');
  await rodar(em(a, 25));
  assert.deepEqual((await avisos(a)).map(x => x.tipo), ['atraso']);
  assert.equal((await h.api(U.ges, 'PUT', `${AV}/config`, { avisoNoVencimento: true })).s, 200);
  await fechar(a);
  // endereço que o worker recusaria (sem ponto no domínio): pula, registra o motivo e não tenta de novo na mesma janela
  await h.q("UPDATE core.usuario SET email = 'pessoa.semmail@intranet' WHERE id=$1", [U.semmail.id]);
  const s = await emprestar(U.alm, U.semmail, [{ ferramentaId: F.alicate, quantidade: 1 }], 72);
  const antes2 = await fila();
  assert.equal(await rodar(em(s, 1)), 0);
  let reg = await avisos(s);
  assert.equal(reg.length, 1); assert.equal(reg[0].email_id, null); assert.equal(reg[0].observacao, 'Colaborador sem e-mail válido');
  assert.equal(await fila(), antes2);
  await rodar(em(s, 2));
  assert.equal((await avisos(s)).length, 1);
  const log = (await h.api(U.alm, 'GET', AV)).j.rows.find(x => x.emprestimoNumero === s.numero);
  assert.deepEqual([log.tipo, log.status, log.destinatario, log.observacao], ['vencimento', 'pulado', '', 'Colaborador sem e-mail válido']);
  // o escalonamento continua indo ao almoxarifado; colaborador desligado (inativo) também é pulado
  await h.q('UPDATE core.usuario SET ativo = false WHERE id=$1', [U.semmail.id]);
  await rodar(em(s, 50));
  reg = await avisos(s);
  assert.equal(reg.find(x => x.tipo === 'escalonamento').para, U.alm.email);
  assert.equal(reg.find(x => x.tipo === 'atraso').observacao, 'Colaborador inativo');
  await h.q('UPDATE core.usuario SET ativo = true WHERE id=$1', [U.semmail.id]);
  await fechar(s);
});

test('cadastro do terminal desligado no painel (usuário do site ainda ativo): lembrete, vencimento e atraso ficam "pulados", o escalonamento vai ao almoxarifado e religar volta a cobrar', async () => {
  // "Cadastro ativo" do painel só mexe em emprestimo.colaborador.ativo; quem foi desligado por ali não recebe mais e-mail
  const cad = ativo => exec(U.alm, 'colaborador_salvar', { nome: 'Pessoa term2', email: U.term2.email, matricula: 'TA002', setor: 'Setor Sigilo', centroCusto: 'CC-SIGILO-1', ativo });
  const e = await emprestar(U.alm, U.term2, [{ ferramentaId: F.alicate, quantidade: 1 }], 72);
  try {
    await cad(false);
    assert.equal((await h.q('SELECT ativo FROM core.usuario WHERE id=$1', [U.term2.id])).rows[0].ativo, true, 'o usuário do site continua ativo');
    for (const hh of [-10, 1, 25, 49]) await rodar(em(e, hh));
    const reg = await avisos(e);
    assert.deepEqual(reg.map(a => a.tipo).sort(), ['atraso', 'atraso', 'escalonamento', 'lembrete', 'vencimento']);
    for (const a of reg.filter(x => x.tipo !== 'escalonamento')) assert.deepEqual([a.email_id, a.observacao], [null, 'Colaborador inativo'], `${a.tipo}: nada vai a quem foi desligado`);
    const esc = reg.find(x => x.tipo === 'escalonamento');
    assert.equal(esc.para, U.alm.email, 'a cobrança escala ao almoxarifado');
    assert.ok(!esc.cc.includes(U.term2.email));
    const log = (await h.api(U.alm, 'GET', AV)).j.rows.filter(x => x.emprestimoNumero === e.numero && x.tipo !== 'escalonamento');
    assert.equal(log.length, 4);
    assert.ok(log.every(x => x.status === 'pulado' && x.destinatario === '' && x.observacao === 'Colaborador inativo'), '"Avisos enviados" mostra pulado, não enviado');
    // religado: o atraso seguinte já vai ao colaborador
    await cad(true);
    await rodar(em(e, 73));
    const at = (await doTipo(e, 'atraso')).filter(a => a.email_id);
    assert.equal(at.length, 1); assert.equal(at[0].para, U.term2.email);
  } finally { await cad(true); await fechar(e); }
});

test('confirmação de devolução conferida: opcional, só depois de ligar, uma por conferência', async () => {
  const e = await emprestar(U.alm, U.term, [{ ferramentaId: F.chave, quantidade: 3 }], 72);
  const [it] = await itens(e);
  const devolverEConferir = async (resultado, obs) => {
    await devolver(e, [{ itemId: it.id, quantidade: '1', condicao: resultado }]);
    await exec(U.alm, 'conferir', { emprestimoId: e.id, itens: [{ itemId: it.id, quantidade: '1', resultado, observacao: obs }] });
  };
  await devolverEConferir('boa');
  await rodar(new Date());
  assert.equal((await doTipo(e, 'devolucao')).length, 0, 'desligada (padrão)');
  assert.equal((await h.api(U.ges, 'PUT', `${AV}/config`, { avisoDevolucao: true })).s, 200);
  await rodar(new Date());
  assert.equal((await doTipo(e, 'devolucao')).length, 0, 'ligar não manda nada sobre o que já foi conferido');
  await devolverEConferir('boa');
  await rodar(new Date());
  let dv = await doTipo(e, 'devolucao');
  assert.equal(dv.length, 1); assert.equal(dv[0].motivo, 'emprestimo_devolucao'); assert.equal(dv[0].para, U.term.email);
  assert.match(dv[0].assunto, new RegExp(`Devolução conferida: ${e.numero}$`));
  assert.match(dv[0].html, />Boa</); assert.match(dv[0].html, /Ainda está com você/); assert.match(dv[0].html, /AV-0001[\s\S]*Pendente[\s\S]*<b>1<\/b>/);
  await devolverEConferir('avaria', 'Cabo trincado (teste)');
  await rodar(new Date()); await rodar(new Date());
  dv = await doTipo(e, 'devolucao');
  assert.equal(dv.length, 2, 'uma por conferência, sem repetir');
  assert.match(dv[1].html, /Com avaria/); assert.match(dv[1].html, /Nada mais pendente/);
  assert.doesNotMatch(dv[1].html, /Cabo trincado|Pessoa alm/, 'sem a observação nem o nome de quem conferiu');
  assert.equal((await h.api(U.ges, 'PUT', `${AV}/config`, { avisoDevolucao: false })).s, 200);
});

test('worker: só EXECUTE em emprestimo.enfileirar_avisos(); a API não enfileira nem escreve no registro, que só cresce', async () => {
  const [r] = await comoWorker('SELECT emprestimo.enfileirar_avisos() AS n');
  assert.equal(typeof r.n, 'number');
  for (const sql of ['SELECT * FROM emprestimo.aviso', 'SELECT * FROM emprestimo.emprestimo', 'SELECT * FROM emprestimo.config',
    "SELECT emprestimo.enfileirar_avisos_em(now() + interval '30 days')", "SELECT emprestimo.avisos_config_salvar('{}'::jsonb)", 'SELECT * FROM emprestimo.avisos_log(10)']) {
    await assert.rejects(comoWorker(sql), e => e.code === '42501', sql);
  }
  // o USAGE no schema (para achar a função) não pode virar porta: toda outra função do empréstimo tira o EXECUTE de PUBLIC
  const alcance = (await h.q(`SELECT p.oid::regprocedure::text f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'emprestimo' AND p.prokind = 'f' AND p.prorettype <> 'trigger'::regtype AND has_function_privilege('biotrop_worker', p.oid, 'EXECUTE')`)).rows.map(x => x.f);
  assert.deepEqual(alcance, ['emprestimo.enfileirar_avisos()']);
  assert.equal((await h.q("SELECT count(*)::int n FROM information_schema.table_privileges WHERE grantee = 'biotrop_worker' AND table_schema = 'emprestimo'")).rows[0].n, 0);
  await assert.rejects(h.transaction(U.adm, db => db.query('SELECT emprestimo.enfileirar_avisos()')), e => e.code === '42501');
  await assert.rejects(h.transaction(U.adm, db => db.query("INSERT INTO emprestimo.aviso (emprestimo_id, tipo, janela) SELECT id, 'lembrete', 'x' FROM emprestimo.emprestimo LIMIT 1")),
    e => e.code === '42501');
  assert.ok((await h.q('SELECT count(*)::int n FROM emprestimo.aviso')).rows[0].n > 0);
  await assert.rejects(h.q("UPDATE emprestimo.aviso SET observacao = 'x'"), /não pode ser alterado/);
  await assert.rejects(h.q('DELETE FROM emprestimo.aviso'), /não pode ser alterado/);
});

test('registro de avisos: gestão lê número, tipo, destinatário e situação; sem assunto nem corpo; nada pelo RLS fora da gestão', async () => {
  const r = await h.api(U.alm, 'GET', `${AV}?limite=500`);
  assert.equal(r.s, 200);
  assert.ok(r.j.rows.length >= 10);
  assert.deepEqual(Object.keys(r.j.rows[0]).sort(), ['copias', 'criadoEm', 'destinatario', 'emprestimoId', 'emprestimoNumero', 'enviadoEm', 'id', 'observacao', 'status', 'tentativas', 'tipo']);
  assert.ok(r.j.rows.some(a => a.tipo === 'escalonamento' && a.copias === 2 && a.destinatario === U.alm2.email), 'atendente + 2 em cópia');
  assert.ok(r.j.rows.some(a => a.tipo === 'devolucao' && a.status === 'pendente' && a.tentativas === 0), 'a confirmação de devolução não é cancelada');
  assert.ok(r.j.rows.filter(a => a.tipo !== 'devolucao').every(a => a.status === 'cancelado' || a.status === 'pulado'), 'todos os empréstimos foram fechados');
  assert.ok(r.j.rows.some(a => a.status === 'cancelado' && /pendência/.test(a.observacao)));
  assert.ok(!JSON.stringify(r.j).includes('<div'), 'o corpo do e-mail não sai na API');
  const datas = r.j.rows.map(a => new Date(a.criadoEm).getTime());
  assert.deepEqual(datas, [...datas].sort((x, y) => y - x), 'mais novos primeiro');
  assert.equal((await h.api(U.alm, 'GET', `${AV}?limite=1`)).j.rows.length, 1);
  assert.equal((await h.api(U.alm, 'GET', `${AV}?limite=abc`)).s, 200);
  const noTerminal = await h.transaction(U.adm, async db => { await db.query("SELECT set_config('app.canal','terminal',true)"); return (await db.query('SELECT * FROM emprestimo.avisos_log(50)')).rows; });
  assert.equal(noTerminal.length, 0, 'no tablet nem o admin vê');
  assert.equal((await h.transaction(U.tec, db => db.query('SELECT * FROM emprestimo.aviso'))).rows.length, 0);
  assert.equal((await h.transaction(U.term, db => db.query('SELECT * FROM emprestimo.aviso'))).rows.length, 0);
});

test('reaplicar as migrations do empréstimo (como o deploy faz) não perde configuração, avisos nem privilégios', async () => {
  await h.q('UPDATE emprestimo.config SET escalar_apos_horas = 36, aviso_devolucao = true, aviso_devolucao_desde = now()');
  const estado = async () => (await h.q(`SELECT (SELECT count(*) FROM emprestimo.aviso)::int a, (SELECT count(*) FROM core.email_fila)::int f,
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'emprestimo.config'::regclass)::int k,
    (SELECT to_jsonb(c) - 'atualizado_em' FROM emprestimo.config c) cfg,
    has_table_privilege('biotrop_app', 'emprestimo.aviso', 'SELECT') app_le, has_table_privilege('biotrop_app', 'emprestimo.aviso', 'INSERT') app_grava,
    has_table_privilege('biotrop_worker', 'emprestimo.aviso', 'SELECT') worker_le,
    has_function_privilege('biotrop_worker', 'emprestimo.enfileirar_avisos()', 'EXECUTE') worker_exec,
    has_function_privilege('biotrop_worker', 'emprestimo.enfileirar_avisos_em(timestamptz)', 'EXECUTE') worker_simula`)).rows[0];
  const antes = await estado();
  const MIG = path.resolve(__dirname, '../../database/migrations');
  for (const f of fs.readdirSync(MIG).filter(n => /^\d.*\.sql$/.test(n) && n >= '40').sort()) await h.db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const depois = await estado();
  assert.deepEqual(depois, antes);
  assert.equal(depois.cfg.escalar_apos_horas, 36);
  assert.deepEqual([depois.app_le, depois.app_grava, depois.worker_le, depois.worker_exec, depois.worker_simula], [true, false, false, true, false]);
  const [r] = await comoWorker('SELECT emprestimo.enfileirar_avisos() AS n');
  assert.equal(typeof r.n, 'number');
});
