'use strict';
// Step-up (2FA recente) nas ações administrativas: modo de teste, cadastros e aprovação do inventário.
// Middleware VERDADEIRO (h.passoExtra.exigir = true), banco real (PGlite) sob RLS. Pessoas fictícias "@teste.biotrop".
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { subirApp } = require('./_harness');

let h, U, totp, config, createSession;
const SID = {};
test.before(async () => {
  h = await subirApp({ adm: 'admin', ges: 'gestor', alm: 'almoxarife', pcm: 'pcm', tec: 'tecnico', sem2fa: 'admin' });
  h.passoExtra.exigir = true;
  U = h.users;
  totp = require('../src/auth/totp'); config = require('../src/config'); ({ createSession } = require('../src/auth/session'));
  // todos com 2FA ativo, menos "sem2fa"
  for (const k of ['adm', 'ges', 'alm', 'pcm', 'tec']) await h.q('UPDATE core.usuario SET totp_ativo=true WHERE id=$1', [U[k].id]);
  for (const k of Object.keys(U)) SID[k] = crypto.randomBytes(12).toString('base64url');
});
test.after(() => h?.fechar());

/** Sessão fixa por pessoa (o step-up é vinculado ao sid); passo: 'ok' (confirmado agora), 'vencido' (11 min atrás) ou nada. */
function cookie(k, passo, sid = SID[k]) {
  const u = U[k];
  let c = `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv, sid }).valor}`;
  if (passo === 'ok') c += `; biotrop_2fa=${totp.signStepUp(`${u.id}:${SID[k]}`, config.twofaKey, 10)}`;
  if (passo === 'vencido') c += `; biotrop_2fa=${totp.signStepUp(`${u.id}:${SID[k]}`, config.twofaKey, 10, Date.now() - 11 * 60000)}`;
  return c;
}
async function req(k, method, url, body, passo, sid) {
  const r = await fetch(h.raiz + url, { method, headers: { cookie: cookie(k, passo, sid), origin: 'http://localhost:3000', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j, setCookie: r.headers.getSetCookie?.() || [] };
}
const pediu = r => r.s === 403 && r.j?.precisa2fa === true;
const UUID0 = '00000000-0000-4000-8000-000000000001';

// [grupo, pessoa, método, url, corpo]
const PROTEGIDAS = [
  ['simulação', 'adm', 'POST', '/api/admin/simulacao/iniciar', { quantidades: { tecnico: 1 }, minutos: 0.1 }],
  ['simulação', 'adm', 'POST', '/api/admin/simulacao/limpar', {}],
  ['cadastro mestre', 'alm', 'POST', '/api/master-data?resource=lista&list=scm_urgencia', { codigo: 'teste-stepup', nome: '[TESTE] step-up' }],
  ['cadastro mestre', 'alm', 'DELETE', '/api/master-data?resource=lista&list=scm_urgencia&id=' + UUID0, undefined],
  ['catálogo almox', 'alm', 'PUT', '/api/almox/materiais/MANTESTE1', { descricao: '[TESTE] item' }],
  ['catálogo almox', 'alm', 'POST', '/api/almox/materiais/importar', { linhas: [{ codigo: 'MANTESTE2', descricao: '[TESTE] item 2' }] }],
  ['catálogo almox', 'alm', 'DELETE', '/api/almox/materiais/MANTESTE1/fotos/' + UUID0, undefined],
  ['cadastro PCM', 'pcm', 'POST', '/api/pcm/preventivas/equipamentos', { codigo: 'TST01', nome: '[TESTE] equipamento' }],
  ['cadastro PCM', 'pcm', 'POST', '/api/pcm/preventivas/importar', { folhas: [] }],
  ['cadastro PCM', 'pcm', 'POST', '/api/pcm/preventivas/importar', { folhas: [], simular: false }],
  ['cadastro PCM', 'pcm', 'POST', '/api/pcm/bateladas/importar', {}],
  ['bateladas', 'pcm', 'POST', '/api/pcm/bateladas/preventivas', {}],
  ['bateladas', 'pcm', 'DELETE', '/api/pcm/bateladas/preventivas/' + UUID0, undefined],
  ['bateladas', 'pcm', 'DELETE', '/api/pcm/bateladas/eba/' + UUID0, undefined],
  ['ferramentas', 'alm', 'POST', '/api/emprestimo/ferramentas', { codigo: 'TST-STEPUP', nome: '[TESTE] ferramenta' }],
  ['ferramentas', 'alm', 'PUT', '/api/emprestimo/ferramentas/' + UUID0, { nome: '[TESTE] ferramenta' }],
  ['ferramentas', 'alm', 'POST', `/api/emprestimo/ferramentas/${UUID0}/ajustes`, {}],
  ['config empréstimo', 'alm', 'PUT', '/api/emprestimo/config', {}],
  ['config avisos', 'ges', 'PUT', '/api/emprestimo/avisos/config', {}],
  ['usuários (terminal)', 'alm', 'POST', '/api/emprestimo/colaboradores', { nome: '[TESTE] Pessoa', email: 'pessoa.stepup@teste.biotrop', matricula: 'T-9001' }],
  ['usuários (terminal)', 'alm', 'POST', `/api/emprestimo/colaboradores/${UUID0}/convite`, {}],
  ['usuários (terminal)', 'alm', 'POST', `/api/emprestimo/colaboradores/${UUID0}/acesso`, { bloqueado: false, justificativa: 'teste' }],
  ['inventário', 'alm', 'POST', `/api/inventario/itens/${UUID0}/justificativas`, { texto: '[TESTE] divergência' }],
  ['inventário', 'ges', 'POST', `/api/inventario/campanhas/${UUID0}/fechar`, { observacao: '[TESTE]' }]
];

test('cada rota administrativa recusa sem step-up e passa do portão com ele', async () => {
  for (const [grupo, k, m, url, body] of PROTEGIDAS) {
    const sem = await req(k, m, url, body);
    assert.ok(pediu(sem), `${grupo} ${m} ${url} sem step-up: ${sem.s} ${JSON.stringify(sem.j)}`);
    assert.equal(sem.j.configurar2fa, undefined, 'tem 2FA: pede só o código');
    if (url.endsWith('/iniciar')) continue;   // com step-up iniciaria uma simulação de verdade
    const com = await req(k, m, url, body, 'ok');
    assert.ok(!pediu(com), `${grupo} ${m} ${url} com step-up ainda pediu: ${com.s} ${JSON.stringify(com.j)}`);
  }
});

test('com step-up a gravação acontece de fato (lista da SCM)', async () => {
  let r = await req('alm', 'POST', '/api/master-data?resource=lista&list=scm_urgencia', { codigo: 'teste-stepup-2', nome: '[TESTE] step-up 2' }, 'ok');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.ok((await h.q(`SELECT 1 FROM core.lista_catalogo WHERE lista='scm_urgencia' AND nome='[TESTE] step-up 2'`)).rows.length);
});

test('step-up obtido pelo fluxo real (/api/conta/2fa/verificar) libera a ação na mesma sessão, e só nela', async () => {
  const { cifrarSegredo2fa } = require('../src/crypto/pessoais');
  const segredo = totp.generateSecret();
  await h.q('UPDATE core.usuario SET totp_segredo=$2, totp_ativo=true, totp_ultimo_passo=0 WHERE id=$1', [U.ges.id, await cifrarSegredo2fa(U.ges.id, segredo)]);
  const v = await req('ges', 'POST', '/api/conta/2fa/verificar', { codigo: totp.codeAt(segredo, totp.stepAt()) });
  assert.equal(v.s, 200, JSON.stringify(v.j));
  const passo = v.setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('biotrop_2fa='));
  assert.ok(passo, 'cookie do step-up emitido');
  const ir = (sid) => fetch(h.raiz + '/api/master-data?resource=lista&list=scm_urgencia', { method: 'POST',
    headers: { cookie: `biotrop_session=${createSession({ id: U.ges.id, sessaoVersao: U.ges.sv, sid }).valor}; ${passo}`, origin: 'http://localhost:3000', 'content-type': 'application/json' },
    body: JSON.stringify({ codigo: 'teste-stepup-3', nome: '[TESTE] step-up 3' }) });
  assert.equal((await ir(SID.ges)).status, 200, 'mesma sessão');
  const outra = await ir('outra-sessao');
  assert.equal(outra.status, 403, 'cookie de step-up levado para outra sessão não vale');
  assert.equal((await outra.json()).precisa2fa, true);
});

test('a janela de 10 minutos expira', async () => {
  const r = await req('alm', 'POST', '/api/master-data?resource=lista&list=scm_urgencia', { codigo: 'teste-stepup-4', nome: '[TESTE] 4' }, 'vencido');
  assert.ok(pediu(r), `${r.s} ${JSON.stringify(r.j)}`);
  const f = await req('ges', 'POST', `/api/inventario/campanhas/${UUID0}/fechar`, {}, 'vencido');
  assert.ok(pediu(f), `${f.s} ${JSON.stringify(f.j)}`);
});

test('sem 2FA ativo: a ação administrativa pede para ativar antes (configurar2fa), e o cadastro do 2FA continua aberto', async () => {
  const r = await req('sem2fa', 'POST', '/api/master-data?resource=lista&list=scm_urgencia', { codigo: 'teste-stepup-5', nome: '[TESTE] 5' });
  assert.equal(r.s, 403);
  assert.equal(r.j.precisa2fa, true); assert.equal(r.j.configurar2fa, true);
  // saída: ativar é autoatendimento (login recente) e não passa pelo step-up
  const ini = await req('sem2fa', 'POST', '/api/conta/2fa/iniciar', {});
  assert.equal(ini.s, 200, JSON.stringify(ini.j));
  assert.ok(ini.j.segredo && ini.j.qr);
  // o resto do sistema segue aberto para ele
  assert.equal((await req('sem2fa', 'GET', '/api/master-data?resource=camm')).s, 200);
});

test('rotina e leitura não pedem step-up', async () => {
  // SCI do técnico, leitura de utilidade, contagem do inventário, apontamento de batelada, parar a simulação, bloquear acesso
  const rot = [
    ['tec', 'PUT', '/api/data/sci/SCI-STEPUP-1', { expectedVersion: 0, payload: { id: 'SCI-STEPUP-1', codigo: 'SCI-T', solicitanteId: U.tec.id, solicitanteNome: '[TESTE]',
      status: 'aberto', familia: 'Outros', descricao: '[TESTE] item fictício' } }],
    ['tec', 'POST', `/api/inventario/itens/${UUID0}/contagens`, { quantidade: '1', expectedVersion: 1 }],
    ['tec', 'PUT', '/api/pcm/bateladas/apontamento', { data: '2000-01-01', leituras: [] }],
    // planejamento do dia a dia do PCM (bateladas): programação, gás/diafragma e marca do EBA ficam sem código
    ['pcm', 'PUT', '/api/pcm/bateladas/programacao/' + UUID0, {}],
    ['pcm', 'PUT', '/api/pcm/bateladas/tarefas', {}],
    ['pcm', 'PUT', '/api/pcm/bateladas/eba', {}],
    ['adm', 'POST', '/api/admin/simulacao/parar', {}],
    ['alm', 'POST', `/api/emprestimo/colaboradores/${UUID0}/acesso`, { bloqueado: true, justificativa: 'teste' }],
    ['alm', 'GET', '/api/almox/materiais', undefined],
    ['ges', 'GET', '/api/inventario/campanhas', undefined]
  ];
  for (const [k, m, url, body] of rot) {
    const r = await req(k, m, url, body);
    assert.ok(!pediu(r), `${m} ${url} pediu step-up: ${r.s} ${JSON.stringify(r.j)}`);
  }
  const sci = await req('tec', 'GET', '/api/data/sci');
  assert.ok(sci.j.rows.some(x => x.recordId === 'SCI-STEPUP-1'), 'SCI gravada sem step-up');
});

test('prévia da importação de folhas (simular: true) não grava e não pede código; a importação real pede', async () => {
  const folhas = [{ equipamento: 'TST99', data: '2000-01-01', valvulas: [] }];   // equipamento fictício, inexistente: relatório com erro
  const previa = await req('pcm', 'POST', '/api/pcm/preventivas/importar', { folhas, simular: true });
  assert.equal(previa.s, 200, JSON.stringify(previa.j));
  assert.equal(previa.j.simulado, true);
  assert.equal(previa.j.relatorio.length, 1);
  assert.ok(pediu(await req('pcm', 'POST', '/api/pcm/preventivas/importar', { folhas })), 'importação real sem step-up');
  assert.ok(pediu(await req('pcm', 'POST', '/api/pcm/preventivas/importar', { folhas, simular: 'true' })), 'só o booleano true é prévia');
  const real = await req('pcm', 'POST', '/api/pcm/preventivas/importar', { folhas }, 'ok');
  assert.equal(real.s, 200, JSON.stringify(real.j)); assert.equal(real.j.simulado, false);
});

test('com step-up a exclusão da marca de EBA acontece de fato; sem ele, nada é apagado', async () => {
  const id = (await h.q(`INSERT INTO pcm.eba_preventiva (equipamento, data, frequencia, realizada, origem, registrado_por_nome)
    VALUES ('EBA-901', '2000-01-03', 'S', true, 'site', '[TESTE] step-up') RETURNING id`)).rows[0].id;
  assert.ok(pediu(await req('pcm', 'DELETE', '/api/pcm/bateladas/eba/' + id)));
  assert.equal((await h.q('SELECT 1 FROM pcm.eba_preventiva WHERE id=$1', [id])).rows.length, 1, 'sem step-up continua lá');
  const r = await req('pcm', 'DELETE', '/api/pcm/bateladas/eba/' + id, undefined, 'ok');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await h.q('SELECT 1 FROM pcm.eba_preventiva WHERE id=$1', [id])).rows.length, 0);
});

test('perfil que a rota recusa recebe o 403 da rota, não o pedido de código', async () => {
  for (const [m, url, body] of [
    ['POST', '/api/master-data?resource=lista&list=scm_urgencia', { codigo: 'x', nome: 'x' }],
    ['POST', `/api/inventario/campanhas/${UUID0}/fechar`, {}],
    ['POST', '/api/pcm/preventivas/equipamentos', { codigo: 'X', nome: 'x' }]
  ]) {
    const r = await req('tec', m, url, body);
    assert.equal(r.s, 403, `${m} ${url}`); assert.equal(r.j.precisa2fa, undefined, `${m} ${url}: ${JSON.stringify(r.j)}`);
  }
});
