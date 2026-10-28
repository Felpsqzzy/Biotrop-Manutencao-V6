'use strict';
// Cobertura adicional do empréstimo de ferramentas e do terminal do almoxarifado (fases 4 a 7), escrita pelo testador:
// o que a lista obrigatória do pedido (seção 12) e os critérios (seção 13) pedem e os outros arquivos não pegam, mais
// bordas e permissões que ninguém tinha tentado. App e banco de verdade (PGlite, papel biotrop_app, RLS). Dados FICTÍCIOS:
// pessoas "Pessoa x" do harness, matrículas 81000x, ferramentas FER-C00x.
//
// Os achados desta cobertura (marcados como "todo" do node:test enquanto o defeito existia) foram corrigidos em
// 2026-10-21: todos os testes aqui precisam passar.
process.env.TERMINAL_SCRYPT_LOG2N = '14';   // scrypt leve só no teste (o hash guarda o N usado)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirApp } = require('./_harness');
const { createSession } = require('../src/auth/session');

const MIG = path.resolve(__dirname, '../../database/migrations');
const API = '/api/emprestimo';
const HORA = 3600e3;
const F = {};
const SENHA = i => `Senha-Cobertura-${i}#9`;
const MAT = { t1: '810001', t2: '810002', t3: '810003', t4: '810004', t5: '810005', t6: '810006', c1: '820001', c2: '820002', c3: '820003', lid: 'L81001' };
let h, U;

test.before(async () => {
  h = await subirApp({ adm: 'admin', ges: 'gestor', alm: 'almoxarife', alm2: 'almoxarife', pcm: 'pcm', lid: 'lider', tec: 'tecnico', vie: 'viewer',
    t1: 'terminal', t2: 'terminal', t3: 'terminal', t4: 'terminal', t5: 'terminal', t6: 'terminal', c1: 'terminal', c2: 'terminal', c3: 'terminal' });
  U = h.users;
});
test.after(() => h?.fechar());

/* ---------------------------------------------------------------- ajudantes */
// Cada chamada sai de um IP diferente (X-Forwarded-For, trust proxy 1): os limites por IP do app e do banco não atrapalham.
let ipN = 0;
const novoIp = () => `10.81.${Math.floor(++ipN / 250)}.${ipN % 250 + 1}`;
let chaveN = 0;
const chave = () => `cobertura-chave-${++chaveN}-${Date.now()}`;
const noPrazo = horas => new Date(Date.now() + horas * HORA).toISOString();

/** Painel: sessão do site (cookie biotrop_session). u = null → sem sessão. */
async function painel(u, method, url, body) {
  const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': novoIp() };
  if (u) headers.cookie = `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv }).valor}`;
  const r = await fetch(h.raiz + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (r.headers.get('content-type') || '').includes('json');
  let j = null; if (json) j = await r.json(); else await r.arrayBuffer();
  return { s: r.status, j, headers: r.headers };
}
/** Navegador do tablet: guarda o cookie do terminal entre as chamadas; cada um com o seu IP. */
function tablet() {
  const t = { cookie: '', ip: novoIp() };
  t.req = async (method, url, body, extra = {}) => {
    const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': t.ip, ...extra };
    if (t.cookie && !headers.cookie) headers.cookie = t.cookie;
    const r = await fetch(h.raiz + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      if (kv.slice(0, i) === 'biotrop_terminal') t.cookie = kv.slice(i + 1) ? kv : '';
    }
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j, headers: r.headers };
  };
  t.entrar = (matricula, senha) => t.req('POST', '/api/terminal/entrar', { matricula, senha });
  return t;
}
/** A mesma função de escrita da API (a rota só valida a forma); poupa requisições. */
function exec(u, acao, p, canal = 'painel') {
  return h.transaction(u, async db => {
    await db.query("SELECT set_config('app.canal',$1,true)", [canal]);
    return (await db.query('SELECT emprestimo.executar($1,$2::jsonb) AS r', [acao, JSON.stringify(p)])).rows[0].r;
  });
}
const como = (u, canal, sql, params) => h.transaction(u, async db => { await db.query("SELECT set_config('app.canal',$1,true)", [canal]); return (await db.query(sql, params)).rows; });
/** Um ciclo do worker no instante t (como dono do banco: a versão com horário simulado não é do worker). */
const rodar = t => h.transaction(null, async db => { await db.query('SET LOCAL ROLE NONE'); return (await db.query('SELECT emprestimo.enfileirar_avisos_em($1::timestamptz) AS n', [new Date(t).toISOString()])).rows[0].n; });
const saldo = async id => (await h.q('SELECT total, disponivel, emprestada, em_conferencia, manutencao, baixada FROM emprestimo.ferramenta_saldo WHERE ferramenta_id=$1', [id])).rows[0];
const estado = async () => (await h.q(`SELECT (SELECT count(*) FROM emprestimo.emprestimo)::int e, (SELECT count(*) FROM emprestimo.emprestimo_item)::int i,
  (SELECT count(*) FROM emprestimo.emprestimo_evento)::int v, (SELECT count(*) FROM emprestimo.auditoria)::int a,
  (SELECT md5(string_agg(ferramenta_id::text || ':' || total || ':' || disponivel || ':' || emprestada || ':' || em_conferencia || ':' || manutencao || ':' || baixada, ',' ORDER BY ferramenta_id)) FROM emprestimo.ferramenta_saldo) s`)).rows[0];
const bytes = { jpeg: (n = 600, x = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, x)]) };
const url = b => `data:image/jpeg;base64,${b.toString('base64')}`;
const FOTO = { imagem: url(bytes.jpeg(3000)), miniatura: url(bytes.jpeg(300, 7)), largura: 1600, altura: 1200 };

/** Colaborador com senha definida pelo caminho real (convite do painel + primeiro acesso no tablet). */
async function ativar(k, quem = U.alm) {
  const c = await painel(quem, 'POST', `${API}/colaboradores/${U[k].id}/convite`);
  assert.equal(c.s, 201, `${k}: ${JSON.stringify(c.j)}`);
  const t = tablet();
  const r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT[k], codigo: c.j.codigo, senha: SENHA(k) });
  assert.equal(r.s, 200, `${k}: ${JSON.stringify(r.j)}`);
  return t;
}
const abertos = async () => (await h.q("SELECT count(*)::int n FROM emprestimo.emprestimo WHERE status NOT IN ('devolvido','encerrado','estornado')")).rows[0].n;

/* ---------------------------------------------------------------- preparação */
test('preparação: ferramentas, material e colaboradores fictícios; seis tablets com senha', async () => {
  F.chave = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C001', nome: 'Chave de cobertura (teste)', descricao: 'Chave para os testes de cobertura', categoria: 'Manual', marca: 'Marca X', modelo: 'Modelo Y', controle: 'quantidade', total: '10', localizacao: 'Armário C1' })).id;
  F.furadeira = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C002', nome: 'Furadeira de cobertura (teste)', categoria: 'Elétrica', controle: 'individual', unidades: ['PAT-C1', 'PAT-C2'] })).id;
  F.serra = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C003', nome: 'Serra de cobertura (teste)', categoria: 'Elétrica', controle: 'individual', unidades: ['PAT-C3'] })).id;
  F.ultima = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C004', nome: 'Paquímetro único (teste)', categoria: 'Medição', controle: 'quantidade', total: '1' })).id;
  const un = async f => (await h.q('SELECT id, identificador FROM emprestimo.ferramenta_unidade WHERE ferramenta_id=$1 ORDER BY identificador', [f])).rows;
  [F.u1, F.u2] = (await un(F.furadeira)).map(x => x.id); [F.u3] = (await un(F.serra)).map(x => x.id);
  const mat = await painel(U.alm, 'POST', '/api/almox/materiais/importar', { linhas: [{ codigo: 'MAN-C1', descricao: 'Fita isolante de cobertura (teste)', unidade: 'UN' }], campos: ['descricao', 'unidade'] });
  assert.equal(mat.s, 200, JSON.stringify(mat.j));
  for (const k of ['t1', 't2', 't3', 't4', 't5', 't6', 'c1', 'c2', 'c3', 'lid']) {
    const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { nome: `Pessoa ${k}`, email: U[k].email, matricula: MAT[k], setor: 'Manutenção', centroCusto: `CC-${k}`, cargo: 'Mecânico' });
    assert.equal(r.s, 200, `${k}: ${JSON.stringify(r.j)}`);
  }
  F.tab = {};
  for (const k of ['t1', 't2', 't3', 't4', 't5', 't6']) F.tab[k] = await ativar(k);
  const e = await painel(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.t2.id, chave: chave(), itens: [{ ferramentaId: F.chave, quantidade: 1 }] });
  assert.equal(e.s, 201, JSON.stringify(e.j)); F.emp = e.j.id;
});

/* ---------------------------------------------------------------- perfis × painel (pela API e pelo banco) */
const rotasDoPainel = () => [
  ['GET', '/ferramentas'], ['GET', `/ferramentas/${F.chave}`], ['GET', `/ferramentas/${F.chave}/foto`], ['GET', '/colaboradores'], ['GET', '/emprestimos'],
  ['GET', '/emprestimos?atrasados=1'], ['GET', `/emprestimos/${F.emp}`], ['GET', '/config'], ['GET', '/avisos'], ['GET', '/avisos/config'],
  ['POST', '/ferramentas', { codigo: 'ZZ-C9', nome: 'Zeta de cobertura', controle: 'quantidade', total: 1 }], ['PUT', `/ferramentas/${F.chave}`, { localizacao: 'Invasão' }],
  ['POST', `/ferramentas/${F.chave}/unidades`, { identificador: 'INV-1' }], ['POST', `/ferramentas/${F.chave}/ajustes`, { movimento: 'entrada', quantidade: 5, justificativa: 'Tentativa de invasão' }],
  ['PUT', `/ferramentas/${F.chave}/foto`, FOTO], ['DELETE', `/ferramentas/${F.chave}/foto`],
  ['POST', '/colaboradores', { nome: 'Pessoa Invasora', email: 'invasora@teste.biotrop', matricula: 'INV01', setor: 'X' }],
  ['POST', `/colaboradores/${U.t3.id}/convite`], ['POST', `/colaboradores/${U.t3.id}/acesso`, { bloqueado: true, justificativa: 'Tentativa de invasão' }],
  ['POST', '/emprestimos', { colaboradorId: U.t3.id, chave: 'invasao-chave-001', itens: [{ ferramentaId: F.chave, quantidade: 1 }] }],
  ['POST', `/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: '00000000-0000-4000-8000-000000000001', quantidade: 1 }] }],
  ['POST', `/emprestimos/${F.emp}/conferencias`, { itens: [{ itemId: '00000000-0000-4000-8000-000000000001', quantidade: 1, resultado: 'boa' }] }],
  ['POST', `/emprestimos/${F.emp}/baixas`, { itemId: '00000000-0000-4000-8000-000000000001', quantidade: 1, motivo: 'extravio', justificativa: 'Tentativa de invasão' }],
  ['POST', `/emprestimos/${F.emp}/prazo`, { prazo: noPrazo(48), justificativa: 'Tentativa de invasão' }],
  ['POST', `/emprestimos/${F.emp}/estorno`, { justificativa: 'Tentativa de invasão' }],
  ['PUT', '/config', { prazoPadraoHoras: 1 }], ['PUT', '/avisos/config', { avisosAtivos: false }]
];
const SO_GERENCIA = ['POST /ferramentas/:id/ajustes', 'POST /emprestimos/:id/estorno', 'PUT /config', 'PUT /avisos/config'];

test('permissões pela API: pcm, líder, técnico, visualizador e perfil terminal levam 403 em TODAS as rotas do painel; sem sessão, 401; nada muda no banco', async () => {
  const antes = await estado();
  const cfgAntes = (await h.q('SELECT row_to_json(c)::text j FROM emprestimo.config c')).rows[0].j;
  for (const k of ['pcm', 'lid', 'tec', 'vie', 't1']) {
    for (const [m, u, b] of rotasDoPainel()) {
      const r = await painel(U[k], m, API + u, b);
      assert.equal(r.s, 403, `${k} ${m} ${u}: ${JSON.stringify(r.j)}`);
    }
  }
  for (const [m, u, b] of rotasDoPainel()) assert.equal((await painel(null, m, API + u, b)).s, 401, `sem sessão ${m} ${u}`);
  // almoxarife: gestão sim, gerência não (ajuste, estorno, configuração e avisos) — a rota deixa passar e o banco recusa
  for (const [m, u, b] of rotasDoPainel()) {
    const gerencia = SO_GERENCIA.includes(`${m} ${u.replace(F.chave, ':id').replace(F.emp, ':id').split('?')[0]}`);
    if (!gerencia) continue;
    const r = await painel(U.alm, m, API + u, b);
    assert.equal(r.s, 403, `almoxarife ${m} ${u}: ${JSON.stringify(r.j)}`);
  }
  assert.deepEqual(await estado(), antes, 'nenhuma tentativa negada deixou rastro nas tabelas');
  assert.equal((await h.q('SELECT row_to_json(c)::text j FROM emprestimo.config c')).rows[0].j, cfgAntes, 'configuração intacta');
  // as leituras da gestão abrem para os três perfis
  for (const k of ['adm', 'ges', 'alm']) for (const u of ['/ferramentas', '/colaboradores', '/emprestimos', '/config', '/avisos', '/avisos/config']) assert.equal((await painel(U[k], 'GET', API + u)).s, 200, `${k} ${u}`);
  // gerência grava
  for (const k of ['adm', 'ges']) {
    assert.equal((await painel(U[k], 'PUT', `${API}/avisos/config`, { avisosAtivos: true })).s, 200, k);
    assert.equal((await painel(U[k], 'PUT', `${API}/config`, { prazoPadraoHoras: 168 })).s, 200, k);
    assert.equal((await painel(U[k], 'POST', `${API}/ferramentas/${F.chave}/ajustes`, { movimento: 'para_manutencao', quantidade: 1, justificativa: 'Teste de permissão' })).s, 200, k);
    assert.equal((await painel(U[k], 'POST', `${API}/ferramentas/${F.chave}/ajustes`, { movimento: 'de_manutencao', quantidade: 1, justificativa: 'Teste de permissão' })).s, 200, k);
  }
});

test('permissões no banco: nenhuma ação de escrita funciona para quem não é da gestão, nem direto na função, nem no canal do terminal', async () => {
  const antes = await estado();
  const v = '00000000-0000-4000-8000-000000000001';
  const ACOES = {
    emprestar: { colaboradorId: U.t3.id, chave: chave(), itens: [{ ferramentaId: F.chave, quantidade: '1' }] },
    devolver: { emprestimoId: F.emp, itens: [{ itemId: v, quantidade: '1' }] },
    conferir: { emprestimoId: F.emp, itens: [{ itemId: v, quantidade: '1', resultado: 'boa' }] },
    baixar: { emprestimoId: F.emp, itemId: v, quantidade: '1', motivo: 'extravio', justificativa: 'Tentativa direta' },
    prazo: { emprestimoId: F.emp, prazo: noPrazo(30), justificativa: 'Tentativa direta' },
    ferramenta_salvar: { codigo: 'ZZ-D1', nome: 'Direta', controle: 'quantidade', total: '1' },
    unidade_adicionar: { ferramentaId: F.furadeira, identificador: 'DIR-1' },
    colaborador_salvar: { nome: 'Pessoa Direta', email: 'direta@teste.biotrop', matricula: 'DIR01' },
    ajustar: { ferramentaId: F.chave, movimento: 'entrada', quantidade: '3', justificativa: 'Tentativa direta' },
    estornar: { emprestimoId: F.emp, justificativa: 'Tentativa direta' },
    config_salvar: { prazoPadraoHoras: 1 }
  };
  // painel: pcm, líder, técnico e visualizador "não usam o empréstimo" (nem o líder, que tem cadastro de colaborador)
  for (const k of ['pcm', 'lid', 'tec', 'vie']) {
    for (const [acao, p] of Object.entries(ACOES)) await assert.rejects(exec(U[k], acao, p), e => e.code === '42501', `${k} ${acao}`);
  }
  // perfil terminal no painel só retira e devolve; o resto é da gestão
  for (const [acao, p] of Object.entries(ACOES)) {
    if (['emprestar', 'devolver'].includes(acao)) continue;
    await assert.rejects(exec(U.t1, acao, p), e => e.code === '42501', `terminal ${acao}`);
  }
  // almoxarife no painel: o que é só da gerência é recusado no banco
  for (const acao of ['ajustar', 'estornar', 'config_salvar']) await assert.rejects(exec(U.alm, acao, ACOES[acao]), e => e.code === '42501', `almoxarife ${acao}`);
  // canal do terminal: até gestor e admin viram colaborador comum
  for (const k of ['ges', 'adm', 'alm']) {
    for (const acao of Object.keys(ACOES)) {
      if (['emprestar', 'devolver'].includes(acao)) continue;
      await assert.rejects(exec(U[k], acao, ACOES[acao], 'terminal'), e => e.code === '42501', `${k} no terminal: ${acao}`);
    }
  }
  // quem não tem cadastro de colaborador não retira nem no canal do terminal
  for (const k of ['pcm', 'tec', 'vie']) await assert.rejects(exec(U[k], 'emprestar', { chave: chave(), itens: [{ ferramentaId: F.chave, quantidade: '1' }] }, 'terminal'), e => e.code === '42501', `${k} sem cadastro`);
  // funções de acesso, foto e avisos
  const FUNCOES = [['SELECT * FROM emprestimo.terminal_convite_gerar($1,$2)', [U.t3.id, 'a'.repeat(64)]], ['SELECT * FROM emprestimo.terminal_acesso_definir($1,true,$2)', [U.t3.id, 'Tentativa direta']],
    ['SELECT emprestimo.avisos_config_salvar($1::jsonb)', [JSON.stringify({ avisosAtivos: false })]], ['SELECT * FROM emprestimo.ferramenta_foto_salvar($1,$2,$3,$4,0,0)', [F.chave, 'image/jpeg', bytes.jpeg(), bytes.jpeg()]],
    ['SELECT emprestimo.ferramenta_foto_remover($1)', [F.chave]]];
  for (const k of ['pcm', 'lid', 'tec', 'vie', 't1']) for (const [sql, args] of FUNCOES) await assert.rejects(h.transaction(U[k], db => db.query(sql, args)), e => e.code === '42501', `${k} ${sql.slice(0, 50)}`);
  for (const k of ['pcm', 'lid', 'tec', 'vie', 't1']) {
    assert.equal((await como(U[k], 'painel', 'SELECT * FROM emprestimo.terminal_acessos()')).length, 0, `${k} não lê a situação dos acessos`);
    assert.equal((await como(U[k], 'painel', 'SELECT * FROM emprestimo.avisos_log(50)')).length, 0, `${k} não lê o registro de avisos`);
  }
  // RLS: nenhuma tabela do empréstimo abre para quem não é da gestão (o líder só vê o próprio cadastro)
  for (const k of ['pcm', 'tec', 'vie', 'lid']) {
    for (const t of ['ferramenta', 'ferramenta_saldo', 'ferramenta_unidade', 'config', 'emprestimo', 'emprestimo_item', 'emprestimo_evento', 'auditoria', 'aviso', 'ferramenta_foto']) {
      assert.equal((await como(U[k], 'painel', `SELECT 1 FROM emprestimo.${t}`)).length, 0, `${k} lê ${t}`);
    }
    assert.equal((await como(U[k], 'painel', 'SELECT 1 FROM emprestimo.colaborador')).length, k === 'lid' ? 1 : 0, `${k} e colaborador`);
    assert.equal((await como(U[k], 'painel', 'SELECT 1 FROM emprestimo.colaboradores()')).length, k === 'lid' ? 1 : 0, `${k} e colaboradores()`);
  }
  assert.deepEqual(await estado(), antes, 'nada gravado');
});

/* ---------------------------------------------------------------- retirada: quantidade, itens, unidade */
async function retirar(via, itens, extra = {}) {
  if (via === 'painel') return painel(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.t1.id, chave: chave(), itens, ...extra });
  return F.tab.t1.req('POST', '/api/terminal/emprestimos', { itens, chave: chave(), ...extra });
}

test('retirada: quantidade zero, negativa, decimal (com vírgula), vazia, em notação científica ou enorme é recusada no painel e no terminal, sem gravar nada', async () => {
  const antes = await estado();
  for (const via of ['painel', 'terminal']) {
    for (const q of [0, -1, '-3', '1,5', '1.5', 0.5, '', null, '1e2', ' 1', '99999999999', 1000, true, '٣']) {
      const r = await retirar(via, [{ ferramentaId: F.chave, quantidade: q }]);
      assert.equal(r.s, 400, `${via} quantidade ${JSON.stringify(q)}: ${JSON.stringify(r.j)}`);
      assert.equal(r.j.erro, 'Quantidade inválida.', `${via} quantidade ${JSON.stringify(q)}`);
    }
    const r = await retirar(via, [{ ferramentaId: F.chave }]);
    assert.equal(r.s, 400, `${via} sem quantidade`);
    assert.deepEqual(await estado(), antes, `${via}: nada gravado pelas recusas`);
  }
});

test('retirada: ferramenta por unidade — unidade de outra ferramenta, sem unidade, quantidade 2, unidade em ferramenta por quantidade e ids inválidos', async () => {
  const antes = await estado();
  for (const via of ['painel', 'terminal']) {
    let r = await retirar(via, [{ ferramentaId: F.furadeira, unidadeId: F.u3, quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [404, 'Unidade inexistente.'], `${via}: unidade de outra ferramenta`);
    r = await retirar(via, [{ ferramentaId: F.furadeira, quantidade: 1 }]);
    assert.equal(r.s, 400, `${via}: sem unidade`); assert.match(r.j.erro, /controlada por unidade/);
    r = await retirar(via, [{ ferramentaId: F.furadeira, unidadeId: F.u1, quantidade: 2 }]);
    assert.equal(r.s, 400, `${via}: quantidade 2 em unidade`); assert.match(r.j.erro, /controlada por unidade/);
    r = await retirar(via, [{ ferramentaId: F.chave, unidadeId: F.u1, quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [400, 'Esta ferramenta é controlada por quantidade.'], `${via}: unidade em ferramenta por quantidade`);
    r = await retirar(via, [{ ferramentaId: F.furadeira, unidadeId: 'nao-e-uuid', quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [400, 'Identificador inválido.'], `${via}: unidade com id ruim`);
    r = await retirar(via, [{ ferramentaId: 'nao-e-uuid', quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [400, 'Identificador inválido.'], `${via}: ferramenta com id ruim`);
    r = await retirar(via, [{ ferramentaId: '00000000-0000-4000-8000-0000000000aa', quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [404, 'Ferramenta indisponível no cadastro.'], `${via}: ferramenta inexistente`);
    r = await retirar(via, [{ ferramentaId: F.furadeira, unidadeId: F.u1, quantidade: 1 }, { ferramentaId: F.furadeira, unidadeId: F.u2, quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [400, 'Item ausente ou repetido.'], `${via}: duas unidades da mesma ferramenta na mesma retirada`);
    r = await retirar(via, [{ ferramentaId: F.chave, quantidade: 1 }, { ferramentaId: F.chave, quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [400, 'Item ausente ou repetido.'], `${via}: mesma ferramenta duas vezes`);
  }
  assert.deepEqual(await estado(), antes, 'nada gravado pelas recusas');
});

test('retirada: 30 itens passam e 31 não (painel e terminal); a recusa dos 31 não deixa nada gravado', async () => {
  const ids = [];
  for (let i = 1; i <= 30; i += 1) ids.push((await exec(U.alm, 'ferramenta_salvar', { codigo: `FER-L${String(i).padStart(2, '0')}`, nome: `Ferramenta de lote ${i} (teste)`, controle: 'quantidade', total: '4' })).id);
  F.lote = ids;
  for (const via of ['painel', 'terminal']) {
    const antes = await estado();
    const trinta = ids.map(id => ({ ferramentaId: id, quantidade: 1 }));
    let r = await retirar(via, [...trinta, { ferramentaId: F.chave, quantidade: 1 }]);
    assert.deepEqual([r.s, r.j.erro], [400, 'Informe de 1 a 30 itens.'], `${via}: 31 itens`);
    assert.deepEqual(await estado(), antes, `${via}: 31 itens não gravam nada`);
    r = await retirar(via, trinta);
    assert.equal(r.s, 201, `${via}: 30 itens ${JSON.stringify(r.j)}`);
    assert.equal(r.j.itens, 30);
    const n = (await h.q("SELECT count(*)::int n FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1", [r.j.id])).rows[0].n;
    assert.equal(n, 30, `${via}: 30 linhas`);
    assert.equal((await h.q("SELECT count(*)::int n FROM emprestimo.emprestimo_evento WHERE emprestimo_id=$1 AND tipo='retirada'", [r.j.id])).rows[0].n, 30, `${via}: 30 eventos`);
    if (via === 'painel') F.empLotePainel = r.j.id; else F.empLoteTerminal = r.j.id;
  }
  for (const id of ids) { const s = await saldo(id); assert.deepEqual([s.disponivel, s.emprestada], [2, 2], 'duas retiradas de 1 em cada ferramenta do lote'); }
  // devolve e confere tudo para não pesar nas outras provas
  for (const id of [F.empLotePainel, F.empLoteTerminal]) {
    const itens = (await h.q('SELECT id FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1', [id])).rows;
    await exec(U.alm, 'devolver', { emprestimoId: id, itens: itens.map(i => ({ itemId: i.id, quantidade: '1' })) });
    await exec(U.alm, 'conferir', { emprestimoId: id, itens: itens.map(i => ({ itemId: i.id, quantidade: '1', resultado: 'boa' })) });
  }
  for (const id of ids) assert.deepEqual((await saldo(id)).disponivel, 4);
});

test('terminal: prazo, finalidade, atendente, origem e colaborador do corpo são ignorados; observação enorme é cortada; chave fora do formato é recusada', async () => {
  const r = await retirar('terminal', [{ ferramentaId: F.chave, quantidade: 1 }], { prazo: '2099-01-01', finalidade: 'capex', finalidadeRef: 'X', origem: 'painel', atendenteId: U.alm.id, colaboradorId: U.t2.id, observacao: 'y'.repeat(5000) });
  assert.equal(r.s, 201, JSON.stringify(r.j));
  const e = (await h.q('SELECT * FROM emprestimo.emprestimo WHERE id=$1', [r.j.id])).rows[0];
  const cfg = (await h.q('SELECT prazo_padrao_horas FROM emprestimo.config')).rows[0].prazo_padrao_horas;
  assert.equal(e.colaborador_id, U.t1.id); assert.equal(e.origem, 'terminal'); assert.equal(e.atendente_id, null);
  assert.equal(e.finalidade, 'manutencao'); assert.equal(e.finalidade_ref, '');
  assert.ok(Math.abs(new Date(e.prazo) - Date.now() - cfg * HORA) < 60e3, 'prazo padrão da configuração, não o do corpo');
  assert.equal(e.observacao.length, 1000, 'observação cortada em 1000 caracteres');
  for (const c of ['curta', 'abc def gh ij', 'x'.repeat(7), '../../etc/passwd', 'chave com acento é']) {
    const x = await F.tab.t1.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.chave, quantidade: 1 }], chave: c });
    assert.deepEqual([x.s, x.j.erro], [400, 'Chave de operação inválida.'], c);
  }
  // material, item sem ferramenta e item que não é objeto
  for (const itens of [[{ materialCodigo: 'MAN-C1', quantidade: 1 }], [{ quantidade: 1 }], [{ ferramentaId: F.chave, materialCodigo: 'MAN-C1', quantidade: 1 }]]) {
    const x = await retirar('terminal', itens);
    assert.equal(x.s, 400, JSON.stringify(itens)); assert.match(x.j.erro, /só ferramentas/);
  }
  for (const itens of [[null], ['texto'], [7], 'texto', {}, null]) {
    const x = await retirar('terminal', itens);
    assert.equal(x.s, 400, JSON.stringify(itens));
  }
  await exec(U.alm, 'devolver', { emprestimoId: r.j.id, itens: [{ itemId: (await h.q('SELECT id FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1', [r.j.id])).rows[0].id, quantidade: '1' }] });
  await exec(U.alm, 'conferir', { emprestimoId: r.j.id, itens: [{ itemId: (await h.q('SELECT id FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1', [r.j.id])).rows[0].id, quantidade: '1', resultado: 'boa' }] });
});

/* ---------------------------------------------------------------- devolução, conferência e baixa: limites */
/** Retirada pelo painel (a mesma função do banco), devolvendo os itens gravados. */
async function novoEmprestimo(k, itens, extra = {}) {
  const r = await exec(U.alm, 'emprestar', { colaboradorId: U[k].id, chave: chave(), itens, ...extra });
  const its = (await h.q('SELECT id, ferramenta_id, unidade_id, tipo, quantidade::float q FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1 ORDER BY codigo', [r.id])).rows;
  return { id: r.id, itens: its };
}
const dev = (e, itens, extra) => painel(U.alm, 'POST', `${API}/emprestimos/${e.id}/devolucoes`, { itens, ...extra });
const conf = (e, itens) => painel(U.alm, 'POST', `${API}/emprestimos/${e.id}/conferencias`, { itens });
const baixa = (e, b) => painel(U.alm, 'POST', `${API}/emprestimos/${e.id}/baixas`, b);
const statusDe = async e => (await h.q('SELECT status FROM emprestimo.emprestimo WHERE id=$1', [e.id])).rows[0].status;
const fecha = s => assert.equal(s.total, s.disponivel + s.emprestada + s.em_conferencia + s.manutencao + s.baixada, `saldo não fecha: ${JSON.stringify(s)}`);

test('devolução: zero, negativa, decimal com vírgula, acima do pendente, item repetido, item de outro empréstimo, ferramenta fracionada e fechado', async () => {
  const e = await novoEmprestimo('t3', [{ ferramentaId: F.chave, quantidade: '3' }]);
  const outro = await novoEmprestimo('t4', [{ ferramentaId: F.chave, quantidade: '1' }]);
  const it = e.itens[0].id;
  const antes = await estado();
  for (const q of [0, -1, '1,5', '', null, 'abc', '1e1']) {
    const r = await dev(e, [{ itemId: it, quantidade: q }]);
    assert.deepEqual([r.s, r.j.erro], [400, 'Quantidade inválida.'], `quantidade ${JSON.stringify(q)}`);
  }
  let r = await dev(e, [{ itemId: it, quantidade: 0.5 }]);
  assert.deepEqual([r.s, r.j.erro], [400, 'Ferramenta se movimenta em unidades inteiras.']);
  r = await dev(e, [{ itemId: it, quantidade: 4 }]); assert.equal(r.s, 409); assert.match(r.j.erro, /passa do que está pendente/);
  r = await dev(e, [{ itemId: it, quantidade: 1 }, { itemId: it, quantidade: 1 }]); assert.deepEqual([r.s, r.j.erro], [400, 'Item repetido na devolução.']);
  r = await dev(e, [{ itemId: outro.itens[0].id, quantidade: 1 }]); assert.deepEqual([r.s, r.j.erro], [404, 'Item não pertence a este empréstimo.']);
  r = await dev(e, [{ itemId: it, quantidade: 1, condicao: 'quebrada' }]); assert.deepEqual([r.s, r.j.erro], [400, 'Condição inválida.']);
  for (const itens of [[], 'x', null]) assert.equal((await dev(e, itens)).s, 400, JSON.stringify(itens));
  assert.equal((await painel(U.alm, 'POST', `${API}/emprestimos/${e.id}/devolucoes`, {})).s, 400);
  assert.equal((await dev({ id: 'nao-e-uuid' }, [{ itemId: it, quantidade: 1 }])).s, 400);
  assert.deepEqual(await estado(), antes, 'as recusas não gravaram nada');
  // tudo de uma vez; depois não sobra o que devolver
  r = await dev(e, [{ itemId: it, quantidade: 3 }]); assert.deepEqual([r.s, r.j.status], [200, 'aguardando_conferencia']);
  r = await dev(e, [{ itemId: it, quantidade: 1 }]); assert.equal(r.s, 409);
  // conferência: acima do que está em conferência, zero, decimal, resultado inválido, avaria/recusa sem explicação
  r = await conf(e, [{ itemId: it, quantidade: 4, resultado: 'boa' }]); assert.equal(r.s, 409); assert.match(r.j.erro, /Só há/);
  for (const q of [0, -1, '1,5', '']) assert.equal((await conf(e, [{ itemId: it, quantidade: q, resultado: 'boa' }])).s, 400, `conferência ${JSON.stringify(q)}`);
  r = await conf(e, [{ itemId: it, quantidade: 0.5, resultado: 'boa' }]); assert.equal(r.s, 400);
  r = await conf(e, [{ itemId: it, quantidade: 1, resultado: 'otima' }]); assert.deepEqual([r.s, r.j.erro], [400, 'Resultado da conferência inválido.']);
  for (const res of ['avaria', 'recusada']) {
    r = await conf(e, [{ itemId: it, quantidade: 1, resultado: res, observacao: 'x' }]); assert.deepEqual([r.s, r.j.erro], [400, 'Explique a avaria ou a divergência.'], res);
  }
  // recusada volta a ser pendente (e pode ser devolvida de novo); boa e avaria fecham o item
  r = await conf(e, [{ itemId: it, quantidade: 2, resultado: 'recusada', observacao: 'Voltou incompleta' }]);
  assert.deepEqual([r.s, r.j.status], [200, 'aguardando_conferencia']);
  fecha(await saldo(F.chave));
  r = await conf(e, [{ itemId: it, quantidade: 1, resultado: 'boa' }]); assert.deepEqual([r.s, r.j.status], [200, 'parcialmente_devolvido']);
  r = await conf(e, [{ itemId: it, quantidade: 1, resultado: 'boa' }]); assert.equal(r.s, 409, 'nada mais em conferência');
  r = await dev(e, [{ itemId: it, quantidade: 2 }]); assert.deepEqual([r.s, r.j.status], [200, 'aguardando_conferencia'], 'a recusada voltou ao pendente');
  r = await conf(e, [{ itemId: it, quantidade: 1, resultado: 'avaria', observacao: 'Boca da chave espanada' }, { itemId: it, quantidade: 1, resultado: 'boa' }]);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(await statusDe(e), 'devolvido');
  fecha(await saldo(F.chave));
});

test('conferência: o mesmo item em duas linhas não passa do que está em conferência (e a transação inteira se desfaz)', async () => {
  const e = await novoEmprestimo('t3', [{ ferramentaId: F.chave, quantidade: '2' }]);
  const it = e.itens[0].id;
  await dev(e, [{ itemId: it, quantidade: 2 }]);
  const antes = await saldo(F.chave);
  const r = await conf(e, [{ itemId: it, quantidade: 2, resultado: 'boa' }, { itemId: it, quantidade: 2, resultado: 'boa' }]);
  assert.equal(r.s, 409, JSON.stringify(r.j));
  assert.deepEqual(await saldo(F.chave), antes, 'transação inteira desfeita');
  assert.equal(await statusDe(e), 'aguardando_conferencia');
  const r2 = await conf(e, [{ itemId: it, quantidade: 1, resultado: 'avaria', observacao: 'Cabo descascado' }, { itemId: it, quantidade: 1, resultado: 'boa' }]);
  assert.equal(r2.s, 200, JSON.stringify(r2.j));
  assert.equal(await statusDe(e), 'devolvido');
  const s = await saldo(F.chave); fecha(s);
  assert.equal(s.manutencao, antes.manutencao + 1); assert.equal(s.disponivel, antes.disponivel + 1);
});

test('baixa: zero, negativa, decimal, acima do pendente, item em conferência, consumo de ferramenta, motivo e explicação; estornado não se movimenta', async () => {
  const e = await novoEmprestimo('t5', [{ ferramentaId: F.chave, quantidade: '3' }]);
  const it = e.itens[0].id;
  const base = { itemId: it, motivo: 'extravio', justificativa: 'Perdida na área 3' };
  const antes = await estado();
  for (const q of [0, -1, '1,5', '', null]) { const r = await baixa(e, { ...base, quantidade: q }); assert.deepEqual([r.s, r.j.erro], [400, 'Quantidade inválida.'], `quantidade ${JSON.stringify(q)}`); }
  let r = await baixa(e, { ...base, quantidade: 0.5 }); assert.deepEqual([r.s, r.j.erro], [400, 'Ferramenta se movimenta em unidades inteiras.']);
  r = await baixa(e, { ...base, quantidade: 4 }); assert.equal(r.s, 409); assert.match(r.j.erro, /passa do que está pendente/);
  r = await baixa(e, { ...base, quantidade: 1, motivo: 'consumo' }); assert.deepEqual([r.s, r.j.erro], [400, 'Consumo só vale para material; ferramenta perdida é extravio.']);
  r = await baixa(e, { ...base, quantidade: 1, motivo: 'furto' }); assert.deepEqual([r.s, r.j.erro], [400, 'Motivo da baixa inválido.']);
  r = await baixa(e, { ...base, quantidade: 1, justificativa: 'ok' }); assert.deepEqual([r.s, r.j.erro], [400, 'Explique a baixa.']);
  r = await painel(U.alm, 'POST', `${API}/emprestimos/${e.id}/baixas`, { quantidade: 1, motivo: 'extravio', justificativa: 'Perdida na área 3' }); assert.equal(r.s, 400, 'sem itemId');
  assert.deepEqual(await estado(), antes, 'as recusas não gravaram nada');
  // extravio parcial: 2 de 3
  r = await baixa(e, { ...base, quantidade: 2, numeroBaixa: 'BX-C-1' });
  assert.deepEqual([r.s, r.j.status], [200, 'parcialmente_devolvido'], JSON.stringify(r.j));
  const s = await saldo(F.chave); fecha(s); assert.ok(s.baixada >= 2);
  // o que falta volta e é conferido: o empréstimo fecha como "encerrado" (teve baixa)
  assert.equal((await dev(e, [{ itemId: it, quantidade: 1 }])).s, 200);
  assert.equal((await baixa(e, { ...base, quantidade: 1 })).s, 409, 'o que está em conferência não pode ser baixado');
  assert.equal((await conf(e, [{ itemId: it, quantidade: 1, resultado: 'boa' }])).s, 200);
  assert.equal(await statusDe(e), 'encerrado');
  assert.equal((await painel(U.ges, 'POST', `${API}/emprestimos/${e.id}/estorno`, { justificativa: 'Tentativa depois da baixa' })).s, 409, 'estorno só sem devolução nem baixa');
  assert.equal((await baixa(e, { ...base, quantidade: 1 })).s, 409, 'fechado não recebe baixa');
  // estornado: nada mais se movimenta
  const est = await novoEmprestimo('t5', [{ ferramentaId: F.chave, quantidade: '1' }]);
  assert.equal((await painel(U.ges, 'POST', `${API}/emprestimos/${est.id}/estorno`, { justificativa: 'Lançado para a pessoa errada' })).s, 200);
  r = await baixa(est, { itemId: est.itens[0].id, quantidade: 1, motivo: 'extravio', justificativa: 'Tentativa em estornado' }); assert.deepEqual([r.s, r.j.erro], [409, 'Empréstimo estornado.']);
  r = await dev(est, [{ itemId: est.itens[0].id, quantidade: 1 }]); assert.deepEqual([r.s, r.j.erro], [409, 'Este empréstimo já está fechado.']);
  r = await conf(est, [{ itemId: est.itens[0].id, quantidade: 1, resultado: 'boa' }]); assert.equal(r.s, 409);
  r = await painel(U.alm, 'POST', `${API}/emprestimos/${est.id}/prazo`, { prazo: noPrazo(48), justificativa: 'Tentativa em estornado' }); assert.deepEqual([r.s, r.j.erro], [409, 'Este empréstimo já está fechado.']);
  r = await painel(U.ges, 'POST', `${API}/emprestimos/${est.id}/estorno`, { justificativa: 'Estorno repetido no teste' }); assert.deepEqual([r.s, r.j.erro], [409, 'Empréstimo já estornado.']);
  fecha(await saldo(F.chave));
});

test('ajuste de saldo: entrada, manutenção, baixa, acima do que há (400), quantidade zero, decimal e enorme; ferramenta individual exige a unidade', async () => {
  const f = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C007', nome: 'Ajuste de cobertura (teste)', controle: 'quantidade', total: '4' })).id;
  const aj = (b, id = f) => painel(U.ges, 'POST', `${API}/ferramentas/${id}/ajustes`, { justificativa: 'Teste de ajuste de cobertura', ...b });
  for (const q of [0, -1, '1,5', '', null, 100000, '1e2']) { const r = await aj({ movimento: 'entrada', quantidade: q }); assert.deepEqual([r.s, r.j.erro], [400, 'Quantidade inválida.'], `entrada ${JSON.stringify(q)}`); }
  let r = await aj({ movimento: 'entrada', quantidade: 1 }); assert.equal(r.s, 200);
  r = await aj({ movimento: 'para_manutencao', quantidade: 6 }); assert.deepEqual([r.s, r.j.erro], [400, 'O ajuste deixaria o saldo negativo: confira o disponível e a manutenção na ficha.'], 'mais que o disponível: o banco recusa, o saldo não fica negativo');
  r = await aj({ movimento: 'de_manutencao', quantidade: 1 }); assert.deepEqual([r.s, r.j.erro], [400, 'O ajuste deixaria o saldo negativo: confira o disponível e a manutenção na ficha.'], 'nada em manutenção');
  r = await aj({ movimento: 'baixar', quantidade: 6, de: 'disponivel' }); assert.deepEqual([r.s, r.j.erro], [400, 'O ajuste deixaria o saldo negativo: confira o disponível e a manutenção na ficha.']);
  r = await aj({ movimento: 'baixar', quantidade: 1 }); assert.equal(r.s, 200, 'baixa do disponível é o padrão');
  r = await aj({ movimento: 'baixar', quantidade: 1, de: 'emprestada' }); assert.deepEqual([r.s, r.j.erro], [400, 'Informe de onde sai a baixa (disponível ou manutenção).']);
  r = await aj({ movimento: 'para_manutencao', quantidade: 2 }); assert.equal(r.s, 200);
  r = await aj({ movimento: 'baixar', quantidade: 1, de: 'manutencao' }); assert.equal(r.s, 200);
  r = await aj({ movimento: 'sumiu', quantidade: 1 }); assert.deepEqual([r.s, r.j.erro], [400, 'Movimento inválido.']);
  r = await painel(U.ges, 'POST', `${API}/ferramentas/${f}/ajustes`, { movimento: 'entrada', quantidade: 1, justificativa: 'ok' }); assert.deepEqual([r.s, r.j.erro], [400, 'Explique o ajuste.']);
  const s = await saldo(f); fecha(s);
  assert.deepEqual(s, { total: 5, disponivel: 2, emprestada: 0, em_conferencia: 0, manutencao: 1, baixada: 2 });
  // individual: unidade obrigatória, quantidade 1, entrada só pelo cadastro da unidade; a mesma unidade não vai duas vezes à manutenção
  const estadoUn = async id => (await h.q('SELECT estado FROM emprestimo.ferramenta_unidade WHERE id=$1', [id])).rows[0].estado;
  r = await aj({ movimento: 'para_manutencao', quantidade: 1 }, F.serra); assert.equal(r.s, 400, 'sem a unidade');
  r = await aj({ movimento: 'entrada', quantidade: 1, unidadeId: F.u3 }, F.serra); assert.equal(r.s, 400, 'entrada em individual');
  r = await aj({ movimento: 'para_manutencao', quantidade: 2, unidadeId: F.u3 }, F.serra); assert.equal(r.s, 400, 'quantidade 2 em unidade');
  r = await aj({ movimento: 'para_manutencao', quantidade: 1, unidadeId: F.u1 }, F.serra); assert.equal(r.s, 404, 'unidade de outra ferramenta');
  r = await aj({ movimento: 'para_manutencao', quantidade: 1, unidadeId: F.u3 }, F.serra); assert.equal(r.s, 200);
  r = await aj({ movimento: 'para_manutencao', quantidade: 1, unidadeId: F.u3 }, F.serra); assert.equal(r.s, 409, 'já está em manutenção');
  assert.equal(await estadoUn(F.u3), 'manutencao');
  r = await aj({ movimento: 'de_manutencao', quantidade: 1, unidadeId: F.u3 }, F.serra); assert.equal(r.s, 200);
  assert.equal(await estadoUn(F.u3), 'disponivel');
  fecha(await saldo(F.serra));
  // emprestada não vai para a manutenção nem é baixada pelo ajuste
  const e = await novoEmprestimo('t6', [{ ferramentaId: F.serra, unidadeId: F.u3, quantidade: '1' }]);
  r = await aj({ movimento: 'para_manutencao', quantidade: 1, unidadeId: F.u3 }, F.serra); assert.equal(r.s, 409, 'emprestada não pode ir para a manutenção');
  r = await aj({ movimento: 'baixar', quantidade: 1, unidadeId: F.u3 }, F.serra); assert.equal(r.s, 409, 'nem ser baixada pelo ajuste');
  await exec(U.ges, 'estornar', { emprestimoId: e.id, justificativa: 'Teste de ajuste' });
  assert.equal(await estadoUn(F.u3), 'disponivel');
});

/* ---------------------------------------------------------------- prazo */
test('prazo: passado, 91 dias, 90 dias mais 1 h, texto e vazio; o limite de 90 dias vale também para o novo prazo; fechado não muda; o terminal não tem rota de prazo', async () => {
  F.estoque = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C006', nome: 'Estoque grande de cobertura (teste)', controle: 'quantidade', total: '200' })).id;
  const ret = prazo => retirar('painel', [{ ferramentaId: F.estoque, quantidade: 1 }], prazo === undefined ? {} : { prazo });
  const MSG = 'O prazo precisa estar entre agora e 90 dias.';
  for (const p of [noPrazo(-1), noPrazo(-24 * 365), noPrazo(91 * 24), noPrazo(90 * 24 + 1), '2000-01-01', '2999-01-01']) {
    const r = await ret(p); assert.deepEqual([r.s, r.j.erro], [400, MSG], String(p));
  }
  let r = await ret('amanhã'); assert.equal(r.s, 400, 'texto'); assert.match(r.j.erro, /Dados inválidos/);
  r = await ret(noPrazo(89 * 24)); assert.equal(r.s, 201, '89 dias entra');
  r = await ret(noPrazo(90 * 24 - 0.1)); assert.equal(r.s, 201, 'a poucos minutos dos 90 dias entra');
  r = await ret(new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10)); assert.equal(r.s, 201, 'só a data entra');
  r = await ret(''); assert.equal(r.s, 201, 'vazio: prazo padrão');
  r = await ret(noPrazo(2)); assert.equal(r.s, 201); F.empPrazo = r.j.id;
  const e = (await h.q('SELECT prazo FROM emprestimo.emprestimo WHERE id=$1', [F.empPrazo])).rows[0];
  assert.ok(Math.abs(new Date(e.prazo) - Date.now() - 2 * HORA) < 60e3, 'prazo gravado como pedido');
  // novo prazo
  const novo = (id, b) => painel(U.alm, 'POST', `${API}/emprestimos/${id}/prazo`, b);
  for (const [b, rot] of [[{ prazo: noPrazo(-1), justificativa: 'Voltar no tempo' }, 'passado'], [{ prazo: noPrazo(91 * 24), justificativa: 'Muito longe' }, '91 dias'],
    [{ prazo: noPrazo(90 * 24 + 1), justificativa: 'Muito longe' }, '90 dias e 1 h'], [{ justificativa: 'Sem data' }, 'sem prazo'], [{ prazo: '', justificativa: 'Sem data' }, 'prazo vazio']]) {
    const x = await novo(F.empPrazo, b); assert.deepEqual([x.s, x.j.erro], [400, MSG], rot);
  }
  let x = await novo(F.empPrazo, { prazo: 'quando der', justificativa: 'Texto no prazo' }); assert.equal(x.s, 400, 'texto'); assert.match(x.j.erro, /Dados inválidos/);
  for (const j of ['', 'abc', '    ']) { x = await novo(F.empPrazo, { prazo: noPrazo(48), justificativa: j }); assert.deepEqual([x.s, x.j.erro], [400, 'Explique a mudança de prazo.'], JSON.stringify(j)); }
  x = await novo(F.empPrazo, { prazo: noPrazo(89 * 24), justificativa: 'Serviço de longa duração' }); assert.equal(x.s, 200, JSON.stringify(x.j));
  const ev = (await h.q("SELECT justificativa, por FROM emprestimo.emprestimo_evento WHERE emprestimo_id=$1 AND tipo='prazo'", [F.empPrazo])).rows;
  assert.equal(ev.length, 1); assert.match(ev[0].justificativa, /^Serviço de longa duração \(de \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\)$/, 'o prazo antigo fica no histórico'); assert.equal(ev[0].por, U.alm.id);
  // fechado não muda
  const fechado = await novoEmprestimo('t6', [{ ferramentaId: F.estoque, quantidade: '1' }]);
  await exec(U.alm, 'devolver', { emprestimoId: fechado.id, itens: [{ itemId: fechado.itens[0].id, quantidade: '1' }] });
  await exec(U.alm, 'conferir', { emprestimoId: fechado.id, itens: [{ itemId: fechado.itens[0].id, quantidade: '1', resultado: 'boa' }] });
  x = await novo(fechado.id, { prazo: noPrazo(48), justificativa: 'Reabrir o fechado' }); assert.deepEqual([x.s, x.j.erro], [409, 'Este empréstimo já está fechado.']);
  // o terminal não muda prazo (nem de longe): sem rota; e o cookie do terminal não vale no painel
  const t = F.tab.t1;
  assert.equal((await t.req('POST', `/api/terminal/emprestimos/${F.empPrazo}/prazo`, { prazo: noPrazo(48), justificativa: 'Pelo tablet' })).s, 404);
  assert.equal((await t.req('POST', `${API}/emprestimos/${F.empPrazo}/prazo`, { prazo: noPrazo(48), justificativa: 'Pelo tablet' })).s, 401);
});

/* ---------------------------------------------------------------- matrícula */
test('matrícula no tablet: espaços nas pontas e número JSON valem; espaço no meio, símbolo e acento não; mesma resposta para tudo que não entra', async () => {
  const t = tablet();
  const igual = { ok: false, erro: 'Matrícula ou senha inválidas.' };
  for (const m of [` ${MAT.t1} `, `\t${MAT.t1}\n`, 810001]) { const r = await tablet().entrar(m, SENHA('t1')); assert.equal(r.s, 200, JSON.stringify(m)); assert.equal(r.j.colaborador.matricula, MAT.t1); }
  for (const m of ['81 0001', '810-001', '8100', '810001x', 'Ç10001', '', ' ', null, undefined, [], {}, '../810001', "810001' OR '1'='1"]) {
    const r = await t.entrar(m, SENHA('t1')); assert.deepEqual([r.s, r.j], [401, igual], JSON.stringify(m));
  }
  // cadastro no painel: o formato é o mesmo do tablet
  for (const m of ['AB 12', 'Ç1234', 'ab', 'a'.repeat(21), 'A-1234', '12', '']) {
    const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa c1', email: U.c1.email, matricula: m, setor: 'Manutenção' });
    assert.equal(r.s, 400, JSON.stringify(m));
  }
  assert.equal((await painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa c1', email: U.c1.email, matricula: ` ${MAT.c1} `, setor: 'Manutenção', centroCusto: 'CC-c1', cargo: 'Mecânico' })).s, 200, 'espaços nas pontas são aparados');
  assert.equal((await h.q('SELECT matricula FROM emprestimo.colaborador WHERE usuario_id=$1', [U.c1.id])).rows[0].matricula, MAT.c1);
  assert.equal((await painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa c2', email: U.c2.email, matricula: MAT.c1, setor: 'M' })).s, 409, 'matrícula de outra pessoa');
});

/* ---------------------------------------------------------------- convite */
test('convite: colaborador desativado, usuário inativo ou bloqueado no site, id inválido, alvo desconhecido; código de outra pessoa não vale; só um convite fica valendo', async () => {
  const cad = ativo => painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa c1', email: U.c1.email, matricula: MAT.c1, setor: 'Manutenção', centroCusto: 'CC-c1', cargo: 'Mecânico', ativo });
  const conv = u => painel(U.alm, 'POST', `${API}/colaboradores/${u.id}/convite`);
  const MSG = 'Colaborador inativo ou bloqueado não recebe convite.';
  await cad(false);
  let r = await conv(U.c1); assert.deepEqual([r.s, r.j.erro], [409, MSG], 'cadastro desativado');
  await cad(true);
  await h.q('UPDATE core.usuario SET ativo=false WHERE id=$1', [U.c1.id]);
  r = await conv(U.c1); assert.deepEqual([r.s, r.j.erro], [409, MSG], 'usuário desativado no site');
  await h.q('UPDATE core.usuario SET ativo=true, bloqueado=true, motivo_bloqueio=$2 WHERE id=$1', [U.c1.id, 'Teste de cobertura']);
  r = await conv(U.c1); assert.deepEqual([r.s, r.j.erro], [409, MSG], 'usuário bloqueado no site');
  await h.q('UPDATE core.usuario SET bloqueado=false, motivo_bloqueio=NULL WHERE id=$1', [U.c1.id]);
  r = await painel(U.alm, 'POST', `${API}/colaboradores/nao-e-uuid/convite`); assert.deepEqual([r.s, r.j.erro], [400, 'Identificador inválido.']);
  r = await painel(U.alm, 'POST', `${API}/colaboradores/00000000-0000-4000-8000-0000000000bb/convite`); assert.deepEqual([r.s, r.j.erro], [404, 'Colaborador não cadastrado no terminal.']);
  r = await painel(U.alm, 'POST', `${API}/colaboradores/${U.pcm.id}/convite`); assert.deepEqual([r.s, r.j.erro], [404, 'Colaborador não cadastrado no terminal.'], 'quem não é colaborador');
  // código de outra pessoa
  const k1 = await conv(U.c1), k2 = await conv(U.c2);
  assert.equal(k1.s, 201); assert.equal(k2.s, 201);
  const t = tablet();
  const MSG_COD = 'Código inválido ou expirado.';
  // quatro erros (o quinto trava a matrícula por 5 min, como a senha) e o código certo ainda entra
  for (const codigo of [k2.j.codigo, null, 12345678, ['ABCD-EFGH']]) {
    r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c1, codigo, senha: SENHA('c1') });
    assert.deepEqual([r.s, r.j.erro], [400, MSG_COD], JSON.stringify(codigo).slice(0, 40));
  }
  for (const codigo of ['', {}, 'x'.repeat(500), undefined]) {   // formatos estranhos: mesma resposta (matrícula que não existe, sem gastar a de c1)
    r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: '899999', codigo, senha: SENHA('c1') });
    assert.deepEqual([r.s, r.j.erro], [400, MSG_COD], JSON.stringify(codigo)?.slice(0, 40));
  }
  r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c1, codigo: k1.j.codigo, senha: ['ArrayDeSenha1'] }); assert.equal(r.s, 400); assert.match(r.j.erro, /8 caracteres/);
  r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c1, codigo: k1.j.codigo, senha: SENHA('c1') });
  assert.equal(r.s, 200, `o código certo ainda vale depois das tentativas erradas: ${JSON.stringify(r.j)}`);
  r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c2, codigo: k2.j.codigo, senha: SENHA('c2') });
  assert.equal(r.s, 200, 'o convite de c2 não foi gasto pelo uso do código dele em c1');
  // três convites ao mesmo tempo: só um fica aberto, e só um dos códigos entra
  const tres = await Promise.all([1, 2, 3].map(() => conv(U.c3)));
  assert.deepEqual(tres.map(x => x.s), [201, 201, 201]);
  assert.equal((await h.q('SELECT count(*)::int n FROM emprestimo.terminal_convite WHERE usuario_id=$1 AND usado_em IS NULL AND invalidado_em IS NULL', [U.c3.id])).rows[0].n, 1);
  const entradas = [];
  for (const x of tres) entradas.push((await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c3, codigo: x.j.codigo, senha: SENHA('c3') })).s);
  assert.deepEqual(entradas.sort(), [200, 400, 400], 'exatamente um código vale');
});

test('cookie do terminal adulterado, truncado, vazio ou enorme é recusado (401); o verdadeiro continua valendo', async () => {
  const t = tablet();
  assert.equal((await t.entrar(MAT.t1, SENHA('t1'))).s, 200);
  const bom = t.cookie.split('=')[1];
  const [payload, assinatura] = bom.split('.');
  const troca = s => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');
  const dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forjado = d => Buffer.from(JSON.stringify(d)).toString('base64url');
  const variantes = { assinaturaTrocada: `${payload}.${troca(assinatura)}`, payloadTrocado: `${troca(payload)}.${assinatura}`, semAssinatura: payload, soPonto: '.', vazio: '',
    versaoOutra: `${forjado({ ...dados, cv: dados.cv + 1 })}.${assinatura}`, outraPessoa: `${forjado({ ...dados, sub: U.t2.id })}.${assinatura}`, enorme: 'A'.repeat(5000) + '.' + assinatura,
    expiradoNoCorpo: `${forjado({ ...dados, exp: dados.iat - 10 })}.${assinatura}`, valorDoSite: createSession({ id: U.alm.id, sessaoVersao: U.alm.sv }).valor };
  for (const [nome, valor] of Object.entries(variantes)) {
    const r = await tablet().req('GET', '/api/terminal/eu', undefined, { cookie: `biotrop_terminal=${valor}` });
    assert.deepEqual([nome, r.s], [nome, 401]);
  }
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 200, 'o cookie verdadeiro segue valendo');
});

/* ---------------------------------------------------------------- avisos por e-mail */
async function emprestarComPrazo(k, itens, horasAtePrazo = 72) {
  const r = await exec(U.alm, 'emprestar', { colaboradorId: U[k].id, chave: chave(), prazo: noPrazo(horasAtePrazo), itens });
  const e = (await h.q('SELECT id, numero, prazo FROM emprestimo.emprestimo WHERE id=$1', [r.id])).rows[0];
  return { id: e.id, numero: e.numero, prazo: new Date(e.prazo) };
}
const avisosDe = async e => (await h.q(`SELECT a.tipo, a.janela, a.observacao, a.email_id, f.destinatario::text AS para, f.copia::text[] AS cc, f.status::text AS status, f.erro, f.motivo
  FROM emprestimo.aviso a LEFT JOIN core.email_fila f ON f.id = a.email_id WHERE a.emprestimo_id=$1 ORDER BY a.criado_em, a.tipo, a.janela`, [e.id])).rows;
const tipos = async e => (await avisosDe(e)).map(a => a.tipo);
const marcarEnviado = e => h.q("UPDATE core.email_fila SET status='enviado', enviado_em=now() WHERE status='pendente' AND id IN (SELECT email_id FROM emprestimo.aviso WHERE emprestimo_id=$1)", [e.id]);

test('avisos: prazo estendido depois do lembrete enviado — nada novo no prazo antigo; o prazo novo ganha o próprio lembrete e vencimento, uma vez só', async () => {
  const e = await emprestarComPrazo('t3', [{ ferramentaId: F.estoque, quantidade: '1' }], 72);
  const velho = +e.prazo;
  await rodar(velho - HORA);
  assert.deepEqual(await tipos(e), ['lembrete']);
  await marcarEnviado(e);
  const novo = Date.now() + 240 * HORA;
  const r = await painel(U.alm, 'POST', `${API}/emprestimos/${e.id}/prazo`, { prazo: new Date(novo).toISOString(), justificativa: 'Serviço estendido' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const prazoNovo = +new Date((await h.q('SELECT prazo FROM emprestimo.emprestimo WHERE id=$1', [e.id])).rows[0].prazo);
  for (const horas of [1, 25, 49, 100]) { await rodar(velho + horas * HORA); assert.deepEqual(await tipos(e), ['lembrete'], `+${horas} h do prazo antigo: nada novo`); }
  await rodar(prazoNovo - 2 * HORA); await rodar(prazoNovo - 2 * HORA);
  assert.deepEqual(await tipos(e), ['lembrete', 'lembrete'], 'o prazo novo tem o próprio lembrete, e repetir o ciclo não duplica');
  const janelas = (await avisosDe(e)).map(a => a.janela);
  assert.equal(new Set(janelas).size, 2, 'janelas diferentes');
  await rodar(prazoNovo + HORA); await rodar(prazoNovo + HORA);
  assert.deepEqual((await tipos(e)).sort(), ['lembrete', 'lembrete', 'vencimento']);
  await rodar(prazoNovo + 25 * HORA); await rodar(prazoNovo + 25 * HORA);
  assert.deepEqual((await tipos(e)).sort(), ['atraso', 'lembrete', 'lembrete', 'vencimento']);
});

test('avisos: o atraso pendente na fila é cancelado quando o prazo é estendido, e o empréstimo sai do atraso', async () => {
  const e = await emprestarComPrazo('t4', [{ ferramentaId: F.estoque, quantidade: '1' }], 72);
  await rodar(+e.prazo + 25 * HORA);
  const antes = (await avisosDe(e)).filter(a => a.tipo === 'atraso');
  assert.equal(antes.length, 1); assert.equal(antes[0].status, 'pendente');
  const r = await painel(U.alm, 'POST', `${API}/emprestimos/${e.id}/prazo`, { prazo: noPrazo(240), justificativa: 'Serviço estendido' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  await rodar(+e.prazo + 26 * HORA);
  const depois = (await avisosDe(e)).filter(a => a.tipo === 'atraso');
  assert.deepEqual([depois[0].status, depois[0].erro], ['cancelado', 'Cancelado: o prazo do empréstimo mudou']);
  assert.equal(depois.length, 1, 'e nenhum atraso novo');
});

test('colaborador desligado com empréstimo aberto: a sessão cai, não entra nem recebe convite; o almoxarife ainda recebe a devolução; o aviso do atraso vira "pulado", o escalonamento vai ao almoxarifado e reativar volta a cobrar só o que falta', async () => {
  const t = await (async () => { const x = tablet(); assert.equal((await x.entrar(MAT.t5, SENHA('t5'))).s, 200); return x; })();
  let r = await t.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.estoque, quantidade: 1 }, { ferramentaId: F.furadeira, unidadeId: F.u1, quantidade: 1 }], chave: chave() });
  assert.equal(r.s, 201, JSON.stringify(r.j));
  const e = { id: r.j.id, numero: r.j.numero };
  await h.q("UPDATE emprestimo.emprestimo SET prazo = now() + interval '1 hour' WHERE id=$1", [e.id]);
  e.prazo = new Date((await h.q('SELECT prazo FROM emprestimo.emprestimo WHERE id=$1', [e.id])).rows[0].prazo);
  const cad = ativo => painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa t5', email: U.t5.email, matricula: MAT.t5, setor: 'Manutenção', centroCusto: 'CC-t5', cargo: 'Mecânico', ativo });
  assert.equal((await cad(false)).s, 200);
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401, 'a sessão cai na hora');
  const negado = await tablet().entrar(MAT.t5, SENHA('t5'));
  assert.deepEqual([negado.s, negado.j], [401, { ok: false, erro: 'Matrícula ou senha inválidas.' }], 'mesma resposta de quem não existe');
  r = await painel(U.alm, 'POST', `${API}/colaboradores/${U.t5.id}/convite`); assert.equal(r.s, 409);
  // o empréstimo continua aberto e visível ao almoxarife, com o colaborador marcado como inativo
  r = await painel(U.alm, 'GET', `${API}/emprestimos/${e.id}`);
  assert.equal(r.j.emprestimo.colaboradorNome, 'Pessoa t5'); assert.ok(['em_andamento'].includes(r.j.emprestimo.status));
  assert.equal((await painel(U.alm, 'GET', `${API}/colaboradores?q=${MAT.t5}`)).j.rows[0].ativo, false);
  // avisos: o atraso prolongado escala ao almoxarifado, com a gestão em cópia (o desligado não entra)
  await rodar(+e.prazo + HORA);
  await rodar(+e.prazo + 25 * HORA);
  await rodar(+e.prazo + 49 * HORA);
  const a = await avisosDe(e);
  const esc = a.filter(x => x.tipo === 'escalonamento');
  assert.equal(esc.length, 1);
  assert.ok(esc[0].para && esc[0].para !== U.t5.email && [U.alm.email, U.alm2.email].includes(esc[0].para), `escalonamento ao almoxarifado: ${esc[0].para}`);
  assert.ok(esc[0].cc.includes(U.ges.email) && !esc[0].cc.includes(U.t5.email), 'gestor em cópia; o colaborador desligado não entra');
  // devolução parcial pelo balcão com o colaborador desligado: a furadeira vai a conferência; a chave continua pendente
  const itens = (await h.q('SELECT id, ferramenta_id FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1', [e.id])).rows;
  const fur = itens.find(i => i.ferramenta_id === F.furadeira), chv = itens.find(i => i.ferramenta_id === F.estoque);
  r = await dev({ id: e.id }, [{ itemId: fur.id, quantidade: 1 }]); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await conf({ id: e.id }, [{ itemId: fur.id, quantidade: 1, resultado: 'boa' }]); assert.equal(r.s, 200, JSON.stringify(r.j));
  // reativado volta a entrar com a mesma senha (a credencial não se perde) e é cobrado só pelo que falta
  assert.equal((await cad(true)).s, 200);
  assert.equal((await tablet().entrar(MAT.t5, SENHA('t5'))).s, 200, 'reativado entra com a senha de antes');
  await rodar(+e.prazo + 73 * HORA);
  const dias = (await avisosDe(e)).filter(x => x.tipo === 'atraso' && x.email_id && x.janela.endsWith(':3'));
  assert.equal(dias.length, 1, 'o atraso seguinte já vai ao colaborador reativado');
  assert.equal(dias[0].para, U.t5.email);
  const corpo = (await h.q('SELECT f.corpo_html FROM core.email_fila f JOIN emprestimo.aviso a ON a.email_id = f.id WHERE a.emprestimo_id=$1 AND a.tipo=$2 AND a.janela LIKE $3', [e.id, 'atraso', '%:3'])).rows[0].corpo_html;
  assert.match(corpo, /Estoque grande de cobertura/); assert.doesNotMatch(corpo, /Furadeira de cobertura/, 'só a quantidade pendente aparece');
  assert.ok(!/810005|CC-t5|Senha-Cobertura/.test(corpo), 'sem matrícula, centro de custo nem senha no e-mail');
  r = await dev({ id: e.id }, [{ itemId: chv.id, quantidade: 1 }]); assert.equal(r.s, 200);
  await conf({ id: e.id }, [{ itemId: chv.id, quantidade: 1, resultado: 'boa' }]);
  assert.equal((await statusDe(e)), 'devolvido');
});

test('colaborador com cadastro desativado (desligado) não recebe lembrete, vencimento nem atraso: o aviso fica "pulado" e a cobrança escala ao almoxarifado',
  async () => {
    const e = await emprestarComPrazo('c2', [{ ferramentaId: F.estoque, quantidade: '1' }], 72);
    const cad = ativo => painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa c2', email: U.c2.email, matricula: MAT.c2, setor: 'Manutenção', centroCusto: 'CC-c2', cargo: 'Mecânico', ativo });
    assert.equal((await cad(false)).s, 200);
    try {
      await rodar(+e.prazo + HORA);
      await rodar(+e.prazo + 25 * HORA);
      const a = (await avisosDe(e)).filter(x => ['vencimento', 'atraso'].includes(x.tipo));
      assert.equal(a.length, 2);
      for (const x of a) assert.deepEqual([x.email_id, x.observacao], [null, 'Colaborador inativo'], `${x.tipo}: nada vai a quem foi desligado`);
      assert.equal((await h.q("SELECT count(*)::int n FROM core.email_fila WHERE destinatario=$1 AND motivo LIKE 'emprestimo_%'", [U.c2.email])).rows[0].n, 0, 'nenhum e-mail na fila para o desligado');
    } finally { await cad(true); }
  });

test('colaborador desligado no site (usuário desativado): sessão cai, não entra e não recebe convite; ao voltar, a mesma senha vale', async () => {
  const t = tablet();
  assert.equal((await t.entrar(MAT.t6, SENHA('t6'))).s, 200);
  await h.q('UPDATE core.usuario SET ativo=false WHERE id=$1', [U.t6.id]);
  assert.equal((await t.req('GET', '/api/terminal/ferramentas')).s, 401);
  assert.equal((await tablet().entrar(MAT.t6, SENHA('t6'))).s, 401);
  assert.equal((await painel(U.alm, 'POST', `${API}/colaboradores/${U.t6.id}/convite`)).s, 409);
  const lista = (await painel(U.alm, 'GET', `${API}/colaboradores?q=${MAT.t6}`)).j.rows[0];
  assert.equal(lista.matricula, MAT.t6);
  await h.q('UPDATE core.usuario SET ativo=true WHERE id=$1', [U.t6.id]);
  assert.equal((await tablet().entrar(MAT.t6, SENHA('t6'))).s, 200);
});

/* ---------------------------------------------------------------- foto de ferramenta inativa */
test('ferramenta inativa: o painel vê e troca a foto; o terminal não vê a ferramenta nem a foto (404); a retirada é recusada; o empréstimo aberto ainda é devolvido pelo tablet; reativar traz a foto nova', async () => {
  const f = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C008', nome: 'Com foto e inativa (teste)', controle: 'quantidade', total: '3' })).id;
  let r = await painel(U.alm, 'PUT', `${API}/ferramentas/${f}/foto`, FOTO); assert.equal(r.s, 200, JSON.stringify(r.j)); const v1 = r.j.foto.id;
  const t = tablet(); assert.equal((await t.entrar(MAT.t1, SENHA('t1'))).s, 200);
  r = await t.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: f, quantidade: 1 }], chave: chave() }); assert.equal(r.s, 201); const emp = r.j.id;
  assert.equal((await painel(U.alm, 'PUT', `${API}/ferramentas/${f}`, { ativo: false })).s, 200);
  r = await t.req('GET', '/api/terminal/ferramentas?q=FER-C008'); assert.deepEqual(r.j.rows, [], 'inativa some da lista do tablet');
  assert.equal((await t.req('GET', `/api/terminal/ferramentas/${f}/foto?mini=1`)).s, 404);
  assert.equal((await t.req('GET', `/api/terminal/ferramentas/${f}/foto`)).s, 404);
  r = await painel(U.alm, 'GET', `${API}/ferramentas?situacao=inativas&q=FER-C008`); assert.equal(r.j.rows[0].foto.id, v1, 'o painel continua vendo a foto da inativa');
  assert.equal((await fetch(h.raiz + `${API}/ferramentas/${f}/foto?mini=1`, { headers: { cookie: `biotrop_session=${createSession({ id: U.alm.id, sessaoVersao: U.alm.sv }).valor}`, 'x-forwarded-for': novoIp() } })).status, 200);
  r = await painel(U.alm, 'PUT', `${API}/ferramentas/${f}/foto`, { ...FOTO, imagem: url(bytes.jpeg(4000, 9)) });
  assert.deepEqual([r.s, r.j.trocada], [200, true], 'trocar a foto da inativa'); const v2 = r.j.foto.id; assert.notEqual(v2, v1);
  assert.equal((await t.req('GET', `/api/terminal/ferramentas/${f}/foto?mini=1`)).s, 404, 'continua escondida no tablet');
  // retirada da inativa: recusada no tablet e no painel
  r = await t.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: f, quantidade: 1 }], chave: chave() }); assert.deepEqual([r.s, r.j.erro], [404, 'Ferramenta indisponível no cadastro.']);
  r = await retirar('painel', [{ ferramentaId: f, quantidade: 1 }]); assert.deepEqual([r.s, r.j.erro], [404, 'Ferramenta indisponível no cadastro.']);
  // o empréstimo que já estava aberto continua à vista e a devolução funciona
  r = await t.req('GET', '/api/terminal/emprestimos?situacao=abertos'); assert.ok(r.j.rows.some(x => x.id === emp), 'empréstimo aberto da ferramenta inativa continua em "meus empréstimos"');
  r = await t.req('GET', `/api/terminal/emprestimos/${emp}`); assert.equal(r.s, 200);
  const it = r.j.emprestimo.itensLista[0];
  r = await t.req('POST', `/api/terminal/emprestimos/${emp}/devolucoes`, { itens: [{ itemId: it.id, quantidade: 1, condicao: 'boa' }], chave: chave() });
  assert.deepEqual([r.s, r.j.status], [200, 'aguardando_conferencia'], JSON.stringify(r.j));
  assert.equal((await conf({ id: emp }, [{ itemId: it.id, quantidade: 1, resultado: 'boa' }])).s, 200);
  const s = await saldo(f); assert.deepEqual([s.total, s.disponivel, s.emprestada, s.em_conferencia], [3, 3, 0, 0]);
  // reativar traz a foto nova de volta ao tablet
  assert.equal((await painel(U.alm, 'PUT', `${API}/ferramentas/${f}`, { ativo: true })).s, 200);
  r = await t.req('GET', '/api/terminal/ferramentas?q=FER-C008'); assert.equal(r.j.rows[0].foto.id, v2);
  assert.equal((await t.req('GET', `/api/terminal/ferramentas/${f}/foto?v=${v2}&mini=1`)).s, 200);
});

/* ---------------------------------------------------------------- configuração nos valores-limite */
test('configuração: 90 dias de prazo padrão ainda deixa o terminal retirar; 1 h; um valor além do limite é 400; os avisos aceitam 1 e 720 h e recusam o resto', async () => {
  const cfg = b => painel(U.ges, 'PUT', `${API}/config`, b);
  const tab = tablet(); assert.equal((await tab.entrar(MAT.t2, SENHA('t2'))).s, 200);
  const retiraTerminal = async () => { const r = await tab.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.estoque, quantidade: 1 }], chave: chave() }); assert.equal(r.s, 201, JSON.stringify(r.j)); return (await h.q('SELECT prazo FROM emprestimo.emprestimo WHERE id=$1', [r.j.id])).rows[0].prazo; };
  assert.equal((await cfg({ prazoPadraoHoras: 2160 })).s, 200);
  let prazo = await retiraTerminal();
  assert.ok(Math.abs(new Date(prazo) - Date.now() - 2160 * HORA) < 120e3, 'exatamente 90 dias, e o servidor aceita');
  assert.equal((await cfg({ prazoPadraoHoras: 1 })).s, 200);
  prazo = await retiraTerminal();
  assert.ok(Math.abs(new Date(prazo) - Date.now() - HORA) < 120e3, 'uma hora');
  for (const [b, rot] of [[{ prazoPadraoHoras: 0 }, 'prazo 0'], [{ prazoPadraoHoras: 2161 }, 'prazo 2161'], [{ prazoPadraoHoras: -5 }, 'prazo negativo'], [{ prazoPadraoHoras: 1.5 }, 'prazo 1,5'],
    [{ prazoPadraoHoras: 'muitas' }, 'prazo texto'], [{ prazoPadraoHoras: null }, 'prazo null'], [{ lembreteAntesHoras: 0 }, 'lembrete 0'], [{ lembreteAntesHoras: 721 }, 'lembrete 721'],
    [{ atrasoIntervaloHoras: 0 }, 'intervalo 0'], [{ atrasoIntervaloHoras: 721 }, 'intervalo 721'], [{ inatividadeSegundos: 29 }, 'inatividade 29'], [{ inatividadeSegundos: 901 }, 'inatividade 901'], [{ inatividadeSegundos: '1e9' }, 'inatividade enorme']]) {
    const r = await cfg(b); assert.equal(r.s, 400, `${rot}: ${JSON.stringify(r.j)}`);
  }
  for (const b of [{ lembreteAntesHoras: 1 }, { lembreteAntesHoras: 720 }, { atrasoIntervaloHoras: 1 }, { atrasoIntervaloHoras: 720 }, { inatividadeSegundos: 30 }, { inatividadeSegundos: 900 }, { prazoPadraoHoras: 168, lembreteAntesHoras: 24, atrasoIntervaloHoras: 24, inatividadeSegundos: 90 }]) {
    const r = await cfg(b); assert.equal(r.s, 200, JSON.stringify(b));
  }
  const c = (await painel(U.ges, 'GET', `${API}/config`)).j.config;
  assert.deepEqual([c.prazoPadraoHoras, c.lembreteAntesHoras, c.atrasoIntervaloHoras, c.inatividadeSegundos], [168, 24, 24, 90], 'padrões de volta');
  // avisos: escalonamento de 1 a 720 horas, inteiro
  const av = b => painel(U.ges, 'PUT', `${API}/avisos/config`, b);
  for (const v of [1, 720, '12', 48]) assert.equal((await av({ escalarAposHoras: v })).s, 200, `escalar ${JSON.stringify(v)}`);
  for (const v of [0, -1, 721, 1.5, '1e2', 'doze', true, null, [], {}]) { const r = await av({ escalarAposHoras: v }); assert.equal(r.s, 400, `escalar ${JSON.stringify(v)}: ${JSON.stringify(r.j)}`); }
  for (const v of ['talvez', 1, 0, 'sim', null, []]) assert.equal((await av({ avisosAtivos: v })).s, 400, `avisosAtivos ${JSON.stringify(v)}`);
  assert.equal((await av({})).s, 400);
  assert.equal((await av([])).s, 400);
  assert.equal((await av({ avisosAtivos: true, avisoNoVencimento: true, avisoDevolucao: false, escalarAposHoras: 48 })).s, 200, 'volta ao padrão');
});

test('inatividade nos extremos: 30 s e 900 s valem no servidor (um segundo a mais encerra a sessão, um a menos não)', async () => {
  for (const [segundos, dentro, fora] of [[30, 29, 31], [900, 899, 901]]) {
    assert.equal((await painel(U.ges, 'PUT', `${API}/config`, { inatividadeSegundos: segundos })).s, 200);
    const t = tablet();
    const r = await t.entrar(MAT.t1, SENHA('t1')); assert.equal(r.s, 200); assert.equal(r.j.inatividadeSegundos, segundos);
    assert.ok(new Date(r.j.expiraEm) - Date.now() <= Math.min(segundos * 1000, 30 * 60e3) + 2000, 'expiraEm respeita o menor entre a inatividade e os 30 min');
    const ultimo = s => h.q("UPDATE emprestimo.terminal_sessao SET ultimo_uso = now() - make_interval(secs => $2) WHERE usuario_id=$1 AND encerrada_em IS NULL", [U.t1.id, s]);
    await ultimo(dentro); assert.equal((await t.req('GET', '/api/terminal/eu')).s, 200, `${dentro} s parado: ainda vale`);
    await ultimo(fora); assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401, `${fora} s parado: encerrada`);
    assert.equal(t.cookie, '');
  }
  assert.equal((await painel(U.ges, 'PUT', `${API}/config`, { inatividadeSegundos: 90 })).s, 200);
});

/* ---------------------------------------------------------------- pesquisa de ferramentas */
test('pesquisa: código, nome, descrição, categoria, marca, modelo e localização (sem acento e sem diferenciar maiúsculas); termos se somam; % _ e \\ valem como texto', async () => {
  const tab = tablet(); assert.equal((await tab.entrar(MAT.t1, SENHA('t1'))).s, 200);
  const codigos = async (via, q, extra = '') => {
    const r = via === 'painel' ? await painel(U.alm, 'GET', `${API}/ferramentas?q=${encodeURIComponent(q)}${extra}`) : await tab.req('GET', `/api/terminal/ferramentas?q=${encodeURIComponent(q)}${extra}`);
    assert.equal(r.s, 200, `${via} ${q}: ${JSON.stringify(r.j)}`);
    return r.j.rows.map(x => x.codigo);
  };
  for (const via of ['painel', 'terminal']) {
    for (const q of ['FER-C001', 'fer-c001', 'chave de cobertura', 'testes de cobertura', 'Manual', 'MARCA X', 'modelo y', 'armario c1', 'ARMÁRIO C1', 'marca x modelo y armario', 'c001']) {
      assert.ok((await codigos(via, q)).includes('FER-C001'), `${via}: "${q}" acha a chave`);
    }
    for (const q of ['nada disso existe', '%', '_', '\\', 'fer-c00_', 'fer%', "'; DROP TABLE emprestimo.ferramenta; --", 'chave armario inexistente']) {
      assert.ok(!(await codigos(via, q)).includes('FER-C001'), `${via}: "${q}" não acha a chave`);
      assert.deepEqual((await codigos(via, q)).filter(c => !/^FER-/.test(c)), []);
    }
    assert.equal((await codigos(via, 'x'.repeat(1000))).length, 0, `${via}: texto enorme não quebra`);
    assert.ok((await codigos(via, '')).length >= 5, `${via}: sem texto lista tudo`);
    assert.ok((await codigos(via, '', '&categoria=Manual')).includes('FER-C001'), `${via}: categoria exata`);
    assert.ok(!(await codigos(via, '', '&categoria=Eletrica')).includes('FER-C001'));
  }
  // ordem estável (por nome) e o saldo vem junto
  const r = await tab.req('GET', '/api/terminal/ferramentas?q=FER-C00');
  const nomes = r.j.rows.map(x => x.nome); assert.deepEqual(nomes, [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })));
  for (const f of r.j.rows) { assert.ok(Number.isInteger(f.saldo.total) && f.saldo.total === f.saldo.disponivel + f.saldo.emprestada + f.saldo.emConferencia + f.saldo.manutencao + f.saldo.baixada, f.codigo); }
  // o tablet nunca recebe o que é só da gestão
  assert.ok(r.j.rows.every(f => !('ativo' in f) && !('criadoEm' in f) && !('criadoPor' in f)));
  // ?q repetido ou em formato de objeto não derruba
  for (const qs of ['q=a&q=b', 'q[x]=1', 'q[]=a&q[]=b', 'categoria[x]=1', 'situacao=todas']) assert.equal((await tab.req('GET', `/api/terminal/ferramentas?${qs}`)).s, 200, qs);
  assert.equal((await painel(U.alm, 'GET', `${API}/ferramentas?q=a&q=b&situacao[x]=1`)).s, 200);
});

/* ---------------------------------------------------------------- concorrência pela API */
test('concorrência: seis retiradas da última unidade ao mesmo tempo (só uma passa); a mesma chave em paralelo grava uma vez; devoluções e conferências simultâneas não passam do pendente', async () => {
  const tabs = {};
  for (const k of ['t1', 't2', 't3', 't4', 't5', 't6']) { tabs[k] = tablet(); const r = await tabs[k].entrar(MAT[k], SENHA(k)); assert.equal(r.s, 200, `${k}: ${JSON.stringify(r.j)}`); }
  // última unidade
  const rs = await Promise.all(Object.values(tabs).map(t => t.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.ultima, quantidade: 1 }], chave: chave() })));
  assert.deepEqual(rs.map(r => r.s).sort(), [201, 409, 409, 409, 409, 409], JSON.stringify(rs.map(r => r.j)));
  for (const r of rs.filter(x => x.s === 409)) assert.match(r.j.erro, /Saldo insuficiente/);
  let s = await saldo(F.ultima); assert.deepEqual([s.disponivel, s.emprestada], [0, 1]);
  assert.equal((await h.q('SELECT count(*)::int n FROM emprestimo.emprestimo_item WHERE ferramenta_id=$1', [F.ultima])).rows[0].n, 1, 'uma linha só');
  // a mesma chave seis vezes ao mesmo tempo
  const antes = await saldo(F.estoque);
  const k = chave();
  const seis = await Promise.all(Array.from({ length: 6 }, () => tabs.t1.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.estoque, quantidade: 2 }], chave: k })));
  assert.deepEqual(seis.map(r => r.s).sort(), [200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(seis.map(r => r.j.id)).size, 1, 'todos recebem o mesmo empréstimo');
  assert.deepEqual(seis.map(r => r.j.repetido).sort(), [false, true, true, true, true, true]);
  s = await saldo(F.estoque); assert.deepEqual([s.disponivel, s.emprestada], [antes.disponivel - 2, antes.emprestada + 2], 'saiu uma vez só');
  // quatro devoluções do mesmo item com chaves diferentes: uma passa
  const emp = seis[0].j.id;
  const item = (await tabs.t1.req('GET', `/api/terminal/emprestimos/${emp}`)).j.emprestimo.itensLista[0];
  const quatro = await Promise.all(Array.from({ length: 4 }, () => tabs.t1.req('POST', `/api/terminal/emprestimos/${emp}/devolucoes`, { itens: [{ itemId: item.id, quantidade: 2, condicao: 'boa' }], chave: chave() })));
  assert.deepEqual(quatro.map(r => r.s).sort(), [200, 409, 409, 409], JSON.stringify(quatro.map(r => r.j)));
  const it = (await h.q('SELECT qtd_conferencia::int c, qtd_devolvida::int d FROM emprestimo.emprestimo_item WHERE id=$1', [item.id])).rows[0]; assert.deepEqual(it, { c: 2, d: 0 });
  s = await saldo(F.estoque); assert.equal(s.em_conferencia, antes.em_conferencia + 2);
  // dois almoxarifes conferem o mesmo item ao mesmo tempo: um confere, o outro recebe 409
  const duas = await Promise.all([painel(U.alm, 'POST', `${API}/emprestimos/${emp}/conferencias`, { itens: [{ itemId: item.id, quantidade: 2, resultado: 'boa' }] }),
    painel(U.alm2, 'POST', `${API}/emprestimos/${emp}/conferencias`, { itens: [{ itemId: item.id, quantidade: 2, resultado: 'boa' }] })]);
  assert.deepEqual(duas.map(r => r.s).sort(), [200, 409]);
  s = await saldo(F.estoque); assert.deepEqual([s.disponivel, s.emprestada, s.em_conferencia], [antes.disponivel, antes.emprestada, antes.em_conferencia], 'voltou uma vez só');
  assert.equal(await statusDe({ id: emp }), 'devolvido');
  // estorno e devolução ao mesmo tempo: um deles vence e o saldo continua inteiro
  const e2 = await novoEmprestimo('t2', [{ ferramentaId: F.estoque, quantidade: '1' }]);
  const [est, dv] = await Promise.all([painel(U.ges, 'POST', `${API}/emprestimos/${e2.id}/estorno`, { justificativa: 'Corrida de teste' }), dev(e2, [{ itemId: e2.itens[0].id, quantidade: 1 }])]);
  assert.deepEqual([est.s, dv.s].sort(), [200, 409], "um vence, o outro recebe 409");
  fecha(await saldo(F.estoque));
  // quem ficou com a última devolve; as outras cinco tentam de novo ao mesmo tempo: só uma
  const dono = rs.findIndex(r => r.s === 201), donoTab = Object.values(tabs)[dono];
  const eu = (await donoTab.req('GET', '/api/terminal/emprestimos')).j.rows.find(x => x.itensLista.some(i => i.ferramentaId === F.ultima));
  const d1 = await donoTab.req('POST', `/api/terminal/emprestimos/${eu.id}/devolucoes`, { itens: [{ itemId: eu.itensLista.find(i => i.ferramentaId === F.ultima).id, quantidade: 1, condicao: 'boa' }], chave: chave() });
  assert.equal(d1.s, 200);
  assert.equal((await conf({ id: eu.id }, [{ itemId: eu.itensLista.find(i => i.ferramentaId === F.ultima).id, quantidade: 1, resultado: 'boa' }])).s, 200);
  const outras = await Promise.all(Object.values(tabs).map(t => t.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.ultima, quantidade: 1 }], chave: chave() })));
  assert.deepEqual(outras.map(r => r.s).sort(), [201, 409, 409, 409, 409, 409]);
});

/* ---------------------------------------------------------------- consistência depois de uma sequência qualquer de operações */
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ABERTOS = ['em_andamento', 'parcialmente_devolvido', 'aguardando_conferencia'];

test('invariantes: 300 operações pseudoaleatórias (retirar, devolver, conferir, baixar, estornar, ajustar, prazo; painel e terminal) deixam saldo, unidades, itens, status e livro de eventos fechando', async () => {
  const rnd = mulberry32(20261016);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const entre = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const Z = {};
  Z.q = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-Z01', nome: 'Alicate do sorteio (teste)', controle: 'quantidade', total: '12' })).id;
  Z.i = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-Z02', nome: 'Multímetro do sorteio (teste)', controle: 'individual', unidades: ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6'] })).id;
  Z.p = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-Z03', nome: 'Torquímetro do sorteio (teste)', controle: 'quantidade', total: '3' })).id;
  const tool = { [Z.q]: { total: 12 }, [Z.i]: { total: 6 }, [Z.p]: { total: 3 } };
  const entradas = { [Z.q]: 0, [Z.i]: 0, [Z.p]: 0 }, baixasAjuste = { [Z.q]: 0, [Z.i]: 0, [Z.p]: 0 };
  const pessoas = ['t1', 't2', 't3', 't4'];
  const quem = {}; for (const [k, u] of Object.entries(U)) quem[u.id] = k;
  const ok = ['P0001', 'P0002', '22023', '42501', '23514'];
  const tentar = async fn => { try { await fn(); return true; } catch (e) { if (ok.includes(e.code)) return false; throw e; } };
  const abertos = async () => (await h.q(`SELECT id, colaborador_id, status FROM emprestimo.emprestimo WHERE status = ANY($1) ORDER BY id`, [ABERTOS])).rows;
  const itensDe = async id => (await h.q(`SELECT id, tipo, ferramenta_id, unidade_id, quantidade::float q, qtd_conferencia::float c, qtd_devolvida::float d, qtd_baixa::float b FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1 ORDER BY id`, [id])).rows;
  const feitas = { emprestar: 0, devolver: 0, conferir: 0, baixar: 0, estornar: 0, ajustar: 0, prazo: 0 };
  const inteiro = n => Math.round(n * 1000) / 1000;

  async function operacao() {
    const op = pick(['emprestar', 'emprestar', 'emprestar', 'devolver', 'devolver', 'conferir', 'conferir', 'baixar', 'estornar', 'ajustar', 'ajustar', 'prazo']);
    if (op === 'emprestar') {
      const k = pick(pessoas), itens = [];
      if (rnd() < 0.7) itens.push({ ferramentaId: Z.q, quantidade: String(entre(1, 5)) });
      if (rnd() < 0.5) {
        const un = (await h.q("SELECT id FROM emprestimo.ferramenta_unidade WHERE ferramenta_id=$1 AND (estado='disponivel' OR $2) ORDER BY id", [Z.i, rnd() < 0.15])).rows;
        if (un.length) itens.push({ ferramentaId: Z.i, unidadeId: pick(un).id, quantidade: '1' });
      }
      if (rnd() < 0.3) itens.push({ ferramentaId: Z.p, quantidade: String(entre(1, 2)) });
      const doPainel = rnd() < 0.4;
      if (doPainel && rnd() < 0.5) itens.push({ materialCodigo: 'MAN-C1', quantidade: `${entre(1, 4)}.${pick(['5', '25', '125', '0'])}` });
      if (!itens.length) return;
      const dados = { chave: chave(), itens, ...(doPainel ? { colaboradorId: U[k].id } : {}) };
      if (await tentar(() => (doPainel ? exec(U.alm, 'emprestar', dados) : exec(U[k], 'emprestar', dados, 'terminal')))) feitas.emprestar += 1;
    } else if (op === 'devolver') {
      const ab = await abertos(); if (!ab.length) return;
      const e = pick(ab), its = (await itensDe(e.id)).filter(i => i.q - i.c - i.d - i.b > 0); if (!its.length) return;
      const escolhidos = its.filter(() => rnd() < 0.7); if (!escolhidos.length) escolhidos.push(pick(its));
      const lista = escolhidos.map(i => { const pend = inteiro(i.q - i.c - i.d - i.b); const q = i.tipo === 'ferramenta' ? entre(1, Math.max(1, pend) + (rnd() < 0.1 ? 1 : 0)) : inteiro(pend * (rnd() < 0.5 ? 1 : 0.5)) || pend;
        return { itemId: i.id, quantidade: String(q), condicao: rnd() < 0.25 ? 'avaria' : 'boa', observacao: 'Descrição do estado' }; });
      const terminal = rnd() < 0.6 && !lista.some(i => its.find(x => x.id === i.itemId).tipo === 'material');
      const dados = { emprestimoId: e.id, itens: lista, chave: chave() };
      if (await tentar(() => (terminal ? exec(U[quem[e.colaborador_id]], 'devolver', dados, 'terminal') : exec(U.alm, 'devolver', dados)))) feitas.devolver += 1;
    } else if (op === 'conferir') {
      const ab = (await abertos()).filter(x => x.status === 'aguardando_conferencia'); if (!ab.length) return;
      const e = pick(ab), its = (await itensDe(e.id)).filter(i => i.c > 0);
      const lista = its.filter(() => rnd() < 0.8).map(i => ({ itemId: i.id, quantidade: String(i.tipo === 'ferramenta' ? entre(1, Math.max(1, Math.floor(i.c))) : i.c), resultado: pick(['boa', 'boa', 'avaria', 'recusada']), observacao: 'Conferido no balcão' }));
      if (!lista.length) return;
      if (await tentar(() => exec(U.alm, 'conferir', { emprestimoId: e.id, itens: lista }))) feitas.conferir += 1;
    } else if (op === 'baixar') {
      const ab = await abertos(); if (!ab.length) return;
      const e = pick(ab), its = (await itensDe(e.id)).filter(i => i.q - i.c - i.d - i.b > 0); if (!its.length) return;
      const i = pick(its), pend = inteiro(i.q - i.c - i.d - i.b);
      const q = i.tipo === 'ferramenta' ? entre(1, Math.max(1, pend)) : pend;
      if (await tentar(() => exec(U.alm, 'baixar', { emprestimoId: e.id, itemId: i.id, quantidade: String(q), motivo: i.tipo === 'material' ? 'consumo' : 'extravio', justificativa: 'Baixa do sorteio de teste' }))) feitas.baixar += 1;
    } else if (op === 'estornar') {
      const ab = await abertos(); if (!ab.length || rnd() < 0.5) return;
      if (await tentar(() => exec(U.ges, 'estornar', { emprestimoId: pick(ab).id, justificativa: 'Estorno do sorteio de teste' }))) feitas.estornar += 1;
    } else if (op === 'ajustar') {
      const f = pick([Z.q, Z.i, Z.p]), mov = pick(['entrada', 'para_manutencao', 'de_manutencao', 'baixar']);
      const dados = { ferramentaId: f, movimento: mov, quantidade: String(entre(1, 2)), justificativa: 'Ajuste do sorteio de teste' };
      if (f === Z.i) {
        const un = (await h.q('SELECT id, estado FROM emprestimo.ferramenta_unidade WHERE ferramenta_id=$1 ORDER BY id', [Z.i])).rows;
        dados.unidadeId = pick(un).id; dados.quantidade = '1';
      } else if (mov === 'baixar') dados.de = pick(['disponivel', 'manutencao']);
      const antes = await h.q('SELECT total, baixada FROM emprestimo.ferramenta_saldo WHERE ferramenta_id=$1', [f]);
      if (await tentar(() => exec(U.ges, 'ajustar', dados))) {
        feitas.ajustar += 1;
        const depois = await h.q('SELECT total, baixada FROM emprestimo.ferramenta_saldo WHERE ferramenta_id=$1', [f]);
        entradas[f] += depois.rows[0].total - antes.rows[0].total; baixasAjuste[f] += depois.rows[0].baixada - antes.rows[0].baixada;
      }
    } else if (op === 'prazo') {
      const ab = await abertos(); if (!ab.length) return;
      if (await tentar(() => exec(U.alm, 'prazo', { emprestimoId: pick(ab).id, prazo: noPrazo(entre(1, 2000)), justificativa: 'Prazo do sorteio de teste' }))) feitas.prazo += 1;
    }
  }

  async function conferirTudo(rotulo) {
    const falhas = [];
    const ver = (cond, msg) => { if (!cond) falhas.push(msg); };
    const saldos = (await h.q('SELECT s.*, f.controle FROM emprestimo.ferramenta_saldo s JOIN emprestimo.ferramenta f ON f.id=s.ferramenta_id WHERE s.ferramenta_id = ANY($1)', [[Z.q, Z.i, Z.p]])).rows;
    for (const s of saldos) {
      const t = tool[s.ferramenta_id];
      const it = (await h.q(`SELECT coalesce(sum(i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa),0)::int pend, coalesce(sum(i.qtd_conferencia),0)::int conf, coalesce(sum(i.qtd_baixa),0)::int baixa
        FROM emprestimo.emprestimo_item i JOIN emprestimo.emprestimo e ON e.id=i.emprestimo_id WHERE i.ferramenta_id=$1 AND e.status <> 'estornado'`, [s.ferramenta_id])).rows[0];
      ver(s.total === s.disponivel + s.emprestada + s.em_conferencia + s.manutencao + s.baixada, `${rotulo}: saldo não fecha ${JSON.stringify(s)}`);
      ver(s.total === t.total + entradas[s.ferramenta_id], `${rotulo}: total ${s.total} ≠ inicial ${t.total} + entradas ${entradas[s.ferramenta_id]}`);
      ver(s.emprestada === it.pend, `${rotulo}: emprestada ${s.emprestada} ≠ pendente nos itens ${it.pend}`);
      ver(s.em_conferencia === it.conf, `${rotulo}: em conferência ${s.em_conferencia} ≠ itens ${it.conf}`);
      ver(s.baixada === it.baixa + baixasAjuste[s.ferramenta_id], `${rotulo}: baixada ${s.baixada} ≠ itens ${it.baixa} + ajustes ${baixasAjuste[s.ferramenta_id]}`);
      if (s.controle === 'individual') {
        const por = Object.fromEntries((await h.q('SELECT estado, count(*)::int n FROM emprestimo.ferramenta_unidade WHERE ferramenta_id=$1 GROUP BY estado', [s.ferramenta_id])).rows.map(r => [r.estado, r.n]));
        for (const [campo, estadoUn] of [['disponivel', 'disponivel'], ['emprestada', 'emprestada'], ['em_conferencia', 'em_conferencia'], ['manutencao', 'manutencao'], ['baixada', 'baixada']]) ver((por[estadoUn] || 0) === s[campo], `${rotulo}: unidades ${estadoUn} ${por[estadoUn] || 0} ≠ saldo ${s[campo]}`);
        for (const u of (await h.q('SELECT id, identificador, estado FROM emprestimo.ferramenta_unidade WHERE ferramenta_id=$1', [s.ferramenta_id])).rows) {
          const n = (await h.q(`SELECT count(*) FILTER (WHERE i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa > 0)::int pend, count(*) FILTER (WHERE i.qtd_conferencia > 0)::int conf
            FROM emprestimo.emprestimo_item i JOIN emprestimo.emprestimo e ON e.id=i.emprestimo_id WHERE i.unidade_id=$1 AND e.status <> 'estornado'`, [u.id])).rows[0];
          ver(n.pend === (u.estado === 'emprestada' ? 1 : 0), `${rotulo}: unidade ${u.identificador} (${u.estado}) com ${n.pend} item(ns) pendente(s)`);
          ver(n.conf === (u.estado === 'em_conferencia' ? 1 : 0), `${rotulo}: unidade ${u.identificador} (${u.estado}) com ${n.conf} item(ns) em conferência`);
        }
      }
    }
    // empréstimo a empréstimo: status, datas e livro de eventos
    for (const e of (await h.q('SELECT id, numero, status, encerrado_em FROM emprestimo.emprestimo')).rows) {
      const its = await itensDe(e.id);
      const evs = (await h.q('SELECT item_id, tipo, quantidade::float q FROM emprestimo.emprestimo_evento WHERE emprestimo_id=$1', [e.id])).rows;
      ver(its.length > 0 && evs.filter(v => v.tipo === 'retirada').length === its.length, `${rotulo}: ${e.numero} sem eventos de retirada para cada item`);
      if (e.status === 'estornado') {
        for (const i of its) { ver(i.c === 0 && i.d === 0 && i.b === 0, `${rotulo}: ${e.numero} estornado com movimento no item`); ver(evs.filter(v => v.item_id === i.id && v.tipo === 'estorno').reduce((n, v) => n + v.q, 0) === i.q, `${rotulo}: ${e.numero} estorno não cobre o item`); }
        ver(e.encerrado_em !== null, `${rotulo}: ${e.numero} estornado sem data de encerramento`);
        continue;
      }
      const fechado = its.every(i => inteiro(i.q - i.c - i.d - i.b) === 0 && i.c === 0), emConf = its.some(i => i.c > 0);
      const baixa = its.reduce((n, i) => n + i.b, 0), feito = its.reduce((n, i) => n + i.d + i.b, 0);
      const esperado = fechado ? (baixa > 0 ? 'encerrado' : 'devolvido') : emConf ? 'aguardando_conferencia' : feito > 0 ? 'parcialmente_devolvido' : 'em_andamento';
      ver(e.status === esperado, `${rotulo}: ${e.numero} está ${e.status}, os itens dizem ${esperado}`);
      ver((e.encerrado_em === null) === ABERTOS.includes(e.status), `${rotulo}: ${e.numero} (${e.status}) com encerrado_em ${e.encerrado_em}`);
      for (const i of its) {
        const soma = tipos => inteiro(evs.filter(v => v.item_id === i.id && tipos.includes(v.tipo)).reduce((n, v) => n + v.q, 0));
        const D = soma(['devolucao']), ok2 = soma(['conferencia', 'avaria']), R = soma(['recusada']), B = soma(['consumo', 'extravio']);
        ver(soma(['retirada']) === i.q, `${rotulo}: ${e.numero} retirada ${soma(['retirada'])} ≠ item ${i.q}`);
        ver(ok2 === i.d, `${rotulo}: ${e.numero} conferidos ${ok2} ≠ devolvida ${i.d}`);
        ver(inteiro(D - ok2 - R) === i.c, `${rotulo}: ${e.numero} devolvido ${D} − conferido ${ok2} − recusado ${R} ≠ em conferência ${i.c}`);
        ver(B === i.b, `${rotulo}: ${e.numero} baixa nos eventos ${B} ≠ item ${i.b}`);
      }
    }
    assert.deepEqual(falhas.slice(0, 6), [], `${falhas.length} inconsistência(s)`);
  }

  for (let n = 1; n <= 300; n += 1) {
    await operacao();
    if (n % 50 === 0) await conferirTudo(`após ${n} operações`);
  }
  await conferirTudo('final');
  for (const [op, vezes] of Object.entries(feitas)) assert.ok(vezes >= (op === 'estornar' ? 1 : 3), `o sorteio exercitou "${op}" ${vezes} vez(es)`);
  const hist = (await h.q("SELECT count(*)::int n FROM emprestimo.emprestimo_evento")).rows[0].n; assert.ok(hist > 100);
});

/* ---------------------------------------------------------------- reaplicar todas as migrations em banco populado */
test('reaplicar TODAS as migrations duas vezes (como o deploy) com o banco cheio: dados, políticas, privilégios e a API ficam como estavam', async () => {
  const snap = async () => {
    const contagens = {};
    for (const t of (await h.q("SELECT table_name FROM information_schema.tables WHERE table_schema='emprestimo' AND table_type='BASE TABLE' ORDER BY 1")).rows) {
      contagens[t.table_name] = (await h.q(`SELECT count(*)::int n FROM emprestimo.${t.table_name}`)).rows[0].n;
    }
    const miolo = (await h.q(`SELECT
      (SELECT md5(string_agg(row_to_json(c)::text, ',' ORDER BY id)) FROM emprestimo.config c) cfg,
      (SELECT md5(string_agg(row_to_json(s)::text, ',' ORDER BY ferramenta_id)) FROM emprestimo.ferramenta_saldo s) saldo,
      (SELECT md5(string_agg(usuario_id::text || coalesce(senha_hash, '-') || versao || bloqueado || falhas, ',' ORDER BY usuario_id)) FROM emprestimo.terminal_credencial) cred,
      (SELECT md5(string_agg(sha256, ',' ORDER BY ferramenta_id)) FROM emprestimo.ferramenta_foto) foto,
      (SELECT md5(string_agg(id::text || status::text, ',' ORDER BY id)) FROM core.email_fila WHERE motivo LIKE 'emprestimo_%') fila,
      (SELECT count(*)::int FROM core.usuario) usuarios`)).rows[0];
    const grants = (await h.q(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema='emprestimo' ORDER BY 1,2,3`)).rows.map(r => `${r.grantee}:${r.table_name}:${r.privilege_type}`);
    const funcoes = (await h.q(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f, coalesce(p.proacl::text, '') acl, p.prosecdef sd, coalesce(array_to_string(p.proconfig, ','), '') cfg
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='emprestimo' ORDER BY 1`)).rows.map(r => `${r.f}|${r.acl}|${r.sd}|${r.cfg}`);
    const politicas = (await h.q(`SELECT tablename, policyname, cmd, permissive, qual, with_check FROM pg_policies WHERE schemaname='emprestimo' ORDER BY 1,2`)).rows.map(r => JSON.stringify(r));
    const rls = (await h.q(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='emprestimo' AND c.relkind='r' ORDER BY 1`)).rows.map(r => `${r.relname}:${r.relrowsecurity}`);
    const gatilhos = (await h.q(`SELECT tgrelid::regclass::text t, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'emprestimo.%' ORDER BY 1,2`)).rows.map(r => `${r.t}:${r.tgname}`);
    return { contagens, miolo, grants, funcoes, politicas, rls, gatilhos };
  };
  const antes = await snap();
  assert.ok(antes.contagens.emprestimo >= 40 && antes.contagens.emprestimo_evento > 100 && antes.contagens.aviso > 3 && antes.contagens.terminal_sessao > 5 && antes.contagens.ferramenta_foto >= 1, `banco populado: ${JSON.stringify(antes.contagens)}`);
  const arquivos = fs.readdirSync(MIG).filter(n => /^\d.*\.sql$/.test(n)).sort();
  assert.ok(arquivos.includes('43-ferramenta-foto.sql') && arquivos.indexOf('43-ferramenta-foto.sql') > arquivos.indexOf('40-emprestimo.sql'));
  for (let volta = 1; volta <= 2; volta += 1) {
    for (const f of arquivos) await h.db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
    const depois = await snap();
    assert.deepEqual(depois.contagens, antes.contagens, `volta ${volta}: contagens`);
    assert.deepEqual(depois.miolo, antes.miolo, `volta ${volta}: configuração, saldos, credenciais, fotos e fila`);
    assert.deepEqual(depois.grants, antes.grants, `volta ${volta}: privilégios de tabela`);
    assert.deepEqual(depois.funcoes, antes.funcoes, `volta ${volta}: funções, ACL e search_path`);
    assert.deepEqual(depois.politicas, antes.politicas, `volta ${volta}: políticas de RLS (inclusive UPDATE)`);
    assert.deepEqual(depois.rls, antes.rls, `volta ${volta}: RLS ligado`);
    assert.deepEqual(depois.gatilhos, antes.gatilhos, `volta ${volta}: gatilhos de histórico`);
  }
  // O PGlite roda no mesmo processo: o exec das migrations trava o event loop e o servidor fecha, no mesmo instante em
  // que o fetch as reaproveita, as conexões keep-alive que venceram (ECONNRESET do teste, não do app, neste e nos
  // seguintes). Fecha as ociosas agora e dá um instante para o fetch tirá-las do pool.
  h.srv.closeIdleConnections(); await new Promise(r => setTimeout(r, 50));
  // a API e o terminal seguem de pé, e as tabelas do terminal continuam fechadas
  assert.equal((await painel(U.alm, 'GET', `${API}/ferramentas`)).s, 200);
  assert.equal((await tablet().entrar(MAT.t1, SENHA('t1'))).s, 200);
  for (const tabela of ['terminal_credencial', 'terminal_convite', 'terminal_tentativa', 'terminal_sessao']) await assert.rejects(h.transaction(U.adm, db => db.query(`SELECT * FROM emprestimo.${tabela}`)), e => e.code === '42501', tabela);
  const w = await h.transaction(null, async db => { await db.query('SET LOCAL ROLE biotrop_worker'); return (await db.query("SELECT has_table_privilege('biotrop_worker','emprestimo.emprestimo','SELECT') t, has_function_privilege('biotrop_worker','emprestimo.enfileirar_avisos()','EXECUTE') f, has_function_privilege('biotrop_worker','emprestimo.enfileirar_avisos_em(timestamptz)','EXECUTE') fe, has_function_privilege('biotrop_worker','emprestimo.executar(text,jsonb)','EXECUTE') ex")).rows[0]; });
  assert.deepEqual(w, { t: false, f: true, fe: false, ex: false }, 'o worker só alcança enfileirar_avisos()');
});

/* ---------------------------------------------------------------- achados (teste = evidência; { todo } até a correção) */
test('auditoria de alteração cadastral: ferramenta e colaborador registram o que mudou (antes e depois), não só "ativo"',
 async () => {
    const f = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C009', nome: 'Auditada original (teste)', controle: 'quantidade', total: '2', localizacao: 'Armário A1', conservacao: 'boa', categoria: 'Manual' })).id;
    let r = await painel(U.alm, 'PUT', `${API}/ferramentas/${f}`, { nome: 'Auditada renomeada (teste)', localizacao: 'Armário B2', conservacao: 'ruim' });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    const aud = (await h.q("SELECT detalhe FROM emprestimo.auditoria WHERE ferramenta_id=$1 AND tipo='ferramenta_editada' ORDER BY em DESC, id DESC LIMIT 1", [f])).rows[0].detalhe;
    const texto = JSON.stringify(aud);
    for (const v of ['Auditada original', 'Auditada renomeada', 'Armário A1', 'Armário B2', 'ruim']) assert.ok(texto.includes(v), `a auditoria da edição da ferramenta não traz "${v}": ${texto}`);
    // colaborador: setor, centro de custo e matrícula (a base dos relatórios por setor e CC) também precisam deixar rastro do que mudou
    const base = { nome: 'Pessoa c3', email: U.c3.email, matricula: MAT.c3, setor: 'Manutenção', centroCusto: 'CC-c3', cargo: 'Mecânico', ativo: true };
    try {
      assert.equal((await painel(U.alm, 'POST', `${API}/colaboradores`, base)).s, 200);
      r = await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, setor: 'Utilidades', centroCusto: 'CC-novo-99', matricula: '820099' });
      assert.equal(r.s, 200, JSON.stringify(r.j));
      const c = JSON.stringify((await h.q("SELECT detalhe FROM emprestimo.auditoria WHERE usuario_alvo=$1 AND tipo='colaborador_salvo' ORDER BY em DESC, id DESC LIMIT 1", [U.c3.id])).rows[0].detalhe);
      for (const v of ['Utilidades', 'CC-novo-99', '820099', 'Manutenção', 'CC-c3', MAT.c3]) assert.ok(c.includes(v), `a auditoria do cadastro do colaborador não traz "${v}": ${c}`);
    } finally { await painel(U.alm, 'POST', `${API}/colaboradores`, base); }
  });

test('"só atrasados" lista apenas o que está atrasado: prazo vencido COM pendência (tudo em conferência não é atraso)',
 async () => {
    const e = await novoEmprestimo('t3', [{ ferramentaId: F.estoque, quantidade: '1' }]);
    await h.q("UPDATE emprestimo.emprestimo SET prazo = now() - interval '3 days' WHERE id=$1", [e.id]);
    assert.equal((await dev(e, [{ itemId: e.itens[0].id, quantidade: 1 }])).s, 200);
    const lista = (await painel(U.alm, 'GET', `${API}/emprestimos?atrasados=1`)).j.rows;
    const linha = lista.find(x => x.id === e.id);
    assert.ok(!linha || linha.atrasado === true, `a linha de ${linha?.numero} aparece em "atrasados" com atrasado=${linha?.atrasado} e pendente=${linha?.pendente}`);
    const todos = (await painel(U.alm, 'GET', `${API}/emprestimos?status=abertos`)).j.rows.find(x => x.id === e.id);
    assert.equal(todos.atrasado, false, 'a própria linha diz que não está atrasado (nada pendente)');
    await conf(e, [{ itemId: e.itens[0].id, quantidade: 1, resultado: 'boa' }]);
  });

test('matrícula única não diferencia maiúsculas: "l81001" não pode ser outra pessoa além de "L81001"',
 async () => {
    const base = { nome: 'Pessoa c3', email: U.c3.email, matricula: MAT.c3, setor: 'Manutenção', centroCusto: 'CC-c3', cargo: 'Mecânico', ativo: true };
    try {
      const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, matricula: MAT.lid.toLowerCase() });
      assert.equal(r.s, 409, `matrícula ${MAT.lid.toLowerCase()} aceita como outra pessoa: ${JSON.stringify(r.j)}`);
    } finally { await painel(U.alm, 'POST', `${API}/colaboradores`, base); }
  });

test('editar o cadastro sem mandar "ativo" não reativa quem foi desligado (como o PUT da ferramenta, que mantém)',
 async () => {
    const base = { nome: 'Pessoa c3', email: U.c3.email, matricula: MAT.c3, setor: 'Manutenção', centroCusto: 'CC-c3', cargo: 'Mecânico' };
    const ativo = async () => (await h.q('SELECT ativo FROM emprestimo.colaborador WHERE usuario_id=$1', [U.c3.id])).rows[0].ativo;
    try {
      assert.equal((await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, ativo: false })).s, 200);
      assert.equal(await ativo(), false);
      const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, setor: 'Utilidades' });
      assert.equal(r.s, 200, JSON.stringify(r.j));
      assert.equal(await ativo(), false, 'o desligado voltou a ativo por uma edição de setor');
    } finally { await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, ativo: true }); }
  });

test('"ativo" que não é verdadeiro/falso é recusado (400) em vez de virar "desativar" (colaborador e ferramenta)',
 async () => {
    const base = { nome: 'Pessoa c3', email: U.c3.email, matricula: MAT.c3, setor: 'Manutenção', centroCusto: 'CC-c3', cargo: 'Mecânico' };
    const ativoCol = async () => (await h.q('SELECT ativo FROM emprestimo.colaborador WHERE usuario_id=$1', [U.c3.id])).rows[0].ativo;
    const ativoFer = async () => (await h.q('SELECT ativo FROM emprestimo.ferramenta WHERE id=$1', [F.estoque])).rows[0].ativo;
    try {
      assert.equal((await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, ativo: true })).s, 200);
      for (const v of [1, 0, 'sim', 'x', 'True', 'TRUE', 'false ']) {
        const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, ativo: v });
        assert.ok(r.s === 400 || (await ativoCol()) === true, `colaborador: ativo ${JSON.stringify(v)} respondeu ${r.s} e deixou ativo=${await ativoCol()}`);
        await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, ativo: true });
      }
      for (const v of [1, 0, 'sim', 'x', 'True']) {
        const r = await painel(U.alm, 'PUT', `${API}/ferramentas/${F.estoque}`, { ativo: v });
        assert.ok(r.s === 400 || (await ativoFer()) === true, `ferramenta: ativo ${JSON.stringify(v)} respondeu ${r.s} e deixou ativo=${await ativoFer()}`);
        await painel(U.alm, 'PUT', `${API}/ferramentas/${F.estoque}`, { ativo: true });
      }
    } finally {
      await painel(U.alm, 'POST', `${API}/colaboradores`, { ...base, ativo: true });
      await painel(U.alm, 'PUT', `${API}/ferramentas/${F.estoque}`, { ativo: true });
    }
  });

test('mensagem de quantidade no formato do Brasil: nunca "1.000" para uma unidade (em português isso lê "mil")',
 async () => {
    const e = await novoEmprestimo('t4', [{ ferramentaId: F.estoque, quantidade: '1' }]);
    const it = e.itens[0].id;
    const msgs = [];
    msgs.push((await dev(e, [{ itemId: it, quantidade: 99 }])).j.erro);
    msgs.push((await baixa(e, { itemId: it, quantidade: 99, motivo: 'extravio', justificativa: 'Perdida na área 3' })).j.erro);
    msgs.push((await conf(e, [{ itemId: it, quantidade: 1, resultado: 'boa' }])).j.erro);
    for (const m of msgs) assert.ok(!/\d\.\d{3}/.test(m), `mensagem confusa para quem lê em português: "${m}"`);
    await exec(U.ges, 'estornar', { emprestimoId: e.id, justificativa: 'Teste de mensagem' });
  });

test('configuração e cadastro recusam tipos errados em vez de converter: true não vira 1 hora; unidade não é um objeto',
 async () => {
    const antes = (await painel(U.ges, 'GET', `${API}/config`)).j.config.prazoPadraoHoras;
    try {
      for (const v of [true, [5]]) {
        const r = await painel(U.ges, 'PUT', `${API}/config`, { prazoPadraoHoras: v });
        const depois = (await painel(U.ges, 'GET', `${API}/config`)).j.config.prazoPadraoHoras;
        assert.ok(r.s === 400 && depois === antes, `prazoPadraoHoras ${JSON.stringify(v)} respondeu ${r.s} e deixou ${depois} (antes ${antes})`);
      }
    } finally { await painel(U.ges, 'PUT', `${API}/config`, { prazoPadraoHoras: antes }); }
    const r = await painel(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-C010', nome: 'Unidade estranha (teste)', controle: 'individual', unidades: [{ a: 1 }] });
    assert.equal(r.s, 400, `unidade como objeto aceita (${JSON.stringify(r.j)})`);
  });


/* ---------------------------------------------------------------- entrada hostil não pode virar erro interno (5xx) */
async function cru(method, url, corpoCru, usuario) {
  const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': novoIp() };
  if (usuario) headers.cookie = `biotrop_session=${createSession({ id: usuario.id, sessaoVersao: usuario.sv }).valor}`;
  const r = await fetch(h.raiz + url, { method, headers, body: corpoCru });
  await r.arrayBuffer();
  return r.status;
}
/** Roda os casos sem o ruído do log de erro e devolve os que responderam 5xx. */
async function cincoXX(casos) {
  const log = console.error; console.error = () => {};
  try {
    const ruins = [];
    for (const [rotulo, metodo, url, corpo, usuario] of casos) { const s = await cru(metodo, url, corpo, usuario); if (s >= 500) ruins.push(`${rotulo} → ${s}`); }
    return ruins;
  } finally { console.error = log; }
}

test('texto com o caractere NUL (U+0000), em campo ou na busca, é recusado com 400 — não derruba a requisição com erro interno',
 async () => {
    const nul = 'a\u0000b';
    const ruins = await cincoXX([
      ['GET /ferramentas?q=%00', 'GET', `${API}/ferramentas?q=%00`, undefined, U.alm], ['GET /ferramentas?categoria=%00', 'GET', `${API}/ferramentas?categoria=%00`, undefined, U.alm],
      ['GET /emprestimos?q=%00', 'GET', `${API}/emprestimos?q=%00`, undefined, U.alm], ['GET /emprestimos?matricula=%00', 'GET', `${API}/emprestimos?matricula=%00`, undefined, U.alm],
      ['POST /ferramentas (nome)', 'POST', `${API}/ferramentas`, JSON.stringify({ codigo: 'FER-N01', nome: nul, controle: 'quantidade', total: 1 }), U.alm],
      ['POST /ferramentas (descrição)', 'POST', `${API}/ferramentas`, JSON.stringify({ codigo: 'FER-N02', nome: 'ok', descricao: nul, controle: 'quantidade', total: 1 }), U.alm],
      ['PUT /ferramentas/:id (marca)', 'PUT', `${API}/ferramentas/${F.estoque}`, JSON.stringify({ marca: nul }), U.alm],
      ['POST /colaboradores (setor)', 'POST', `${API}/colaboradores`, JSON.stringify({ nome: 'Pessoa Nul', email: U.c3.email, matricula: MAT.c3, setor: nul }), U.alm],
      ['POST /emprestimos/:id/prazo (justificativa)', 'POST', `${API}/emprestimos/${F.empPrazo}/prazo`, JSON.stringify({ prazo: noPrazo(30), justificativa: nul }), U.alm],
      ['POST /emprestimos (observação)', 'POST', `${API}/emprestimos`, JSON.stringify({ colaboradorId: U.t1.id, chave: chave(), itens: [{ ferramentaId: F.estoque, quantidade: 1 }], observacao: nul }), U.alm],
      ['POST /ferramentas/:id/ajustes (justificativa)', 'POST', `${API}/ferramentas/${F.estoque}/ajustes`, JSON.stringify({ movimento: 'entrada', quantidade: 1, justificativa: nul }), U.ges]
    ]);
    assert.deepEqual(ruins, [], 'erro interno com NUL');
    const t = tablet(); assert.equal((await t.entrar(MAT.t1, SENHA('t1'))).s, 200);
    const log = console.error; console.error = () => {};
    try { const r = await t.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.estoque, quantidade: 1 }], chave: chave(), observacao: nul }); assert.ok(r.s < 500, `terminal: observação com NUL → ${r.s}`); } finally { console.error = log; }
  });

test('campo de texto recebido como objeto estranho ({"toString":1}) não derruba a requisição com erro interno — terminal (entrar, primeiro acesso, saída) e painel',
 async () => {
    const estranho = { toString: 1 };
    const ruins = await cincoXX([
      ['terminal entrar (matrícula)', 'POST', '/api/terminal/entrar', JSON.stringify({ matricula: estranho, senha: 'x' })],
      ['terminal primeiro-acesso (matrícula)', 'POST', '/api/terminal/primeiro-acesso', JSON.stringify({ matricula: estranho, codigo: 'x', senha: 'Senha-Boa-777#1' })],
      ['terminal primeiro-acesso (código)', 'POST', '/api/terminal/primeiro-acesso', JSON.stringify({ matricula: MAT.t1, codigo: estranho, senha: 'Senha-Boa-777#1' })],
      ['terminal saida-admin (matrícula)', 'POST', '/api/terminal/saida-admin', JSON.stringify({ matricula: estranho, senha: 'x', codigo: 'x' })],
      ['POST /emprestimos (observação)', 'POST', `${API}/emprestimos`, JSON.stringify({ colaboradorId: U.t1.id, chave: chave(), itens: [{ ferramentaId: F.estoque, quantidade: 1 }], observacao: estranho }), U.alm],
      ['POST /colaboradores (setor)', 'POST', `${API}/colaboradores`, JSON.stringify({ nome: 'Pessoa c3', email: U.c3.email, matricula: MAT.c3, setor: estranho }), U.alm],
      ['POST /ferramentas/:id/unidades', 'POST', `${API}/ferramentas/${F.furadeira}/unidades`, JSON.stringify({ identificador: estranho }), U.alm]
    ]);
    assert.deepEqual(ruins, [], 'erro interno com objeto estranho');
  });

test('corpo JSON malformado ou que não é objeto (null, número, texto) recebe 400, não 500 — em /api/terminal e no painel',
  async () => {
    const ruins = await cincoXX([
      ['terminal entrar: {', 'POST', '/api/terminal/entrar', '{'], ['terminal entrar: null', 'POST', '/api/terminal/entrar', 'null'], ['terminal entrar: 123', 'POST', '/api/terminal/entrar', '123'], ['terminal entrar: "texto"', 'POST', '/api/terminal/entrar', '"texto"'],
      ['painel ferramentas: {', 'POST', `${API}/ferramentas`, '{codigo:', U.alm], ['painel colaboradores: null', 'POST', `${API}/colaboradores`, 'null', U.alm], ['painel config: "x"', 'PUT', `${API}/config`, '"x"', U.ges]
    ]);
    assert.deepEqual(ruins, [], 'corpo inválido deveria ser 400');
  });


/* ---------------------------------------------------------------- transições do acesso fora de ordem */
test('acesso ao terminal fora de ordem: bloquear duas vezes, desbloquear quem não está bloqueado, código de convite depois do bloqueio, redefinição e senha antiga', async () => {
  const conv = () => painel(U.alm, 'POST', `${API}/colaboradores/${U.c1.id}/convite`);
  const acesso = (bloqueado, justificativa = 'Conferido com a pessoa') => painel(U.alm, 'POST', `${API}/colaboradores/${U.c1.id}/acesso`, { bloqueado, justificativa });
  const situacao = async () => (await painel(U.alm, 'GET', `${API}/colaboradores?q=${MAT.c1}`)).j.rows[0].acesso.situacao;
  const nova = 'Senha-Nova-Cobertura#52';
  assert.equal((await tablet().entrar(MAT.c1, SENHA('c1'))).s, 200, 'c1 entra com a senha de antes');
  // convite de redefinição: a senha antiga já não vale e a pessoa fica "convite pendente"
  let r = await conv(); assert.equal(r.s, 201); assert.equal(r.j.redefinicao, true); const k1 = r.j.codigo;
  assert.equal((await tablet().entrar(MAT.c1, SENHA('c1'))).s, 401, 'senha antiga deixa de valer');
  assert.equal(await situacao(), 'convite_pendente');
  // bloqueio: derruba o convite em aberto; bloquear de novo não dá erro; o código antigo não volta com o desbloqueio
  r = await acesso(true); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.acesso.situacao, 'bloqueado');
  assert.equal((await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c1, codigo: k1, senha: nova })).s, 400, 'convite invalidado pelo bloqueio');
  assert.equal((await acesso(true)).s, 200, 'bloquear de novo é aceito');
  assert.equal((await conv()).s, 409, 'bloqueado não recebe convite');
  r = await acesso(false); assert.deepEqual([r.s, r.j.acesso.situacao], [200, 'sem_acesso'], 'sem senha e sem convite');
  assert.equal((await acesso(false)).s, 200, 'desbloquear quem não está bloqueado é aceito');
  assert.equal((await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c1, codigo: k1, senha: nova })).s, 400, 'o desbloqueio não ressuscita o convite');
  // convite novo funciona; o anterior segue morto; entra com a senha nova e não com a antiga
  r = await conv(); assert.equal(r.s, 201); const k2 = r.j.codigo; assert.notEqual(k2, k1);
  assert.equal((await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c1, codigo: k1, senha: nova })).s, 400);
  assert.equal((await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.c1, codigo: k2, senha: nova })).s, 200);
  assert.equal((await tablet().entrar(MAT.c1, nova)).s, 200); assert.equal((await tablet().entrar(MAT.c1, SENHA('c1'))).s, 401);
  assert.equal(await situacao(), 'ativo');
  // sessão aberta cai a cada uma dessas transições (versão da credencial no cookie)
  const t = tablet(); assert.equal((await t.entrar(MAT.c1, nova)).s, 200);
  assert.equal((await acesso(true)).s, 200); assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401, 'bloqueio derruba a sessão aberta');
  assert.equal((await acesso(false)).s, 200); assert.equal((await tablet().entrar(MAT.c1, nova)).s, 200, 'desbloqueado volta com a senha que já tinha');
  // trilha: cada passo ficou na auditoria, sem código nem senha
  const aud = (await h.q("SELECT tipo, detalhe FROM emprestimo.auditoria WHERE usuario_alvo=$1 AND tipo LIKE 'terminal_%' ORDER BY em, id", [U.c1.id])).rows;
  const tiposAud = aud.map(a => a.tipo);
  for (const k of ['terminal_convite', 'terminal_bloqueio', 'terminal_desbloqueio', 'terminal_senha_definida']) assert.ok(tiposAud.includes(k), k);
  assert.ok(aud.filter(a => a.tipo === 'terminal_desbloqueio').some(a => a.detalhe.estavaBloqueado === false), 'desbloqueio de quem não estava bloqueado registrado como tal');
  const texto = JSON.stringify(aud);
  for (const segredo of [k1, k2, k1.replace('-', ''), k2.replace('-', ''), nova, SENHA('c1')]) assert.ok(!texto.includes(segredo), 'segredo na auditoria');
});

/* ---------------------------------------------------------------- preservação dos módulos existentes */
test('quem só usa o terminal (perfil "terminal") não aparece nas listas de pessoas dos outros módulos: Treinamentos (equipe) e Inventário (usuários)',
  async () => {
    const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Operador Só Terminal (teste)', email: 'operador.so.terminal@teste.biotrop', matricula: '840001', setor: 'Produção', centroCusto: 'CC-op' });
    assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.perfil, 'terminal');
    const nomes = async (u, url, campo) => ((await painel(u, 'GET', url)).j[campo] || []).filter(p => p.perfilId === 'terminal').map(p => p.nome);
    for (const u of [U.alm, U.ges, U.pcm]) assert.deepEqual(await nomes(u, '/api/lms/equipe', 'pessoas'), [], 'Treinamentos > Acompanhamento lista quem nunca entra no site');
    for (const u of [U.alm, U.ges]) assert.deepEqual(await nomes(u, '/api/inventario/usuarios', 'usuarios'), [], 'o Inventário oferece como contador quem só usa o tablet');
  });

test('o terminal não abre o sistema principal: cookie do terminal recusado (401) em 20 rotas dos módulos de antes; o perfil "terminal" no site não recebe dado de nenhuma delas',
  async () => {
    const rotas = ['/api/data/sci', '/api/data/scm', '/api/data/utility_meters', '/api/pcm/preventivas/painel', '/api/pcm/preventivas/preventivas', '/api/pcm/bateladas/painel', '/api/pcm/bateladas/historico',
      '/api/almox/materiais', '/api/almox/materiais/resumo', '/api/almox/materiais/MAN-C1', '/api/inventario/usuarios', '/api/inventario/snapshots', '/api/inventario/campanhas', '/api/inventario/bi',
      '/api/lms/equipe', '/api/conta/perfil', '/api/admin/simulacao/estado', '/api/realtime', '/auth/me', '/assets/modelos/prontuario-diafragmas-rev12.xlsx'];
    const t = tablet(); assert.equal((await t.entrar(MAT.t1, SENHA('t1'))).s, 200);
    const valor = t.cookie.split('=')[1];
    for (const u of rotas) {
      if (u === '/api/realtime') continue;   // fluxo SSE: aberto só com sessão do site (conferido abaixo sem ler o corpo)
      assert.equal((await t.req('GET', u)).s, 401, `cookie do terminal em ${u}`);
      assert.equal((await t.req('GET', u, undefined, { cookie: `biotrop_session=${valor}` })).s, 401, `valor do terminal no cookie do site em ${u}`);
    }
    const sse = await fetch(h.raiz + '/api/realtime', { headers: { cookie: t.cookie, 'x-forwarded-for': novoIp() } }); assert.equal(sse.status, 401); await sse.arrayBuffer();
    // quem tem o perfil terminal e entra no site (se um dia for autorizado) não recebe nenhum dado dos módulos de antes
    for (const u of rotas.filter(x => !['/api/realtime', '/assets/modelos/prontuario-diafragmas-rev12.xlsx', '/api/conta/perfil', '/auth/me'].includes(x))) {
      const r = await painel(U.t1, 'GET', u);
      assert.ok([200, 400, 403].includes(r.s), `${u} → ${r.s}`);
      if (r.s === 200) {
        const lista = r.j.rows ?? r.j.campanhas ?? r.j.pessoas ?? r.j.materiais ?? r.j.snapshots ?? r.j.ativos ?? [];
        const proprios = u === '/api/lms/equipe' ? lista.filter(p => p.id !== U.t1.id) : lista;
        assert.deepEqual(proprios, [], `${u}: o perfil terminal recebeu dados de outras pessoas ou módulos`);
      }
    }
  });

/* ---------------------------------------------------------------- rodada 2 do testador: critério 13 (inventário separado) e achados */
test('inventário de ferramentas separado do inventário atual (critério 13): ferramenta nova, retirada, devolução, conferência, baixa, ajuste, estorno e empréstimo de material não mudam uma linha dos schemas almox e inventario',
  async () => {
    const tabelas = (await h.q(`SELECT table_schema s, table_name t FROM information_schema.tables WHERE table_schema IN ('almox','inventario') AND table_type = 'BASE TABLE' ORDER BY 1, 2`)).rows;
    assert.ok(tabelas.length >= 5 && tabelas.some(x => x.t === 'material'), `tabelas do almoxarifado e do inventário: ${tabelas.map(x => `${x.s}.${x.t}`).join(', ')}`);
    const foto = async () => {
      const out = {};
      for (const { s, t } of tabelas) out[`${s}.${t}`] = (await h.q(`SELECT count(*)::int n, coalesce(md5(string_agg(x::text, ',' ORDER BY x::text)), '') m FROM ${s}.${t} x`)).rows[0];
      return out;
    };
    const antes = await foto();
    const f = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C013', nome: 'Separada do inventário (teste)', controle: 'quantidade', total: '6' })).id;
    const e = await novoEmprestimo('t4', [{ ferramentaId: f, quantidade: '4' }, { materialCodigo: 'MAN-C1', quantidade: '2.5' }]);
    const fer = e.itens.find(i => i.tipo === 'ferramenta'), mat = e.itens.find(i => i.tipo === 'material');
    assert.equal((await dev(e, [{ itemId: fer.id, quantidade: 3 }, { itemId: mat.id, quantidade: '1.5' }])).s, 200);
    assert.equal((await conf(e, [{ itemId: fer.id, quantidade: 2, resultado: 'boa' }, { itemId: fer.id, quantidade: 1, resultado: 'avaria', observacao: 'Cabo partido' }, { itemId: mat.id, quantidade: '1.5', resultado: 'boa' }])).s, 200);
    assert.equal((await baixa(e, { itemId: fer.id, quantidade: 1, motivo: 'extravio', justificativa: 'Perdida na área de teste' })).s, 200);
    assert.equal((await baixa(e, { itemId: mat.id, quantidade: '1', motivo: 'consumo', justificativa: 'Usado na OM de teste' })).s, 200);
    assert.equal(await statusDe(e), 'encerrado');
    assert.equal((await painel(U.ges, 'POST', `${API}/ferramentas/${f}/ajustes`, { movimento: 'entrada', quantidade: 2, justificativa: 'Compra de teste' })).s, 200);
    const e2 = await novoEmprestimo('t4', [{ ferramentaId: f, quantidade: '1' }, { materialCodigo: 'MAN-C1', quantidade: '1' }]);
    assert.equal((await painel(U.ges, 'POST', `${API}/emprestimos/${e2.id}/estorno`, { justificativa: 'Lançado para a pessoa errada' })).s, 200);
    fecha(await saldo(f));
    assert.deepEqual(await foto(), antes, 'o empréstimo mexeu em tabela do almoxarifado de materiais ou do inventário');
    // o catálogo de materiais não lista ferramenta, e o inventário atual não conhece o código da ferramenta
    const cat = await painel(U.alm, 'GET', '/api/almox/materiais?q=FER-C0');
    assert.equal(cat.s, 200);
    const lista = cat.j.rows ?? cat.j.materiais ?? [];
    assert.deepEqual(lista.filter(x => /^FER-/i.test(String(x.codigo))), [], 'ferramenta apareceu no catálogo de materiais');
    for (const { s, t } of tabelas) {
      const colunas = (await h.q(`SELECT column_name c FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND data_type IN ('text','character varying','citext')`, [s, t])).rows.map(x => x.c);
      if (!colunas.length) continue;
      const n = (await h.q(`SELECT count(*)::int n FROM ${s}.${t} x WHERE ${colunas.map(c => `x.${c}::text LIKE 'FER-C0%'`).join(' OR ')}`)).rows[0].n;
      assert.equal(n, 0, `${s}.${t} guarda código de ferramenta`);
    }
  });

test('endurecimento do schema emprestimo (critério 13: permissões no servidor): toda tabela com RLS, nenhum DML direto para biotrop_app e biotrop_ro (nem com identidade de admin), só gatilhos executáveis por PUBLIC, toda SECURITY DEFINER com search_path fixo',
  async () => {
    const tabelas = (await h.q(`SELECT c.relname t, c.relrowsecurity rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'emprestimo' AND c.relkind = 'r' ORDER BY 1`)).rows;
    assert.ok(tabelas.length >= 15, `tabelas do módulo: ${tabelas.map(x => x.t).join(', ')}`);
    assert.deepEqual(tabelas.filter(x => !x.rls).map(x => x.t), [], 'tabela sem RLS ligado');
    const tenta = async (papel, usuario, sql) => { try { await h.transaction(usuario, async db => { await db.query(`SET LOCAL ROLE ${papel}`); await db.query(sql); }); return 'PERMITIDO'; } catch (e) { return e.code; } };
    const permitidos = [];
    for (const papel of ['biotrop_app', 'biotrop_ro']) for (const usuario of [U.adm, U.alm, null]) for (const { t } of tabelas) {
      for (const [op, sql] of [['INSERT', `INSERT INTO emprestimo.${t} DEFAULT VALUES`], ['UPDATE', `UPDATE emprestimo.${t} SET ctid = ctid WHERE false`], ['DELETE', `DELETE FROM emprestimo.${t} WHERE false`], ['TRUNCATE', `TRUNCATE emprestimo.${t}`]]) {
        if (await tenta(papel, usuario, sql) === 'PERMITIDO') permitidos.push(`${papel}/${usuario ? usuario.perfil : 'sem identidade'}/${t}/${op}`);
      }
    }
    assert.deepEqual(permitidos, [], 'escrita direta nas tabelas (o único caminho é emprestimo.executar e as funções terminal_*, foto e avisos)');
    // sem identidade, o papel de leitura não enxerga linha nenhuma (as tabelas do terminal nem abrem)
    for (const { t } of tabelas) {
      const n = await h.transaction(null, async db => { await db.query('SET LOCAL ROLE biotrop_ro'); return (await db.query(`SELECT count(*)::int n FROM emprestimo.${t}`)).rows[0].n; }).catch(e => e.code);
      assert.ok(n === 0 || n === '42501', `biotrop_ro sem identidade lê ${t}: ${n}`);
    }
    const publicas = (await h.q(`SELECT p.proname f, p.prorettype::regtype::text r FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'emprestimo'
      AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')) ORDER BY 1`)).rows;
    assert.deepEqual(publicas.filter(x => x.r !== 'trigger').map(x => x.f), [], 'função do módulo executável por qualquer papel (falta REVOKE ... FROM PUBLIC)');
    const semCaminho = (await h.q(`SELECT p.proname f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'emprestimo' AND p.prosecdef AND NOT coalesce(p.proconfig::text LIKE '%search_path%', false) ORDER BY 1`)).rows.map(x => x.f);
    assert.deepEqual(semCaminho, [], 'SECURITY DEFINER sem search_path fixo (sequestro de função por schema)');
  });

test('baixa: o número da baixa do Dynamics já registrado não se perde quando uma segunda baixa do mesmo item vem sem número (a tela sempre manda o campo, vazio)',
  async () => {
    const e = await novoEmprestimo('t5', [{ ferramentaId: F.estoque, quantidade: '3' }]);
    const it = e.itens[0].id;
    const numero = async () => (await h.q('SELECT numero_baixa FROM emprestimo.emprestimo_item WHERE id=$1', [it])).rows[0].numero_baixa;
    try {
      let r = await baixa(e, { itemId: it, quantidade: 1, motivo: 'extravio', justificativa: 'Perdida na área 3', numeroBaixa: 'BX-DYN-100' });
      assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(await numero(), 'BX-DYN-100');
      r = await baixa(e, { itemId: it, quantidade: 1, motivo: 'extravio', justificativa: 'Outra perdida na área 3', numeroBaixa: '' });
      assert.equal(r.s, 200, JSON.stringify(r.j));
      assert.equal(await numero(), 'BX-DYN-100', `a segunda baixa, sem número, deixou "${await numero()}" no lugar de BX-DYN-100`);
      r = await baixa(e, { itemId: it, quantidade: 1, motivo: 'extravio', justificativa: 'Mais uma perdida na área 3' });   // sem o campo
      assert.equal(r.s, 200, JSON.stringify(r.j));
      assert.equal(await numero(), 'BX-DYN-100', 'a terceira baixa (sem o campo) também não pode apagar o número');
    } finally {
      const pend = (await h.q('SELECT (quantidade - qtd_conferencia - qtd_devolvida - qtd_baixa)::int p FROM emprestimo.emprestimo_item WHERE id=$1', [it])).rows[0].p;
      if (pend > 0) await exec(U.alm, 'baixar', { emprestimoId: e.id, itemId: it, quantidade: String(pend), motivo: 'extravio', justificativa: 'Limpeza do teste' });
    }
  });

test('histórico do novo prazo: o prazo antigo aparece na hora de Brasília (a das telas e dos e-mails), não na do fuso da sessão do banco (UTC)',
  async () => {
    const alvo = new Date(Date.now() + 30 * HORA);
    const r0 = await painel(U.alm, 'POST', `${API}/emprestimos`, { colaboradorId: U.t2.id, chave: chave(), prazo: alvo.toISOString(), itens: [{ ferramentaId: F.estoque, quantidade: 1 }] });
    assert.equal(r0.s, 201, JSON.stringify(r0.j));
    try {
      const r = await painel(U.alm, 'POST', `${API}/emprestimos/${r0.j.id}/prazo`, { prazo: noPrazo(100), justificativa: 'Serviço estendido' });
      assert.equal(r.s, 200, JSON.stringify(r.j));
      const ev = (await h.q("SELECT justificativa FROM emprestimo.emprestimo_evento WHERE emprestimo_id=$1 AND tipo='prazo'", [r0.j.id])).rows[0].justificativa;
      const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(alvo).map(x => [x.type, x.value]));
      const brasilia = `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
      assert.ok(ev.includes(brasilia), `o histórico diz "${ev}"; o prazo antigo era ${brasilia} em Brasília`);
    } finally { await exec(U.ges, 'estornar', { emprestimoId: r0.j.id, justificativa: 'Limpeza do teste' }); }
  });

test('no banco, o canal do terminal recusa material na retirada e na devolução: "o terminal só empresta ferramenta" não pode ficar só na rota',
  async () => {
    const criados = [];
    try {
      let aceitou = null;
      try { const x = await exec(U.t1, 'emprestar', { chave: chave(), itens: [{ materialCodigo: 'MAN-C1', quantidade: '1' }] }, 'terminal'); criados.push(x.id); aceitou = x; } catch (e) { assert.equal(e.code, '42501', `recusa com o código errado: ${e.code} ${e.message}`); }
      assert.equal(aceitou, null, `o canal do terminal emprestou material: ${JSON.stringify(aceitou)}`);
      const e = await novoEmprestimo('t1', [{ materialCodigo: 'MAN-C1', quantidade: '2' }]); criados.push(e.id);
      let devolveu = null;
      try { devolveu = await exec(U.t1, 'devolver', { emprestimoId: e.id, itens: [{ itemId: e.itens[0].id, quantidade: '1', condicao: 'boa' }], chave: chave() }, 'terminal'); } catch (err) { assert.ok(['42501', '22023'].includes(err.code), `recusa com o código errado: ${err.code} ${err.message}`); }
      assert.equal(devolveu, null, `o canal do terminal devolveu material: ${JSON.stringify(devolveu)}`);
    } finally {
      // fecha o que o teste abriu, para não deixar empréstimo pendente para os outros testes
      for (const id of criados) {
        const its = (await h.q('SELECT id, qtd_conferencia::float c FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1', [id])).rows;
        for (const i of its) {
          if (i.c > 0) await exec(U.alm, 'conferir', { emprestimoId: id, itens: [{ itemId: i.id, quantidade: String(i.c), resultado: 'boa' }] });
          const ainda = (await h.q('SELECT (quantidade - qtd_conferencia - qtd_devolvida - qtd_baixa)::float p FROM emprestimo.emprestimo_item WHERE id=$1', [i.id])).rows[0].p;
          if (ainda > 0) await exec(U.alm, 'baixar', { emprestimoId: id, itemId: i.id, quantidade: String(ainda), motivo: 'consumo', justificativa: 'Limpeza do teste' });
        }
      }
    }
  });

test('editar o cadastro do colaborador mandando só nome, e-mail, matrícula e ativo não apaga setor, centro de custo e cargo (a edição parcial pela API mantém o resto, como o PUT da ferramenta)',
  async () => {
    const base = { nome: 'Pessoa c3', email: U.c3.email, matricula: MAT.c3, setor: 'Manutenção', centroCusto: 'CC-c3', cargo: 'Mecânico', ativo: true };
    try {
      assert.equal((await painel(U.alm, 'POST', `${API}/colaboradores`, base)).s, 200);
      const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { nome: base.nome, email: base.email, matricula: base.matricula, ativo: true });
      assert.equal(r.s, 200, JSON.stringify(r.j));
      const c = (await h.q('SELECT setor, centro_custo, cargo FROM emprestimo.colaborador WHERE usuario_id=$1', [U.c3.id])).rows[0];
      assert.deepEqual(c, { setor: 'Manutenção', centro_custo: 'CC-c3', cargo: 'Mecânico' }, 'a edição sem esses campos zerou o cadastro (e os relatórios por setor e centro de custo dependem dele)');
    } finally { await painel(U.alm, 'POST', `${API}/colaboradores`, base); }
  });

test('desligar os avisos no painel cancela o que já esperava na fila de e-mail (não só deixa de enfileirar o novo)',
  async () => {
    // o teste de paridade deixa lembrete em 720 h e escalonamento em 12 h: volta ao padrão para este cenário ser o mesmo em qualquer ordem
    assert.equal((await painel(U.ges, 'PUT', `${API}/config`, { lembreteAntesHoras: 24, atrasoIntervaloHoras: 24 })).s, 200);
    assert.equal((await painel(U.ges, 'PUT', `${API}/avisos/config`, { avisosAtivos: true, avisoNoVencimento: true, avisoDevolucao: false, escalarAposHoras: 48 })).s, 200);
    const e = await emprestarComPrazo('t3', [{ ferramentaId: F.estoque, quantidade: '1' }], 72);
    const pendentes = async () => (await avisosDe(e)).filter(a => a.status === 'pendente').length;
    try {
      await rodar(+e.prazo - HORA);
      assert.equal(await pendentes(), 1, `o lembrete entrou na fila: ${JSON.stringify(await avisosDe(e))}`);
      assert.equal((await painel(U.ges, 'PUT', `${API}/avisos/config`, { avisosAtivos: false })).s, 200);
      await rodar(+e.prazo + 2 * HORA);
      assert.equal(await pendentes(), 0, 'avisos desligados e o e-mail do lembrete continua pendente para o worker enviar');
    } finally {
      await painel(U.ges, 'PUT', `${API}/avisos/config`, { avisosAtivos: true });
      await h.q("UPDATE core.email_fila SET status='cancelado', erro='Limpeza do teste' WHERE status='pendente' AND id IN (SELECT email_id FROM emprestimo.aviso WHERE emprestimo_id=$1)", [e.id]);
      const it = (await h.q('SELECT id FROM emprestimo.emprestimo_item WHERE emprestimo_id=$1', [e.id])).rows[0].id;
      await exec(U.alm, 'devolver', { emprestimoId: e.id, itens: [{ itemId: it, quantidade: '1' }] });
      await exec(U.alm, 'conferir', { emprestimoId: e.id, itens: [{ itemId: it, quantidade: '1', resultado: 'boa' }] });
    }
  });

test('patrimônio novo com mais de 80 caracteres é recusado (400), como no cadastro da ferramenta, e não gravado cortado em 80',
  async () => {
    const f = (await exec(U.alm, 'ferramenta_salvar', { codigo: 'FER-C012', nome: 'Patrimônio longo (teste)', controle: 'individual', unidades: ['PAT-L1'] })).id;
    const longo = 'p'.repeat(81);
    const cria = await painel(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-C014', nome: 'Patrimônio longo no cadastro (teste)', controle: 'individual', unidades: [longo] });
    assert.equal(cria.s, 400, 'o cadastro da ferramenta recusa 81 caracteres');
    const r = await painel(U.alm, 'POST', `${API}/ferramentas/${f}/unidades`, { identificador: longo });
    const gravadas = (await h.q('SELECT identificador FROM emprestimo.ferramenta_unidade WHERE ferramenta_id=$1', [f])).rows.map(x => x.identificador);
    assert.ok(r.s === 400 && !gravadas.some(x => x !== 'PAT-L1'), `a unidade nova respondeu ${r.s} e gravou ${JSON.stringify(gravadas.filter(x => x !== 'PAT-L1').map(x => x.length))} caracteres`);
  });

test('e-mail com mais de 254 caracteres (o limite do endereço) é recusado no cadastro do colaborador, em vez de virar usuário que nunca recebe aviso',
  async () => {
    const longo = `${'a'.repeat(250)}@teste.biotrop`;
    const r = await painel(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa E-mail Longo', email: longo, matricula: '830010', setor: 'Manutenção' });
    const criados = (await h.q('SELECT count(*)::int n FROM core.usuario WHERE length(email::text) > 254')).rows[0].n;
    assert.ok(r.s === 400 && criados === 0, `e-mail de ${longo.length} caracteres: respondeu ${r.s} e criou ${criados} usuário(s)`);
  });

/* ---------------------------------------------------------------- relatórios: volume (por último: insere empréstimos de carga, sem itens) */
test('lista e relatório de empréstimos com mais de 200 registros: os mais recentes não podem ficar de fora e o limite precisa ser pedido (?limite=)',
 async () => {
    await h.q(`INSERT INTO emprestimo.emprestimo (colaborador_id, matricula, setor, centro_custo, atendente_id, origem, prazo, status, chave, criado_em, encerrado_em)
      SELECT $1, $2, 'Manutenção', 'CC-t1', NULL, 'terminal', now() - interval '400 days' + (g || ' hours')::interval, 'devolvido', 'carga-relatorio-' || g,
             now() - interval '400 days' + (g || ' hours')::interval - interval '2 hours', now() - interval '399 days' FROM generate_series(1, 230) g`, [U.t1.id, MAT.t1]);
    const novo = (await h.q("SELECT numero FROM emprestimo.emprestimo WHERE chave = 'carga-relatorio-230'")).rows[0].numero;
    const padrao = (await painel(U.alm, 'GET', `${API}/emprestimos?status=devolvido&colaborador=${U.t1.id}`)).j.rows;
    assert.ok(padrao.some(r => r.numero === novo), `a lista padrão (${padrao.length} linhas) deixou de fora o empréstimo mais recente do colaborador`);
    const todos = (await painel(U.alm, 'GET', `${API}/emprestimos?status=devolvido&colaborador=${U.t1.id}&limite=500`)).j.rows;
    assert.ok(todos.length >= 230, `com ?limite=500 vieram só ${todos.length} linhas (a rota ignora o parâmetro)`);
  });

test('terminal: "Meus empréstimos > Histórico" de quem tem mais de 200 empréstimos fechados não corta em silêncio (o servidor devolve 200 e não diz que há mais)',
  async () => {
    await h.q(`INSERT INTO emprestimo.emprestimo (colaborador_id, matricula, setor, centro_custo, atendente_id, origem, prazo, status, chave, criado_em, encerrado_em)
      SELECT $1, $2, 'Manutenção', 'CC-t6', NULL, 'terminal', now() - interval '500 days' + (g || ' hours')::interval, 'devolvido', 'carga-hist-' || g,
             now() - interval '500 days' + (g || ' hours')::interval - interval '2 hours', now() - interval '499 days' FROM generate_series(1, 230) g`, [U.t6.id, MAT.t6]);
    const t = tablet();
    assert.equal((await t.entrar(MAT.t6, SENHA('t6'))).s, 200);
    const r = await t.req('GET', '/api/terminal/emprestimos?situacao=todos');
    assert.equal(r.s, 200, JSON.stringify(r.j).slice(0, 200));
    const avisa = ['cortado', 'total', 'limite', 'truncado', 'proxima', 'maisAntigos', 'pagina'].some(k => k in r.j);
    assert.ok(r.j.rows.length >= 230 || avisa, `a pessoa tem 230+ empréstimos fechados e o tablet recebeu ${r.j.rows.length} sem nenhum aviso de corte (chaves da resposta: ${Object.keys(r.j).join(', ')})`);
    // as páginas do painel (?limite= e ?pagina=) mostram que o histórico completo existe
    const todos = (await painel(U.alm, 'GET', `${API}/emprestimos?status=devolvido&colaborador=${U.t6.id}&limite=500`)).j.rows;
    assert.ok(todos.length >= 230, `o painel enxerga ${todos.length}`);
  });

/* ---------------------------------------------------------------- entrada hostil, rodada 2: 5xx que sobraram */
test('avisos/config: escalarAposHoras com objeto {"toString":1} (ou valueOf) recebe 400 — o Number() do corpo não pode lançar e virar erro interno',
  async () => {
    const ruins = await cincoXX([
      ['avisos/config toString', 'PUT', `${API}/avisos/config`, JSON.stringify({ escalarAposHoras: { toString: 1 } }), U.ges],
      ['avisos/config toString+valueOf', 'PUT', `${API}/avisos/config`, JSON.stringify({ escalarAposHoras: { toString: 1, valueOf: 1 } }), U.ges],
      ['avisos/config lista', 'PUT', `${API}/avisos/config`, JSON.stringify({ escalarAposHoras: [12] }), U.ges],
      ['config toString', 'PUT', `${API}/config`, JSON.stringify({ prazoPadraoHoras: { toString: 1 } }), U.ges]
    ]);
    assert.deepEqual(ruins, [], 'erro interno com objeto no lugar do número');
  });

test('corpo comprimido corrompido (gzip ou deflate que não é gzip ou deflate) recebe 400, não 500 — na API do terminal e no painel',
  async () => {
    const log = console.error; console.error = () => {};
    try {
      const ruins = [];
      for (const [metodo, url, usuario] of [['POST', '/api/terminal/entrar'], ['POST', '/api/terminal/primeiro-acesso'], ['POST', '/api/terminal/saida-admin'], ['POST', `${API}/colaboradores`, U.alm], ['PUT', `${API}/config`, U.ges]]) {
        for (const codificacao of ['gzip', 'deflate']) {
          const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json', 'content-encoding': codificacao, 'x-forwarded-for': novoIp() };
          if (usuario) headers.cookie = `biotrop_session=${createSession({ id: usuario.id, sessaoVersao: usuario.sv }).valor}`;
          const r = await fetch(h.raiz + url, { method: metodo, headers, body: Buffer.from('isto não é um corpo comprimido') });
          await r.arrayBuffer();
          if (r.status !== 400) ruins.push(`${metodo} ${url} (${codificacao}) → ${r.status}`);
        }
      }
      assert.deepEqual(ruins, [], 'corpo corrompido deveria ser 400');
    } finally { console.error = log; }
  });

test('caminho com porcentagem malformada (%E0%A4%A) recebe 400, não 500 — rotas com :id do painel e do terminal',
  async () => {
    const t = tablet(); assert.equal((await t.entrar(MAT.t1, SENHA('t1'))).s, 200);
    const log = console.error; console.error = () => {};
    try {
      const ruins = [];
      const alvos = [[`${API}/emprestimos/%E0%A4%A`, U.alm], [`${API}/ferramentas/%E0%A4%A`, U.alm], [`${API}/ferramentas/%E0%A4%A/foto`, U.alm], ['/api/terminal/emprestimos/%E0%A4%A', null], ['/api/terminal/ferramentas/%E0%A4%A/foto', null]];
      for (const [url, usuario] of alvos) {
        const headers = { 'x-forwarded-for': novoIp() };
        headers.cookie = usuario ? `biotrop_session=${createSession({ id: usuario.id, sessaoVersao: usuario.sv }).valor}` : t.cookie;
        const r = await fetch(h.raiz + url, { headers }); await r.arrayBuffer();
        if (r.status !== 400) ruins.push(`GET ${url} → ${r.status}`);
      }
      assert.deepEqual(ruins, [], 'endereço malformado deveria ser 400');
    } finally { console.error = log; }
  });

test('leituras do painel: objeto na query string (?de[toString]=1, ?ate[...], ?limite[...], ?pagina[...]) não vira erro interno — o Express entrega {toString:"1"} e o RegExp.test/parseInt lançam TypeError',
  async () => {
    const log = console.error; console.error = () => {};
    try {
      const ruins = [];
      const alvos = ['emprestimos?de[toString]=1', 'emprestimos?ate[toString]=1', 'emprestimos?limite[toString]=1', 'emprestimos?pagina[toString]=1', 'emprestimos?de[valueOf]=1', 'avisos?limite[toString]=1',
        'ferramentas?q[toString]=1', 'ferramentas?categoria[toString]=1', 'emprestimos?q[toString]=1', 'emprestimos?status[toString]=1', 'colaboradores?q[toString]=1'];
      for (const alvo of alvos) {
        const r = await fetch(`${h.raiz}${API}/${alvo}`, { headers: { cookie: `biotrop_session=${createSession({ id: U.alm.id, sessaoVersao: U.alm.sv }).valor}`, 'x-forwarded-for': novoIp() } });
        await r.arrayBuffer();
        if (r.status >= 500) ruins.push(`GET ${alvo} → ${r.status}`);
      }
      assert.deepEqual(ruins, [], 'objeto na query string deveria ser ignorado ou recusado com 400');
    } finally { console.error = log; }
  });
