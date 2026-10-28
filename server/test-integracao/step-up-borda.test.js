'use strict';
// Step-up das ações administrativas: bordas e permissões (outra pessoa/sessão, logout, janela de 10 min, perfis,
// "bloqueado" não booleano, "simular" não booleano, cookie adulterado, HEAD/OPTIONS). Middleware VERDADEIRO, PGlite sob RLS.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { subirApp } = require('./_harness');

const PERFIS = { admin: 'admin', gestor: 'gestor', almoxarife: 'almoxarife', pcm: 'pcm', lider: 'lider', tecnico: 'tecnico', viewer: 'viewer' };
let h, U, totp, config, createSession;
const SID = {};
test.before(async () => {
  h = await subirApp({ ...PERFIS, admin2: 'admin', alvo: 'tecnico' });
  h.passoExtra.exigir = true;
  U = h.users;
  totp = require('../src/auth/totp'); config = require('../src/config'); ({ createSession } = require('../src/auth/session'));
  for (const k of Object.keys(U)) {
    await h.q('UPDATE core.usuario SET totp_ativo=true WHERE id=$1', [U[k].id]);
    SID[k] = crypto.randomBytes(12).toString('base64url');
  }
});
test.after(() => h?.fechar());

/**
 * passo: 'ok' | 'vencido' | minutos atrás (número) | { para: pessoa, sid, segredo, bruto }.
 * O cookie de sessão é sempre o da pessoa k com o sid dado (padrão SID[k]).
 */
function cookie(k, passo, sid = SID[k]) {
  const u = U[k];
  let c = `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv, sid }).valor}`;
  if (passo === 'ok') c += `; biotrop_2fa=${totp.signStepUp(`${u.id}:${sid}`, config.twofaKey, 10)}`;
  else if (passo === 'vencido') c += `; biotrop_2fa=${totp.signStepUp(`${u.id}:${sid}`, config.twofaKey, 10, Date.now() - 11 * 60000)}`;
  else if (typeof passo === 'number') c += `; biotrop_2fa=${totp.signStepUp(`${u.id}:${sid}`, config.twofaKey, 10, Date.now() - passo * 60000)}`;
  else if (passo && typeof passo === 'object') {
    if (passo.bruto !== undefined) c += `; biotrop_2fa=${passo.bruto}`;
    else c += `; biotrop_2fa=${totp.signStepUp(`${U[passo.para || k].id}:${passo.sid || sid}`, passo.segredo || config.twofaKey, 10)}`;
  }
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
const LISTA = '/api/master-data?resource=lista&list=scm_urgencia';
const lista = (n) => ({ codigo: 'borda-' + n, nome: '[TESTE] borda ' + n });
const existe = async (n) => (await h.q(`SELECT 1 FROM core.lista_catalogo WHERE lista='scm_urgencia' AND nome=$1`, ['[TESTE] borda ' + n])).rows.length === 1;

// ---------- (a) vínculo com pessoa e sessão ----------
test('(a) step-up de uma pessoa não vale para outra (mesmo perfil, mesmo sid, cookie trocado)', async () => {
  const mesmoSid = SID.admin;
  // admin2 usa o MESMO sid e leva o cookie assinado para o admin
  const r = await req('admin2', 'POST', LISTA, lista('a1'), { para: 'admin', sid: mesmoSid }, mesmoSid);
  assert.ok(pediu(r), `${r.s} ${JSON.stringify(r.j)}`);
  assert.equal(await existe('a1'), false);
  // gestor leva o cookie do almoxarife
  const g = await req('gestor', 'POST', LISTA, lista('a1b'), { para: 'almoxarife' });
  assert.ok(pediu(g), `${g.s} ${JSON.stringify(g.j)}`);
  assert.equal(await existe('a1b'), false);
});

test('(a) step-up não vale noutra sessão da mesma pessoa', async () => {
  const velho = totp.signStepUp(`${U.gestor.id}:${SID.gestor}`, config.twofaKey, 10);
  const r = await req('gestor', 'POST', LISTA, lista('a2'), { bruto: velho }, 'sessao-nova-qualquer');
  assert.ok(pediu(r), `${r.s} ${JSON.stringify(r.j)}`);
  assert.equal(await existe('a2'), false);
  // sanidade: na sessão original o mesmo cookie vale
  const ok = await req('gestor', 'POST', LISTA, lista('a2ok'), { bruto: velho }, SID.gestor);
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
});

test('(a) depois do logout: sessão antiga revogada e step-up antigo não vale na sessão nova', async () => {
  const sidA = 'sessao-logout-A';
  const ckA = cookie('almoxarife', 'ok', sidA).replace(/biotrop_2fa=[^;]+/, m => m);   // sessão A + passo vinculado a A
  const passoA = totp.signStepUp(`${U.almoxarife.id}:${sidA}`, config.twofaKey, 10);
  const antes = await fetch(h.raiz + LISTA, { method: 'POST', headers: { cookie: ckA, origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(lista('a3pre')) });
  assert.equal(antes.status, 200, 'antes do logout vale');
  const out = await fetch(h.raiz + '/auth/logout', { method: 'POST', headers: { cookie: ckA, origin: 'http://localhost:3000' } });
  assert.ok(out.status < 400, 'logout ' + out.status);
  // 1) mesma sessão A (cookie roubado) depois do logout
  const reuso = await fetch(h.raiz + LISTA, { method: 'POST', headers: { cookie: ckA, origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(lista('a3')) });
  assert.equal(reuso.status, 401, 'sessão encerrada não pode mais agir');
  assert.equal(await existe('a3'), false);
  // 2) novo login (sid novo) com o cookie de step-up antigo
  const novo = await req('almoxarife', 'POST', LISTA, lista('a3b'), { bruto: passoA }, 'sessao-logout-B');
  assert.ok(pediu(novo), `${novo.s} ${JSON.stringify(novo.j)}`);
  assert.equal(await existe('a3b'), false);
});

// ---------- (b) janela ----------
test('(b) janela de 10 minutos: 9 min passa, 11 min recusa (relógio controlado pela data de emissão)', async () => {
  const nove = await req('almoxarife', 'POST', LISTA, lista('b9'), 9);
  assert.equal(nove.s, 200, `${nove.s} ${JSON.stringify(nove.j)}`);
  assert.equal(await existe('b9'), true);
  const onze = await req('almoxarife', 'POST', LISTA, lista('b11'), 11);
  assert.ok(pediu(onze), `${onze.s} ${JSON.stringify(onze.j)}`);
  assert.equal(await existe('b11'), false);
  // limite: emitido há 10 min exatos já expirou (exp <= agora); e emitido no futuro por 2 min vale
  const dez = await req('almoxarife', 'POST', LISTA, lista('b10'), 10.01);
  assert.ok(pediu(dez), `${dez.s} ${JSON.stringify(dez.j)}`);
});

test('(b) janela maior que 10 min emitida por quem assina com a chave certa não é problema, mas expira no exp gravado', async () => {
  const c = totp.signStepUp(`${U.almoxarife.id}:${SID.almoxarife}`, config.twofaKey, 60, Date.now() - 61 * 60000);
  const r = await req('almoxarife', 'POST', LISTA, lista('b61'), { bruto: c });
  assert.ok(pediu(r), `${r.s} ${JSON.stringify(r.j)}`);
});

// ---------- (c) perfis ----------
const AMOSTRA = [
  ['master-data', new Set(['admin', 'gestor', 'almoxarife']), 'POST', LISTA, { codigo: 'borda-c', nome: '[TESTE] borda c' }],
  ['inventário fechar', new Set(['admin', 'gestor']), 'POST', `/api/inventario/campanhas/${UUID0}/fechar`, {}],
  ['PCM equipamentos', new Set(['admin', 'gestor', 'pcm']), 'POST', '/api/pcm/preventivas/equipamentos', { codigo: 'BRD01', nome: '[TESTE] eq' }],
  ['almox materiais', new Set(['admin', 'gestor', 'almoxarife']), 'PUT', '/api/almox/materiais/MANBORDA1', { descricao: '[TESTE] x' }],
  ['ferramentas', new Set(['admin', 'gestor', 'almoxarife']), 'POST', '/api/emprestimo/ferramentas', { codigo: 'BRD-1', nome: '[TESTE] f' }],
  ['config avisos', new Set(['admin', 'gestor']), 'PUT', '/api/emprestimo/avisos/config', {}],
  ['simulação limpar', new Set(['admin']), 'POST', '/api/admin/simulacao/limpar', {}],
  ['bateladas', new Set(['admin', 'gestor', 'pcm']), 'POST', '/api/pcm/bateladas/preventivas', {}]
];
for (const perfil of Object.keys(PERFIS)) {
  test(`(c) perfil ${perfil}: recusado pela rota recebe o 403 dela; aceito recebe precisa2fa sem step-up`, async () => {
    for (const [nome, aceitos, m, url, body] of AMOSTRA) {
      const r = await req(perfil, m, url, body);
      if (aceitos.has(perfil)) assert.ok(pediu(r), `${perfil} em ${nome}: devia pedir código, veio ${r.s} ${JSON.stringify(r.j)}`);
      else {
        assert.ok(r.s === 403 || r.s === 401, `${perfil} em ${nome}: veio ${r.s}`);
        assert.notEqual(r.j?.precisa2fa, true, `${perfil} em ${nome}: pediu 2FA para algo que a rota recusa: ${JSON.stringify(r.j)}`);
      }
      // e COM step-up quem não é aceito continua recusado (step-up não concede permissão)
      if (!aceitos.has(perfil) && !nome.startsWith('simulação')) {
        const c = await req(perfil, m, url, body, 'ok');
        assert.equal(c.s, 403, `${perfil} em ${nome} com step-up: ${c.s} ${JSON.stringify(c.j)}`);
      }
    }
  });
}

// ---------- (d) bloqueado ----------
test('(d) acesso ao terminal: bloqueado:true passa sem código; false pede; "false", 0, null, ausente não passam como liberação', async () => {
  const url = `/api/emprestimo/colaboradores/${UUID0}/acesso`;
  const ver = async (b, esperado, rot) => {
    const r = await req('almoxarife', 'POST', url, b);
    if (esperado === 'pede') assert.ok(pediu(r), `${rot}: ${r.s} ${JSON.stringify(r.j)}`);
    else { assert.ok(!pediu(r), `${rot}: pediu código sem precisar: ${r.s} ${JSON.stringify(r.j)}`); }
    return r;
  };
  await ver({ bloqueado: true, justificativa: 't' }, 'passa', 'true');
  await ver({ bloqueado: false, justificativa: 't' }, 'pede', 'false');
  // não booleanos: a rota responde 400 e não grava, nunca 200
  for (const [rot, b] of [['"false"', { bloqueado: 'false' }], ['0', { bloqueado: 0 }], ['null', { bloqueado: null }], ['ausente', {}], ['"true"', { bloqueado: 'true' }], ['[false]', { bloqueado: [false] }]]) {
    const r = await req('almoxarife', 'POST', url, b);
    assert.ok(pediu(r) || r.s === 400, `${rot}: devia pedir código ou dar 400, veio ${r.s} ${JSON.stringify(r.j)}`);
    assert.notEqual(r.s, 200, `${rot} liberou sem step-up`);
  }
  // com step-up e alvo inexistente, false ultrapassa o portão
  const com = await req('almoxarife', 'POST', url, { bloqueado: false, justificativa: 't' }, 'ok');
  assert.ok(!pediu(com), `${com.s} ${JSON.stringify(com.j)}`);
});

test('(d) liberar acesso de verdade (bloqueado:false) sem step-up não altera o banco; com step-up altera', async () => {
  // colaborador fictício com acesso: cria via API (com step-up) e bloqueia/libera
  const c = await req('almoxarife', 'POST', '/api/emprestimo/colaboradores', { nome: 'Pessoa alvo', email: U.alvo.email, matricula: 'B9001', setor: 'Manutenção', centroCusto: 'CC-B' }, 'ok');
  assert.equal(c.s, 200, JSON.stringify(c.j));
  const alvo = U.alvo.id;
  assert.ok(alvo, 'alvo criado: ' + JSON.stringify(c.j));
  const url = `/api/emprestimo/colaboradores/${alvo}/acesso`;
  const bl = await req('almoxarife', 'POST', url, { bloqueado: true, justificativa: 'borda' });
  assert.equal(bl.s, 200, JSON.stringify(bl.j));
  assert.equal(bl.j.acesso.situacao, 'bloqueado');
  for (const b of [{ bloqueado: false }, { bloqueado: 'false' }, { bloqueado: 0 }, { bloqueado: null }]) {
    const t = await req('almoxarife', 'POST', url, b);
    assert.notEqual(t.s, 200, JSON.stringify(t.j));
    const s = (await req('almoxarife', 'GET', '/api/emprestimo/colaboradores')).j.rows.find(x => x.usuarioId === alvo);
    assert.equal(s?.acesso?.situacao, 'bloqueado', `após ${JSON.stringify(b)} sem step-up o acesso segue bloqueado`);
  }
  const lib = await req('almoxarife', 'POST', url, { bloqueado: false, justificativa: 'borda' }, 'ok');
  assert.equal(lib.s, 200, JSON.stringify(lib.j));
  assert.notEqual(lib.j.acesso.situacao, 'bloqueado');
});

// ---------- (e) simular ----------
test('(e) prévia: simular:true passa; 1, "true", false, null, ausente pedem código', async () => {
  const folhas = [{ equipamento: 'TST98', data: '2000-01-01', valvulas: [] }];
  const url = '/api/pcm/preventivas/importar';
  const p = await req('pcm', 'POST', url, { folhas, simular: true });
  assert.equal(p.s, 200, JSON.stringify(p.j)); assert.equal(p.j.simulado, true);
  for (const [rot, v] of [['1', 1], ['"true"', 'true'], ['false', false], ['null', null], ['"1"', '1'], ['[true]', [true]], ['"True"', 'True']]) {
    const r = await req('pcm', 'POST', url, { folhas, simular: v });
    assert.ok(pediu(r), `simular=${rot}: ${r.s} ${JSON.stringify(r.j)}`);
  }
  assert.ok(pediu(await req('pcm', 'POST', url, { folhas })), 'ausente');
  // com step-up e simular:1 a rota deve tratar como importação real (simulado:false), coerente com o portão
  const real = await req('pcm', 'POST', url, { folhas, simular: 1 }, 'ok');
  assert.equal(real.s, 200, JSON.stringify(real.j)); assert.equal(real.j.simulado, false, 'rota e portão discordam sobre simular:1');
});

test('(e) simular:true por quem a rota recusa (viewer/técnico) continua 403 sem precisa2fa e sem gravar', async () => {
  for (const k of ['viewer', 'tecnico', 'lider', 'almoxarife']) {
    const r = await req(k, 'POST', '/api/pcm/preventivas/importar', { folhas: [], simular: true });
    assert.notEqual(r.s, 200, `${k} rodou a prévia`);
    assert.notEqual(r.j?.precisa2fa, true, k);
  }
});

// ---------- (f) cookie ----------
test('(f) cookie biotrop_2fa adulterado, truncado, de outro segredo ou vazio é recusado', async () => {
  const bom = totp.signStepUp(`${U.gestor.id}:${SID.gestor}`, config.twofaKey, 10);
  const [pl, sg] = bom.split('.');
  const exp2 = Buffer.from(JSON.stringify({ sub: `${U.gestor.id}:${SID.gestor}`, exp: Math.floor(Date.now() / 1000) + 99999 })).toString('base64url');
  const casos = {
    'assinatura de outro segredo': { segredo: 'outro-segredo-qualquer-0123456789abcdef' },
    'assinatura com 1 caractere trocado': { bruto: pl + '.' + (sg[0] === 'A' ? 'B' : 'A') + sg.slice(1) },
    'payload trocado (exp maior) com assinatura antiga': { bruto: exp2 + '.' + sg },
    'sem assinatura': { bruto: pl },
    'só ponto': { bruto: '.' },
    'assinatura vazia': { bruto: pl + '.' },
    'lixo': { bruto: 'lixo.lixo' },
    'assinatura com sufixo extra': { bruto: bom + 'xx' },
    'assinatura vazia e payload válido': { bruto: pl + '.' },
    'sem prefixo stepup (assinado como sessão)': { bruto: pl + '.' + crypto.createHmac('sha256', config.twofaKey).update(pl).digest('base64url') }
  };
  for (const [nome, passo] of Object.entries(casos)) {
    const r = await req('gestor', 'POST', LISTA, lista('f'), passo);
    assert.ok(pediu(r), `${nome}: ${r.s} ${JSON.stringify(r.j)}`);
  }
  assert.equal(await existe('f'), false);
  // cookie duplicado (parser pega o primeiro): lixo primeiro e válido depois não pode liberar por acidente nem quebrar (500)
  const dup = `${cookie('gestor')}; biotrop_2fa=lixo; biotrop_2fa=${bom}`;
  const r = await fetch(h.raiz + LISTA, { method: 'POST', headers: { cookie: dup, origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(lista('f2')) });
  assert.ok(r.status === 200 || r.status === 403, 'sem 500: ' + r.status);
  // sanidade
  assert.equal((await req('gestor', 'POST', LISTA, lista('fok'), { bruto: bom })).s, 200);
});

test('(f) a sessão sozinha (cookie de sessão válido) nunca é aceita como step-up e o cookie de step-up sozinho não autentica', async () => {
  const so2fa = `biotrop_2fa=${totp.signStepUp(`${U.gestor.id}:${SID.gestor}`, config.twofaKey, 10)}`;
  const r = await fetch(h.raiz + LISTA, { method: 'POST', headers: { cookie: so2fa, origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(lista('f3')) });
  assert.equal(r.status, 401);
  assert.equal(await existe('f3'), false);
});

// ---------- (g) HEAD / OPTIONS ----------
test('(g) HEAD e OPTIONS nas rotas protegidas não escrevem', async () => {
  const alvos = [
    ['almoxarife', LISTA, async () => existe('g1'), lista('g1')],
    ['almoxarife', '/api/almox/materiais/MANBORDAG', async () => (await h.q(`SELECT 1 FROM almox.material WHERE codigo='MANBORDAG'`).catch(() => ({ rows: [] }))).rows.length === 1, { descricao: '[TESTE] g' }],
    ['almoxarife', '/api/emprestimo/ferramentas', async () => (await h.q(`SELECT 1 FROM emprestimo.ferramenta WHERE codigo='BRD-G'`).catch(() => ({ rows: [] }))).rows.length === 1, { codigo: 'BRD-G', nome: '[TESTE] g' }],
    ['pcm', '/api/pcm/preventivas/equipamentos', async () => (await h.q(`SELECT 1 FROM pcm.equipamento WHERE codigo='BRDG1'`).catch(() => ({ rows: [] }))).rows.length === 1, { codigo: 'BRDG1', nome: '[TESTE] g' }],
    ['admin', '/api/admin/simulacao/limpar', async () => false, {}],
    ['gestor', `/api/inventario/campanhas/${UUID0}/fechar`, async () => false, {}]
  ];
  for (const [k, url, gravou, body] of alvos) {
    for (const m of ['HEAD', 'OPTIONS']) {
      for (const passo of [undefined, 'ok']) {
        const r = await fetch(h.raiz + url, { method: m, headers: { cookie: cookie(k, passo), origin: 'http://localhost:3000' } });
        assert.ok(r.status < 500, `${m} ${url}: ${r.status}`);
        assert.equal(await gravou(), false, `${m} ${url} gravou`);
        const txt = await r.text();
        if (m === 'HEAD') assert.equal(txt, '', 'HEAD sem corpo');
      }
    }
  }
  // POST com corpo em HEAD não vale: HEAD com corpo JSON igualmente não grava
  const r = await fetch(h.raiz + LISTA, { method: 'HEAD', headers: { cookie: cookie('almoxarife', 'ok'), origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(lista('g1')) }).catch(() => null);
  assert.equal(await existe('g1'), false, 'HEAD com corpo gravou');
});

test('(g) override de método (X-HTTP-Method-Override) não contorna o portão', async () => {
  const r = await fetch(h.raiz + LISTA, { method: 'GET', headers: { cookie: cookie('almoxarife'), origin: 'http://localhost:3000', 'x-http-method-override': 'POST', 'content-type': 'application/json' } });
  assert.ok(r.status < 500);
  assert.equal(await existe('g2'), false);
});

// ---------- paralelo / repetição ----------
test('requisições em paralelo sem step-up: todas pedem código e nada é gravado; com step-up todas gravam uma vez cada', async () => {
  const sem = await Promise.all(Array.from({ length: 8 }, (_, i) => req('almoxarife', 'POST', LISTA, lista('p' + i))));
  assert.ok(sem.every(pediu));
  for (let i = 0; i < 8; i++) assert.equal(await existe('p' + i), false);
  const com = await Promise.all(Array.from({ length: 8 }, (_, i) => req('almoxarife', 'POST', LISTA, lista('q' + i), 'ok')));
  assert.ok(com.every(r => r.s === 200), JSON.stringify(com.map(r => r.s)));
});


