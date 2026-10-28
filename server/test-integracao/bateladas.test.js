'use strict';
// PCM · Bateladas (migration 32) contra PostgreSQL real: apontamento do técnico, histórico da planilha,
// ligação com a folha de diafragmas e fila do SharePoint. Dados inventados (nenhum número real da planta).
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h, U;
const API = '/api/pcm/bateladas';
const pad = n => String(n).padStart(2, '0');
const dia = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
test.before(async () => { h = await subirApp({ tec: 'tecnico', tec2: 'tecnico', lider: 'lider', pcm: 'pcm', almox: 'almoxarife' }); U = h.users; });
test.after(() => h?.fechar());

async function tanques() { const r = await h.api(U.tec, 'GET', `${API}/apontamento?data=${dia()}`); return Object.fromEntries(r.j.tanques.map(t => [t.codigo, t])); }
const aponta = (u, data, valores) => h.api(u, 'PUT', `${API}/apontamento`, { data, valores });

test('os 34 tanques das folhas de diafragma são os tanques das bateladas; almoxarife não acessa', async () => {
  const t = await tanques();
  assert.equal(Object.keys(t).length, 34);
  assert.ok(t.FTD01 && t.PGD15 && t.BLD05);
  assert.equal((await h.api(U.almox, 'GET', `${API}/painel`)).s, 403);
});

test('PCM importa o histórico da planilha; técnico não; só os dias em que o contador mudou viram linha', async () => {
  const leituras = [];
  for (let k = 40; k >= 1; k--) {
    leituras.push({ tanque: 'FTD 01', data: dia(-k), acumulado: 100 + Math.floor((40 - k) / 3) });   // +1 a cada 3 dias
    leituras.push({ tanque: 'BLR 02', data: dia(-k), acumulado: 140 });
  }
  const body = { leituras, preventivas: [{ tanque: 'FTD-001', data: dia(-30) }, { tanque: 'XYZ-9', data: dia(-1) }], programacao: [{ tanque: 'FTD 01', inicio: dia(5), fim: dia(6), situacao: 'PROGRAMADO' }] };
  assert.equal((await h.api(U.tec, 'POST', `${API}/importar`, body)).s, 403);
  const r = await h.api(U.pcm, 'POST', `${API}/importar`, body);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.leituras, 14 + 1, 'FTD01 muda 14 vezes (13 + o primeiro dia); BLR02 só o primeiro');
  assert.equal(r.j.preventivas, 1);
  assert.equal(r.j.totalRecusadas, 1, 'tanque inexistente é recusado com o motivo');
  assert.equal((await h.q('SELECT count(*)::int n FROM pcm.batelada_sharepoint')).rows[0].n, 0, 'histórico importado não vai para o SharePoint (já está lá)');
  const p = (await h.api(U.pcm, 'GET', `${API}/painel`)).j.ativos.find(a => a.codigo === 'FTD01');
  assert.equal(p.acumulado, 113);
  assert.equal(p.desdePreventiva, 113 - 103, 'contador atual − contador na data da preventiva');
  assert.equal(p.programacao.situacao, 'PROGRAMADO');
});

test('técnico aponta o contador do dia com as travas do horímetro', async () => {
  let r = await aponta(U.tec, dia(), [{ ativoId: (await tanques()).FTD01.id, acumulado: 112 }]);
  assert.equal(r.s, 409); assert.match(r.j.erro, /só aumenta. Ele já está em 113/);
  r = await aponta(U.tec, dia(), [{ ativoId: (await tanques()).FTD01.id, acumulado: 140 }]);
  assert.equal(r.s, 400); assert.match(r.j.erro, /erro de digitação/);
  r = await aponta(U.tec, dia(1), [{ ativoId: (await tanques()).FTD01.id, acumulado: 114 }]);
  assert.equal(r.s, 400, 'dia que ainda não chegou');
  r = await aponta(U.tec, dia(-10), [{ ativoId: (await tanques()).PGD01.id, acumulado: 5 }]);
  assert.equal(r.s, 403, 'técnico só aponta até 7 dias atrás');
  r = await aponta(U.tec, dia(), [{ ativoId: (await tanques()).FTD01.id, acumulado: 115 }, { ativoId: (await tanques()).PGD01.id, acumulado: 3 }]);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const t = await tanques();
  assert.equal(t.FTD01.noDia, 115);
  assert.equal(t.FTD01.noDiaPor, 'Pessoa tec', 'quem apontou vem da sessão');
  const fila = (await h.q('SELECT data FROM pcm.batelada_sharepoint WHERE pendente')).rows;
  assert.equal(fila.length, 1, 'o dia apontado entra na fila do SharePoint');
  r = await aponta(U.pcm, dia(-10), [{ ativoId: t.PGD02.id, acumulado: 7 }]);
  assert.equal(r.s, 200, 'PCM corrige dias antigos');
  assert.equal((await h.q('SELECT count(*)::int n FROM pcm.batelada_sharepoint WHERE pendente')).rows[0].n, 11, 'corrigir um dia antigo reenvia ele e os seguintes');
  const linha = (await h.q("SELECT * FROM pcm.batelada_contadores_em($1) WHERE codigo IN ('FTD01','PGD02')", [dia()])).rows;
  assert.deepEqual(Object.fromEntries(linha.map(x => [x.codigo, x.acumulado])), { FTD01: 115, PGD02: 7 }, 'o que vai para a lista do SharePoint');
});

test('folha de diafragmas concluída zera a contagem desde a preventiva', async () => {
  const ftd = (await h.q("SELECT id FROM pcm.ativo WHERE codigo='FTD01'")).rows[0].id;
  await h.q(`INSERT INTO pcm.preventiva (ativo_id, numero_om, data_prevista, status, concluida_em, concluida_por_nome) VALUES ($1,'OM00000001',$2,'concluida',now(),'Teste')`, [ftd, dia()]);
  const p = (await h.api(U.tec, 'GET', `${API}/painel`)).j.ativos.find(a => a.codigo === 'FTD01');
  assert.equal(p.ultimaPreventiva.fonte, 'folha');
  assert.equal(p.desdePreventiva, 0);
  assert.equal(p.faixa, 'ok');
});

test('alerta em 18 (FTD/PGD) e 30 (blenders); só a gestão registra preventiva e vê a fila do SharePoint', async () => {
  const t = await tanques();
  await aponta(U.pcm, dia(-2), [{ ativoId: t.PGD05.id, acumulado: 10 }]);
  await aponta(U.pcm, dia(-1), [{ ativoId: t.PGD05.id, acumulado: 18 }]);
  await aponta(U.pcm, dia(), [{ ativoId: t.PGD05.id, acumulado: 28 }]);
  const painel = (await h.api(U.pcm, 'GET', `${API}/painel`)).j;
  assert.equal(painel.ativos.find(a => a.codigo === 'PGD05').faixa, 'vencido', '28 bateladas sem preventiva ≥ 18');
  assert.equal(painel.ativos.find(a => a.codigo === 'BLD02').desdePreventiva, 0, 'contador parado em 140 desde o começo do histórico: não são 140 bateladas novas');
  assert.equal(painel.mensal.reduce((n, m) => n + (m.porAtivo.BLD02 || 0), 0), 0, 'o primeiro mês do histórico não soma o contador inteiro');
  assert.equal((await h.api(U.tec, 'POST', `${API}/preventivas`, { ativoId: t.PGD05.id, data: dia() })).s, 403);
  assert.equal((await h.api(U.pcm, 'POST', `${API}/preventivas`, { ativoId: t.PGD05.id, data: dia(-1), observacao: 'Troca dos diafragmas' })).s, 201);
  const pg = (await h.api(U.pcm, 'GET', `${API}/painel`)).j.ativos.find(a => a.codigo === 'PGD05');
  assert.equal(pg.desdePreventiva, 10, 'conta a partir do contador do dia da preventiva');
  assert.equal((await h.api(U.tec, 'GET', `${API}/sharepoint`)).s, 403);
  const sp = await h.api(U.pcm, 'GET', `${API}/sharepoint`);
  assert.ok(sp.j.pendentes > 0);
  const hist = await h.api(U.lider, 'GET', `${API}/historico?de=${dia(-2)}&ate=${dia()}`);
  assert.deepEqual(hist.j.dias.map(d => d.bateladas.PGD05), [10, 8, 10]);
});

test('várias pessoas no mesmo dia: ninguém diminui o que outro apontou; o PCM corrige com justificativa', async () => {
  const t = await tanques(), id = t.FTD10.id;
  let r = await aponta(U.tec, dia(), [{ ativoId: id, acumulado: 3 }]);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.tanques.find(x => x.codigo === 'FTD10').noDia, 3, 'a resposta já traz o estado novo do dia');
  r = await aponta(U.tec2, dia(), [{ ativoId: id, acumulado: 2 }]);
  assert.equal(r.s, 409, 'o segundo técnico não pode baixar o que o primeiro apontou');
  assert.match(r.j.erro, /já está em 3 \(apontado por Pessoa tec às/);
  r = await aponta(U.tec2, dia(), [{ ativoId: id, acumulado: 4 }]);
  assert.equal(r.s, 200, 'aumentar pode');
  const nomes = r.j.pessoas.map(p => p.nome);
  assert.ok(nomes.includes('Pessoa tec') && nomes.includes('Pessoa tec2'), 'a tela mostra quem já apontou no dia: ' + nomes);
  r = await aponta(U.pcm, dia(), [{ ativoId: id, acumulado: 1 }]);
  assert.equal(r.s, 400, 'o PCM diminui só com justificativa');
  assert.match(r.j.erro, /justificativa/);
  r = await aponta(U.pcm, dia(), [{ ativoId: id, acumulado: 1, motivo: 'Técnico digitou o contador do FTD 01' }]);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.corrigidos, 1);
  assert.deepEqual(r.j.correcoes.map(c => [c.codigo, c.de, c.para]), [['FTD10', 4, 1]], 'a correção fica na trilha');
  // a trava também está no banco: técnico não diminui nem apaga contornando a API
  await assert.rejects(h.transaction(U.tec, c => c.query('UPDATE pcm.batelada_leitura SET acumulado = 0 WHERE ativo_id=$1', [id])), /só aumenta/);
  await assert.rejects(h.transaction(U.tec, c => c.query('DELETE FROM pcm.batelada_leitura WHERE ativo_id=$1', [id])), /Só o PCM apaga/);
  r = await h.api(U.tec, 'GET', `${API}/apontamento?data=${dia()}`);
  assert.equal(r.j.podeCorrigir, false);
  assert.equal(r.j.tanques.find(x => x.codigo === 'FTD10').ult7.length, 7, 'minigráfico dos últimos 7 dias');
});

test('abas da planilha: gás/diafragma por tanque e preventivas dos EBAs (só a gestão grava; a equipe lê)', async () => {
  // leitura: equipe vê, almoxarife não
  let r = await h.api(U.tec, 'GET', `${API}/extras`);
  assert.equal(r.s, 200); assert.deepEqual(r.j.tarefas, []); assert.deepEqual(r.j.eba, []);
  assert.equal(r.j.podeGerir, false);
  assert.equal((await h.api(U.almox, 'GET', `${API}/extras`)).s, 403);
  // gravação: técnico não
  assert.equal((await h.api(U.tec, 'PUT', `${API}/tarefas`, { tanque: 'FTD 01', tipo: 'gas_out', feito: true })).s, 403);
  assert.equal((await h.api(U.tec, 'PUT', `${API}/eba`, { equipamento: 'EBA-003', data: dia(-3), frequencia: 'S', realizada: true })).s, 403);
  // tarefas
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/tarefas`, { tanque: 'FTD 01', tipo: 'gas_out', feito: true })).s, 200);
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/tarefas`, { tanque: 'PGD-002', tipo: 'diafragma_amostra', feito: true })).s, 200);
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/tarefas`, { tanque: 'FTD 01', tipo: 'outra', feito: true })).s, 400, 'tipo desconhecido');
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/tarefas`, { tanque: 'XYZ 01', tipo: 'gas_out', feito: true })).s, 400);
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/tarefas`, { tanque: 'FTD 01', tipo: 'gas_out', feito: false })).s, 200, 'desmarcar atualiza a mesma linha');
  r = await h.api(U.tec, 'GET', `${API}/extras`);
  assert.deepEqual(r.j.tarefas.map(t => [t.codigo, t.tipo, t.feito]), [['FTD01', 'gas_out', false], ['PGD02', 'diafragma_amostra', true]]);
  // EBAs: realizada no passado, programada no futuro; realizada no futuro é recusada
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/eba`, { equipamento: 'EBA 3', data: dia(-10), frequencia: 'S', realizada: true })).s, 200, 'EBA 3 vira EBA-003');
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/eba`, { equipamento: 'EBA-004', data: dia(20), frequencia: 'M' })).s, 200);
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/eba`, { equipamento: 'EBA-004', data: dia(20), frequencia: 'T' })).s, 200, 'mesmo dia: atualiza');
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/eba`, { equipamento: 'EBA-004', data: dia(5), frequencia: 'S', realizada: true })).s, 400, 'realizada no futuro');
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/eba`, { equipamento: 'BOMBA-1', data: dia(-1), frequencia: 'S' })).s, 400);
  assert.equal((await h.api(U.pcm, 'PUT', `${API}/eba`, { equipamento: 'EBA-003', data: dia(-1), frequencia: 'X' })).s, 400);
  r = await h.api(U.lider, 'GET', `${API}/extras`);
  assert.deepEqual(r.j.eba.map(e => [e.equipamento, e.data, e.frequencia, e.realizada]), [['EBA-003', dia(-10), 'S', true], ['EBA-004', dia(20), 'T', false]]);
  assert.equal((await h.api(U.tec, 'DELETE', `${API}/eba/${r.j.eba[0].id}`)).s, 403);
  assert.equal((await h.api(U.pcm, 'DELETE', `${API}/eba/${r.j.eba[0].id}`)).s, 200);
  assert.equal((await h.api(U.pcm, 'DELETE', `${API}/eba/nao-e-uuid`)).s, 400);
  assert.equal((await h.api(U.tec, 'GET', `${API}/extras`)).j.eba.length, 1);
});

test('importação da planilha: semanas do calendário entram como preventiva não exata; tarefas e EBAs vêm junto; reimportar não duplica', async () => {
  const body = {
    leituras: [],
    preventivas: [{ tanque: 'PGD 05', data: dia(-60), exata: false }, { tanque: 'PGD-005', data: dia(-20) }],
    tarefas: [{ tanque: 'FTD 02', tipo: 'gas_out', feito: true }, { tanque: 'FTD 02', tipo: 'invalida', feito: true }],
    eba: [{ equipamento: 'EBA-003', data: dia(-30), frequencia: 'M', realizada: true }, { equipamento: 'EBA-003', data: dia(15), frequencia: 'S', realizada: true }, { equipamento: 'EBA-009', data: 'ontem', frequencia: 'S' }]
  };
  assert.equal((await h.api(U.tec, 'POST', `${API}/importar`, body)).s, 403);
  let r = await h.api(U.pcm, 'POST', `${API}/importar`, body);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.preventivas, 2); assert.equal(r.j.tarefas, 1); assert.equal(r.j.eba, 2);
  assert.equal(r.j.totalRecusadas, 2, 'tarefa de tipo desconhecido e EBA com data inválida');
  const ev = (await h.api(U.pcm, 'GET', `${API}/painel`)).j.ativos.find(a => a.codigo === 'PGD05').preventivas;
  assert.deepEqual(ev.filter(e => [dia(-20), dia(-60)].includes(e.data)).map(e => [e.data, e.exata]), [[dia(-20), true], [dia(-60), false]], 'a semana (sem data certa) fica marcada como não exata');
  const eb = (await h.api(U.pcm, 'GET', `${API}/extras`)).j.eba.filter(e => e.equipamento === 'EBA-003' && e.origem === 'planilha');
  assert.deepEqual(eb.map(e => [e.data, e.realizada]), [[dia(-30), true], [dia(15), false]], 'realizada no futuro vira programada');
  r = await h.api(U.pcm, 'POST', `${API}/importar`, body);
  assert.equal(r.j.preventivas, 0); assert.equal(r.j.eba, 0, 'reimportar não duplica');
  // o que o PCM marcou no site não é sobrescrito pela planilha
  await h.api(U.pcm, 'PUT', `${API}/tarefas`, { tanque: 'FTD 02', tipo: 'gas_out', feito: false });
  await h.api(U.pcm, 'POST', `${API}/importar`, body);
  assert.equal((await h.api(U.pcm, 'GET', `${API}/extras`)).j.tarefas.find(t => t.codigo === 'FTD02').feito, false);
});

test('extras: RLS impede UPDATE/DELETE/INSERT direto do técnico e permite PCM', async () => {
  const id = (await h.q("SELECT id FROM pcm.ativo WHERE codigo='FTD03'")).rows[0].id;
  await h.transaction(U.pcm, c => c.query("INSERT INTO pcm.batelada_tarefa(ativo_id,tipo,feito) VALUES($1,'gas_out',false)", [id]));
  const eba = await h.transaction(U.pcm, c => c.query("INSERT INTO pcm.eba_preventiva(equipamento,data,frequencia) VALUES('EBA-099',$1,'S') RETURNING id", [dia(-2)]));
  for (const [table, key, value, change] of [['batelada_tarefa', 'ativo_id', id, 'feito=true'], ['eba_preventiva', 'id', eba.rows[0].id, "frequencia='M'"]]) {
    assert.equal((await h.transaction(U.tec, c => c.query(`UPDATE pcm.${table} SET ${change} WHERE ${key}=$1`, [value]))).rowCount, 0);
    assert.equal((await h.transaction(U.tec, c => c.query(`DELETE FROM pcm.${table} WHERE ${key}=$1`, [value]))).rowCount, 0);
    assert.equal((await h.transaction(U.pcm, c => c.query(`UPDATE pcm.${table} SET ${change} WHERE ${key}=$1`, [value]))).rowCount, 1);
  }
  await assert.rejects(h.transaction(U.tec, c => c.query("INSERT INTO pcm.batelada_tarefa(ativo_id,tipo) VALUES($1,'diafragma_amostra')", [id])), /row-level security/i);
  await assert.rejects(h.transaction(U.tec, c => c.query("INSERT INTO pcm.eba_preventiva(equipamento,data,frequencia) VALUES('EBA-098',$1,'S')", [dia(-2)])), /row-level security/i);
});

test('reaplicar migration 38 e todas as migrations conserva extras sintéticos e políticas UPDATE', async () => {
  const fs = require('node:fs'), path = require('node:path'), dir = path.resolve(__dirname, '../../database/migrations');
  const snapshot = async () => ({ tarefas: (await h.q('SELECT * FROM pcm.batelada_tarefa ORDER BY ativo_id,tipo')).rows, eba: (await h.q('SELECT * FROM pcm.eba_preventiva ORDER BY id')).rows });
  const antes = await snapshot(); assert.ok(antes.tarefas.length && antes.eba.length);
  await h.db.exec(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.startsWith('38-'))), 'utf8'));
  assert.deepEqual(await snapshot(), antes);
  for (const f of fs.readdirSync(dir).filter(f => /^\d.*\.sql$/.test(f)).sort()) await h.db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.deepEqual(await snapshot(), antes);
  assert.equal((await h.transaction(U.tec, c => c.query('UPDATE pcm.batelada_tarefa SET feito=false'))).rowCount, 0);
  assert.equal((await h.transaction(U.tec, c => c.query("UPDATE pcm.eba_preventiva SET frequencia='T'"))).rowCount, 0);
  assert.equal((await h.transaction(U.pcm, c => c.query("UPDATE pcm.eba_preventiva SET frequencia=frequencia"))).rowCount, antes.eba.length);
});
