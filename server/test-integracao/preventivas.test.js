'use strict';
// PCM · Preventivas de diafragma: concluir com válvulas vazias e importar folhas transcritas — sob o RLS de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h;
test.before(async () => { h = await subirApp({ tec: 'tecnico', pcm: 'pcm', almox: 'almoxarife' }); });
test.after(() => h?.fechar());

const API = '/api/pcm/preventivas';
const ativo = async codigo => (await h.q('SELECT id FROM pcm.ativo WHERE codigo=$1', [codigo])).rows[0].id;

test('folha conclui com válvulas vazias só com confirmação; pela metade nunca', async () => {
  let r = await h.api(h.users.pcm, 'POST', `${API}/preventivas`, { ativoId: await ativo('FTD02'), dataPrevista: '2026-09-01' });
  assert.equal(r.s, 201, JSON.stringify(r.j));
  const f = r.j.preventiva, [a, b] = f.itens;
  r = await h.api(h.users.tec, 'PUT', `${API}/preventivas/${f.id}/itens`, { itens: [{ id: a.id, trocado: true, vida: 2 }, { id: b.id, trocado: false }] });
  assert.equal(r.s, 200);
  r = await h.api(h.users.tec, 'POST', `${API}/preventivas/${f.id}/concluir`, { vazias: true });
  assert.equal(r.s, 400, 'válvula pela metade (só Trocado) bloqueia');
  assert.match(r.j.erro, /pela metade/);
  r = await h.api(h.users.tec, 'PUT', `${API}/preventivas/${f.id}/itens`, { itens: [{ id: b.id, trocado: null }] });
  r = await h.api(h.users.tec, 'POST', `${API}/preventivas/${f.id}/concluir`, {});
  assert.equal(r.s, 409, 'sem confirmar, avisa quantas ficam vazias');
  assert.equal(r.j.vazias, f.itens.length - 1);
  r = await h.api(h.users.tec, 'POST', `${API}/preventivas/${f.id}/concluir`, { vazias: true });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.preventiva.status, 'concluida');
  assert.ok(r.j.preventiva.observacoes.some(o => /vazia\(s\), não feitas/.test(o.texto)), 'registra quais ficaram vazias');
});

test('folha sem nenhuma válvula preenchida não conclui (cancela-se)', async () => {
  let r = await h.api(h.users.pcm, 'POST', `${API}/preventivas`, { ativoId: await ativo('FTD03'), dataPrevista: '2026-09-02' });
  r = await h.api(h.users.tec, 'POST', `${API}/preventivas/${r.j.preventiva.id}/concluir`, { vazias: true });
  assert.equal(r.s, 400);
  assert.match(r.j.erro, /cancele/);
});

test('importação de folhas transcritas: simula, grava, pula repetida e não deixa folha pela metade', async () => {
  const tags = (await h.q(`SELECT ci.tag, ci.posicao FROM pcm.checklist_item ci JOIN pcm.ativo a ON a.id=ci.ativo_id
    WHERE a.codigo='PGD04' AND ci.ativo ORDER BY ci.posicao LIMIT 3`)).rows;
  const folhas = [
    { equipamento: 'PGD-004', data: '15/09/2026', om: '50001', tecnico: 'Técnico do Papel',
      valvulas: [{ tag: tags[0].tag.replace(/\s+/g, ''), trocado: 'S', vida: 1 }, { posicao: tags[1].posicao, trocado: 'N', vida: 3, obs: 'ok' }, { tag: 'XX-999', trocado: 'S', vida: 1 }] },
    { equipamento: 'ZZZ-1', data: '2026-09-15', valvulas: [{ tag: 'A', trocado: 'S', vida: 1 }] },
    { equipamento: 'PGD04', data: '2030-01-01', valvulas: [{ tag: tags[0].tag, trocado: 'S', vida: 1 }] }
  ];
  const antes = (await h.q('SELECT count(*)::int n FROM pcm.preventiva')).rows[0].n;
  let r = await h.api(h.users.pcm, 'POST', `${API}/importar`, { folhas, simular: true });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.simulado, true);
  assert.deepEqual(r.j.resumo, { criadas: 1, preenchidas: 0, jaExistiam: 0, erros: 2 });
  assert.equal((await h.q('SELECT count(*)::int n FROM pcm.preventiva')).rows[0].n, antes, 'simulação não grava nada');

  r = await h.api(h.users.pcm, 'POST', `${API}/importar`, { folhas });
  assert.equal(r.j.resumo.criadas, 1);
  const l = r.j.relatorio[0];
  assert.equal(l.equipamento, 'PGD04'); assert.equal(l.data, '2026-09-15'); assert.equal(l.feitas, 2);
  assert.ok(l.avisos.some(a => /XX-999/.test(a)), 'avisa válvula fora do prontuário');
  assert.match(r.j.relatorio[1].erro, /não existe/); assert.match(r.j.relatorio[2].erro, /futuro/);
  const f = (await h.q(`SELECT p.status, p.origem, p.numero_om, p.concluida_por_nome FROM pcm.preventiva p JOIN pcm.ativo a ON a.id=p.ativo_id
    WHERE a.codigo='PGD04' AND p.data_prevista='2026-09-15'`)).rows;
  assert.equal(f.length, 1, 'folha com erro não deixou nada');
  assert.equal(f[0].status, 'concluida'); assert.equal(f[0].origem, 'planilha'); assert.equal(f[0].numero_om, '50001');
  assert.match(f[0].concluida_por_nome, /Técnico do Papel · registrado por/);
  assert.equal((await h.q(`SELECT count(*)::int n FROM pcm.preventiva p JOIN pcm.ativo a ON a.id=p.ativo_id WHERE a.codigo IN ('ZZZ1','PGD04') AND p.data_prevista<>'2026-09-15' AND p.origem='planilha' AND p.lancada_por_nome LIKE '%importação%'`)).rows[0].n, 0);

  r = await h.api(h.users.pcm, 'POST', `${API}/importar`, { folhas: [folhas[0]] });
  assert.equal(r.j.resumo.jaExistiam, 1, 'reimportar o mesmo arquivo não duplica');
});

test('importação é só do PCM: técnico e almoxarifado não importam', async () => {
  const body = { folhas: [{ equipamento: 'PGD04', data: '2026-09-10', valvulas: [{ posicao: 1, trocado: 'S', vida: 1 }] }] };
  assert.equal((await h.api(h.users.tec, 'POST', `${API}/importar`, body)).s, 403);
  assert.equal((await h.api(h.users.almox, 'POST', `${API}/importar`, body)).s, 403);
});
