'use strict';
// Manutinho · GET /api/manutinho/resumo e /relatorio-preventivas contra PostgreSQL real (PGlite, RLS como biotrop_app).
// Cada perfil só recebe o que a rota de origem e a RLS já lhe dão: o técnico não vê dado de outro técnico, o líder vê
// só o grupo dele, a visualização não vê o que a RLS nega. Equipamentos, tanques, medidores, cursos e pessoas: [TESTE].
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

const HOJE = '2026-10-28', ONTEM = '2026-10-27';
let h, U, grupoA, grupoB;
const API = '/api/manutinho';
const resumo = async u => { const r = await h.api(u, 'GET', `${API}/resumo?hoje=${HOJE}`); assert.equal(r.s, 200, JSON.stringify(r.j)); return r.j; };
const texto = j => j.itens.map(i => `${i.modulo}|${i.nivel}|${i.titulo}|${i.detalhe}`).join('\n');
const doModulo = (j, m) => j.itens.filter(i => i.modulo === m);

async function registro(ns, id, payload, diasAtras = 0) {
  await h.q(`INSERT INTO app.sync_registro(namespace, record_id, payload, updated_at) VALUES($1,$2,$3::jsonb, now() - make_interval(days => $4))`,
    [ns, id, JSON.stringify(payload), diasAtras]);
}

test.before(async () => {
  h = await subirApp({ admin: 'admin', gestor: 'gestor', pcm: 'pcm', almox: 'almoxarife', lider: 'lider', tec: 'tecnico', tec2: 'tecnico', fora: 'tecnico', viewer: 'viewer' });
  U = h.users;
  grupoA = (await h.q(`INSERT INTO core.grupo(codigo,nome,responsavel_id) VALUES('t-a','[TESTE] Grupo A',$1) RETURNING id`, [U.lider.id])).rows[0].id;
  grupoB = (await h.q(`INSERT INTO core.grupo(codigo,nome) VALUES('t-b','[TESTE] Grupo B') RETURNING id`)).rows[0].id;
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id = ANY($2::uuid[])', [grupoA, [U.lider.id, U.tec.id, U.tec2.id]]);
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id=$2', [grupoB, U.fora.id]);
  for (const k of Object.keys(U)) U[k].sv = (await h.q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [U[k].id])).rows[0].sessao_versao;

  // Preventivas: atrasada, em dia e sem programação, num setor fictício. Válvula em vida 1 na última folha concluída.
  const ativo = async (codigo, local, camm = null) => (await h.q(`INSERT INTO pcm.ativo(codigo,nome,local,camm) VALUES($1,$2,$3,$4::core.camm) RETURNING id`,
    [codigo, `[TESTE] Equipamento ${codigo}`, local, camm])).rows[0].id;
  const a1 = await ativo('TST-901', '[TESTE] Setor A', 'CAMM 1'), a2 = await ativo('TST-902', '[TESTE] Setor A', 'CAMM 1'), a3 = await ativo('TST-903', '[TESTE] Setor B');
  const val = {};
  for (const [a, tag] of [[a1, 'TST-V1'], [a2, 'TST-V2'], [a3, 'TST-V3']]) val[tag] = (await h.q(`INSERT INTO pcm.checklist_item(ativo_id,tag) VALUES($1,$2) RETURNING id`, [a, tag])).rows[0].id;
  await h.q(`INSERT INTO pcm.preventiva(ativo_id,numero_om,data_prevista,status) VALUES($1,'TST-OM1','2026-10-20','aberta'),($2,'TST-OM2','2026-11-05','em_execucao')`, [a1, a2]);
  const conc = (await h.q(`INSERT INTO pcm.preventiva(ativo_id,data_prevista,status,concluida_em) VALUES($1,'2026-09-01','concluida',now()) RETURNING id`, [a1])).rows[0].id;
  await h.q(`INSERT INTO pcm.preventiva_item(preventiva_id,checklist_item_id,tag,trocado,vida,data_execucao) VALUES($1,$2,'TST-V1',false,1,'2026-09-01')`, [conc, val['TST-V1']]);

  // Bateladas: dois tanques fictícios (fora do filtro das preventivas: local próprio e sem válvulas).
  for (const [codigo, de, para] of [['FTD98', 100, 120], ['PGD97', 50, 66]]) {
    const t = await ativo(codigo, '[TESTE] Tanques');
    await h.q(`INSERT INTO pcm.batelada_leitura(ativo_id,data,acumulado) VALUES($1,'2026-10-01',$2),($1,'2026-10-27',$3)`, [t, de, para]);
  }

  // SCI/SCM: parada do grupo A (técnico), parada do grupo B (outro técnico), aguardando a aprovação do líder, SCI concluída.
  await registro('scm', 'TST-SCM-A1', { id: 'TST-SCM-A1', status: 'aprovada', solicitanteId: U.tec.id, _ownerId: U.tec.id, solicitanteGrupoId: grupoA }, 10);
  await registro('scm', 'TST-SCM-B1', { id: 'TST-SCM-B1', status: 'em_tratativa', solicitanteId: U.fora.id, _ownerId: U.fora.id, solicitanteGrupoId: grupoB }, 10);
  await registro('scm', 'TST-SCM-A2', { id: 'TST-SCM-A2', status: 'pendente_aprovacao_lider', solicitanteId: U.tec2.id, _ownerId: U.tec2.id, solicitanteGrupoId: grupoA, aprovadorId: U.lider.id }, 1);
  await registro('sci', 'TST-SCI-A3', { id: 'TST-SCI-A3', status: 'cadastrado', solicitanteId: U.tec.id, _ownerId: U.tec.id, solicitanteGrupoId: grupoA }, 10);

  // Medidores: dois ativos, um inativo; só o de água leu ontem.
  await registro('utility_meters', 'TST-M1', { id: 'TST-M1', name: '[TESTE] Medidor água', ativo: true });
  await registro('utility_meters', 'TST-M2', { id: 'TST-M2', name: '[TESTE] Medidor gás', ativo: true });
  await registro('utility_meters', 'TST-M3', { id: 'TST-M3', name: '[TESTE] Medidor desligado', ativo: false });
  await registro('utility_readings', 'TST-L1', { id: 'TST-L1', meterId: 'TST-M1', at: `${ONTEM}T15:00:00.000Z`, usuarioId: U.pcm.id, _ownerId: U.pcm.id });

  // Treinamento obrigatório com prazo vencido; o tec2 já concluiu.
  await registro('lms_courses', 'TST-C1', { id: 'TST-C1', title: '[TESTE] Curso obrigatório', status: 'publicado', mandatory: true, deadline_days: 10, published_at: '2026-01-01T00:00:00.000Z' });
  await registro('lms_progress', `${U.tec2.id}__TST-C1`, { usuarioId: U.tec2.id, course_id: 'TST-C1', completed_at: '2026-01-05T00:00:00.000Z', _ownerId: U.tec2.id, _groupId: grupoA });
});
test.after(() => h?.fechar());

test('exige login', async () => {
  for (const url of [`${API}/resumo`, `${API}/relatorio-preventivas`, `${API}/treinamentos-vencidos`]) {
    const r = await h.raw(null, 'GET', url); assert.equal(r.status, 401, url); await r.arrayBuffer();
  }
});

test('PCM: preventivas por setor, válvula crítica, bateladas, medidores e a ordem crítico → atenção → info', async () => {
  const j = await resumo(U.pcm);
  assert.equal(j.hoje, HOJE);
  assert.deepEqual(j.fontes, ['preventivas', 'valvulas', 'bateladas', 'solicitacoes', 'aprovacoes', 'medidores', 'treinamentos']);
  const t = texto(j);
  assert.match(t, /preventivas\|critico\|\[TESTE\] Setor A: 1 equipamento com preventiva atrasada\|TST-901 \(8 dias\)/);
  assert.match(t, /preventivas\|atencao\|\[TESTE\] Setor B: 1 equipamento sem preventiva programada\|TST-903/);
  assert.match(t, /preventivas\|info\|.*com preventiva em dia/);
  assert.match(t, /valvulas\|critico\|TST-901: 1 válvula crítica \(1 em vida 1\)\|TST-V1/);
  assert.match(t, /bateladas\|critico\|1 tanque passou do limite de bateladas\|FTD98 \(20\/18\)/);
  assert.match(t, /bateladas\|atencao\|1 tanque em alerta de bateladas\|PGD97 \(16\/18\)/);
  assert.match(t, /medidores\|atencao\|1 medidor ficou sem leitura ontem \(27\/10\/2026\)\|\[TESTE\] Medidor gás$/m);
  assert.doesNotMatch(t, /Medidor desligado/);
  const ordem = j.itens.map(i => i.nivel), peso = { critico: 0, atencao: 1, info: 2 };
  assert.deepEqual(ordem, [...ordem].sort((a, b) => peso[a] - peso[b]), 'crítico, atenção e info, nesta ordem');
  assert.deepEqual(j.contagem, { critico: ordem.filter(n => n === 'critico').length, atencao: ordem.filter(n => n === 'atencao').length, info: ordem.filter(n => n === 'info').length });
  for (const i of j.itens) assert.match(i.rota, /^\//);
});

test('técnico: vê as preventivas da equipe, mas só as próprias SCI/SCM e os próprios treinamentos; sem medidores', async () => {
  const j = await resumo(U.tec);
  assert.deepEqual(j.fontes, ['preventivas', 'valvulas', 'bateladas', 'solicitacoes', 'aprovacoes', 'treinamentos']);
  const t = texto(j);
  assert.match(t, /TST-901 \(8 dias\)/);
  assert.match(t, /solicitacoes\|atencao\|1 SCM parada há mais de 3 dias\|TST-SCM-A1/);
  assert.doesNotMatch(t, /TST-SCM-B1/, 'SCM de outro técnico não aparece');
  assert.doesNotMatch(t, /TST-SCM-A2/, 'SCM de colega do mesmo grupo também não');
  assert.doesNotMatch(t, /TST-SCI-A3/, 'SCI concluída não está parada');
  assert.equal(doModulo(j, 'aprovacoes').length, 0);
  assert.equal(doModulo(j, 'medidores').length, 0);
  const tr = doModulo(j, 'treinamentos');
  assert.equal(tr.length, 1); assert.match(tr[0].detalhe, /^Pessoa tec \(1\)$/, 'só o próprio treinamento');
  const v = await h.api(U.tec, 'GET', `${API}/treinamentos-vencidos`);
  assert.deepEqual(v.j.vencidos.map(x => x.pessoaId), [U.tec.id]);
});

test('líder: SCI/SCM e treinamentos só do grupo dele; a aprovação que espera por ele', async () => {
  const j = await resumo(U.lider);
  const t = texto(j);
  assert.match(t, /TST-SCM-A1/);
  assert.doesNotMatch(t, /TST-SCM-B1/, 'grupo B fora');
  assert.match(t, /aprovacoes\|atencao\|1 SCM aguarda a sua aprovação\|TST-SCM-A2 \(1 dia\)/);
  const tr = doModulo(j, 'treinamentos')[0];
  assert.match(tr.detalhe, /Pessoa lider \(1\)/); assert.match(tr.detalhe, /Pessoa tec \(1\)/);
  assert.doesNotMatch(tr.detalhe, /Pessoa tec2/, 'quem concluiu não está vencido');
  assert.doesNotMatch(tr.detalhe, /Pessoa fora|Pessoa gestor|Pessoa admin/, 'só o grupo do líder');
  const v = await h.api(U.lider, 'GET', `${API}/treinamentos-vencidos`);
  assert.deepEqual(v.j.vencidos.map(x => x.pessoa).sort(), ['Pessoa lider', 'Pessoa tec']);
});

test('gestor: SCI/SCM de todos os grupos e treinamentos de todos; a aprovação do líder não é dele', async () => {
  const j = await resumo(U.gestor);
  const t = texto(j);
  assert.match(t, /2 SCMs paradas há mais de 3 dias\|TST-SCM-A1 .*TST-SCM-B1|2 SCMs paradas há mais de 3 dias\|TST-SCM-B1 .*TST-SCM-A1/);
  assert.equal(doModulo(j, 'aprovacoes').length, 0);
  const tr = doModulo(j, 'treinamentos')[0];
  assert.match(tr.detalhe, /Pessoa fora/); assert.doesNotMatch(tr.detalhe, /Pessoa tec2/);
});

test('almoxarife: SCI/SCM de todos (gestão do almoxarifado), sem PCM nem medidores; treinamento só o próprio (a RLS não lhe mostra o progresso dos outros)', async () => {
  const j = await resumo(U.almox);
  assert.deepEqual(j.fontes, ['solicitacoes', 'aprovacoes', 'treinamentos']);
  const t = texto(j);
  assert.match(t, /TST-SCM-B1/);
  assert.doesNotMatch(t, /TST-901|FTD98|Medidor/);
  assert.match(doModulo(j, 'treinamentos')[0].detalhe, /^Pessoa almox \(1\)$/);
  assert.equal((await h.api(U.almox, 'GET', `${API}/relatorio-preventivas`)).s, 403);
});

test('visualização: nada do que a RLS nega (preventivas, bateladas, SCI/SCM, leituras); só o próprio treinamento', async () => {
  const j = await resumo(U.viewer);
  assert.deepEqual(j.fontes, ['treinamentos']);
  assert.deepEqual(j.itens.map(i => i.modulo), ['treinamentos']);
  assert.match(j.itens[0].detalhe, /^Pessoa viewer \(1\)$/);
  assert.equal((await h.api(U.viewer, 'GET', `${API}/relatorio-preventivas`)).s, 403);
  // a barreira de baixo: mesmo que a rota consultasse, a RLS devolveria vazio para a visualização
  const rls = await h.transaction(U.viewer, async c => ({
    prev: (await c.query('SELECT count(*)::int n FROM pcm.preventiva')).rows[0].n,
    scm: (await c.query(`SELECT count(*)::int n FROM app.sync_registro WHERE namespace='scm'`)).rows[0].n,
    leit: (await c.query(`SELECT count(*)::int n FROM app.sync_registro WHERE namespace='utility_readings'`)).rows[0].n
  }));
  assert.deepEqual(rls, { prev: 0, scm: 0, leit: 0 });
});

test('relatório das preventivas: por equipamento, setor e CAMM, com contagens e folhas', async () => {
  const r = await h.api(U.tec, 'GET', `${API}/relatorio-preventivas?hoje=${HOJE}`);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const e = Object.fromEntries(r.j.equipamentos.filter(x => x.codigo.startsWith('TST-')).map(x => [x.codigo, x]));
  assert.equal(e['TST-901'].situacao, 'atrasada'); assert.equal(e['TST-901'].atrasoDias, 8); assert.equal(e['TST-901'].folhas[0].numeroOm, 'TST-OM1');
  assert.equal(e['TST-901'].ultimaConcluida, '2026-09-01');
  assert.equal(e['TST-902'].situacao, 'em_dia'); assert.equal(e['TST-902'].proxima, '2026-11-05');
  assert.equal(e['TST-903'].situacao, 'sem_programacao');
  assert.equal(r.j.equipamentos[0].codigo, 'TST-901', 'atrasadas primeiro');
  assert.deepEqual(r.j.porSetor.find(s => s.setor === '[TESTE] Setor A'), { setor: '[TESTE] Setor A', atrasadas: 1, emDia: 1, semProgramacao: 0, total: 2 });
  assert.deepEqual(r.j.porCamm.find(s => s.camm === 'CAMM 1'), { camm: 'CAMM 1', atrasadas: 1, emDia: 1, semProgramacao: 0, total: 2 });
  assert.equal(r.j.totais.folhasAtrasadas, 1); assert.equal(r.j.totais.folhasEmDia, 1);
  assert.ok(!r.j.equipamentos.some(x => x.codigo === 'FTD98'), 'tanque sem válvula e fora dos locais das preventivas não entra');
});
