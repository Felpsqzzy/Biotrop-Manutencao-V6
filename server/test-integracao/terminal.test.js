'use strict';
// Terminal do almoxarifado (fase 4, migration 41): acesso por matrícula + senha, convite, bloqueios, sessão separada do
// site, retirada/devolução só para si e saída administrativa com 2FA. App e banco de verdade (PGlite, papel biotrop_app).
// Dados fictícios: pessoas "Pessoa x" do harness, matrículas 7000x, ferramentas FER-T00x.
process.env.TERMINAL_SCRYPT_LOG2N = '14';   // scrypt mais leve só no teste (o formato guarda o N usado)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirApp } = require('./_harness');

let h, U;
const MIG = path.resolve(__dirname, '../../database/migrations');
const SENHA = { t1: '480613', t1b: '592816', t2: '371940', adm: '846205', alm: '730518' };   // PINs fictícios (6 dígitos)
const MAT = { t1: '700001', t2: '700002', t3: '700003', inat: '700009', adm: 'A70001', ges: 'G70001', alm: 'L70001' };
const F = {};
const segredos = [];   // tudo o que não pode aparecer em auditoria/resposta
let ipN = 0;
const novoIp = () => `10.20.${Math.floor(++ipN / 250)}.${ipN % 250 + 1}`;

test.before(async () => {
  h = await subirApp({ adm: 'admin', ges: 'gestor', alm: 'almoxarife', tec: 'tecnico', t1: 'terminal', t2: 'terminal', t3: 'terminal', inat: 'terminal' });
  U = h.users;
  segredos.push(...Object.values(SENHA));
});
test.after(() => h?.fechar());

/** Navegador do tablet: guarda o cookie do terminal entre as chamadas; cada um com um IP (X-Forwarded-For, trust proxy 1). */
function tablet(ip = novoIp()) {
  const t = { cookie: '', ip };
  t.req = async (method, url, body, extra = {}) => {
    const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': ip, ...extra };
    if (t.cookie && !headers.cookie) headers.cookie = t.cookie;
    const r = await fetch(h.raiz + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie();
    for (const c of sc) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      if (kv.slice(0, i) === 'biotrop_terminal') t.cookie = kv.slice(i + 1) ? kv : '';
    }
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j, setCookie: sc, headers: r.headers };
  };
  t.entrar = (matricula, senha) => t.req('POST', '/api/terminal/entrar', { matricula, senha });
  return t;
}
const painel = (u, method, url, body) => h.api(u, method, url, body);
async function convite(quem, alvo) {
  const r = await painel(quem, 'POST', `/api/emprestimo/colaboradores/${alvo.id}/convite`);
  if (r.s === 201) segredos.push(r.j.codigo);
  return r;
}
async function ativar(alvo, matricula, senha, quem = U.alm) {
  const c = await convite(quem, alvo);
  assert.equal(c.s, 201, JSON.stringify(c.j));
  const t = tablet();
  const r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula, codigo: c.j.codigo, senha });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  return t;
}
const acesso = async u => (await painel(U.alm, 'GET', '/api/emprestimo/colaboradores')).j.rows.find(r => r.usuarioId === u.id).acesso;
const cred = async u => (await h.q('SELECT * FROM emprestimo.terminal_credencial WHERE usuario_id=$1', [u.id])).rows[0];
let chaveN = 0;
const chave = () => `term-chave-${++chaveN}-${Date.now()}`;

test('preparação: ferramentas e colaboradores fictícios pelo painel', async () => {
  let r = await painel(U.alm, 'POST', '/api/emprestimo/ferramentas', { codigo: 'FER-T001', nome: 'Alicate universal (teste)', categoria: 'Manual', controle: 'quantidade', total: 4, localizacao: 'Armário T' });
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.alicate = r.j.id;
  r = await painel(U.alm, 'POST', '/api/emprestimo/ferramentas', { codigo: 'FER-T002', nome: 'Esmerilhadeira (teste)', categoria: 'Elétrica', controle: 'individual', unidades: ['PAT-T10', 'PAT-T11'] });
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.esmeril = r.j.id;
  r = await painel(U.alm, 'POST', '/api/almox/materiais/importar', { linhas: [{ codigo: 'MAN-T1', descricao: 'Fita isolante (teste)', unidade: 'UN' }], campos: ['descricao', 'unidade'] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  for (const k of ['t1', 't2', 't3', 'inat', 'adm', 'ges', 'alm']) {
    const corpo = { nome: `Pessoa ${k}`, email: U[k].email, matricula: MAT[k], setor: 'Manutenção', centroCusto: `CC-${k}`, cargo: 'Mecânico', ativo: k !== 'inat' };
    // conta de administrador ou gestor: cadastro no terminal só pela gerência (como o convite e o bloqueio)
    if (k === 'adm' || k === 'ges') {
      r = await painel(U.alm, 'POST', '/api/emprestimo/colaboradores', corpo);
      assert.deepEqual([r.s, r.j.erro], [403, 'Cadastro de administrador ou gestor no terminal só pela gerência.'], k);
    }
    r = await painel(k === 'adm' || k === 'ges' ? U.ges : U.alm, 'POST', '/api/emprestimo/colaboradores', corpo);
    assert.equal(r.s, 200, `${k}: ${JSON.stringify(r.j)}`);
  }
  const a = await acesso(U.t1);
  assert.deepEqual(a, { situacao: 'sem_acesso', ultimoAcesso: null, conviteExpiraEm: null });
});

test('convite: código XXXX-XXXX só na resposta (banco guarda HMAC); inativo não recebe; almoxarife não convida admin/gestor', async () => {
  const r = await convite(U.alm, U.t1);
  assert.equal(r.s, 201, JSON.stringify(r.j));
  assert.match(r.j.codigo, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(r.j.redefinicao, false);
  const horas = (new Date(r.j.expiraEm) - Date.now()) / 36e5;
  assert.ok(horas > 71.9 && horas <= 72.01, `72 h (${horas})`);
  const guardado = (await h.q('SELECT codigo_hash FROM emprestimo.terminal_convite WHERE usuario_id=$1', [U.t1.id])).rows;
  assert.equal(guardado.length, 1); assert.match(guardado[0].codigo_hash, /^[0-9a-f]{64}$/);
  assert.ok(!guardado[0].codigo_hash.includes(r.j.codigo.replace('-', '')), 'código não fica em claro');
  const a = await acesso(U.t1);
  assert.equal(a.situacao, 'convite_pendente'); assert.ok(a.conviteExpiraEm);
  assert.equal((await convite(U.alm, U.inat)).s, 409, 'colaborador inativo não recebe convite');
  assert.equal((await convite(U.alm, U.adm)).s, 403, 'almoxarife não convida admin');
  assert.equal((await convite(U.alm, U.ges)).s, 403, 'almoxarife não convida gestor');
  assert.equal((await convite(U.tec, U.t2)).s, 403, 'técnico não administra o terminal');
  assert.equal((await convite(U.alm, U.tec)).s, 404, 'sem cadastro no terminal');
  const lista = await painel(U.alm, 'GET', '/api/emprestimo/colaboradores');
  assert.ok(!/codigo|hash|senha/i.test(JSON.stringify(lista.j)), 'a lista do painel não traz código, hash nem senha');
});

test('primeiro acesso: senha fraca antes do convite, código errado, válido entra, reuso e expirado recusados', async () => {
  const c = await convite(U.alm, U.t1);   // novo convite invalida o anterior
  assert.equal((await h.q('SELECT count(*)::int n FROM emprestimo.terminal_convite WHERE usuario_id=$1 AND usado_em IS NULL AND invalidado_em IS NULL', [U.t1.id])).rows[0].n, 1);
  const t = tablet();
  for (const [senha, motivo] of [['48061', /6 dígitos/], ['Furadeira#Azul7', /6 dígitos/], ['123456', /sequência/], ['555555', /iguais/], [MAT.t1, /matrícula/]]) {
    const r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: 'ERRA-DO22', senha });
    assert.equal(r.s, 400, senha); assert.match(r.j.erro, motivo);
  }
  let r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: 'ABCD-EFGH', senha: SENHA.t1 });
  assert.deepEqual([r.s, r.j], [400, { ok: false, erro: 'Código inválido ou expirado.' }]);
  r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: c.j.codigo.toLowerCase().replace('-', ' '), senha: SENHA.t1 });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.colaborador, { nome: 'Pessoa t1', matricula: MAT.t1, setor: 'Manutenção', centroCusto: 'CC-t1', cargo: 'Mecânico' });
  assert.ok(Number.isInteger(r.j.inatividadeSegundos) && r.j.inatividadeSegundos >= 30);
  assert.ok(t.cookie, 'já entrou');
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 200);
  assert.equal((await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: c.j.codigo, senha: '927364' })).s, 400, 'código reusado');
  const hash = (await cred(U.t1)).senha_hash;
  assert.match(hash, /^scrypt\$1\$16384\$8\$1\$/); assert.ok(!hash.includes(SENHA.t1));
  assert.equal((await acesso(U.t1)).situacao, 'ativo');
  // expirado
  const c2 = await convite(U.alm, U.t2);
  await h.q("UPDATE emprestimo.terminal_convite SET expira = now() - interval '1 minute' WHERE usuario_id=$1 AND usado_em IS NULL AND invalidado_em IS NULL", [U.t2.id]);
  r = await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t2, codigo: c2.j.codigo, senha: SENHA.t2 });
  assert.deepEqual([r.s, r.j.erro], [400, 'Código inválido ou expirado.']);
  assert.equal((await acesso(U.t2)).situacao, 'sem_acesso', 'convite vencido');
  await ativar(U.t2, MAT.t2, SENHA.t2);
});

test('entrar: válido; inexistente, senha errada, sem senha, inativo e bloqueado com a MESMA resposta', async () => {
  const t = tablet();
  let r = await t.entrar(MAT.t1, SENHA.t1);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.colaborador.matricula, MAT.t1);
  const ck = r.setCookie.find(c => c.startsWith('biotrop_terminal='));
  assert.match(ck, /HttpOnly/i); assert.match(ck, /SameSite=Strict/i); assert.match(ck, /Path=\//);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const esperado = { ok: false, erro: 'Matrícula ou senha inválidas.' };
  const ip = tablet();
  const casos = {
    senhaErrada: await ip.entrar(MAT.t1, 'Senha-Errada-01'),
    inexistente: await ip.entrar('799999', SENHA.t1),
    formatoRuim: await ip.entrar('../x', SENHA.t1),
    semSenha: await ip.entrar(MAT.t3, 'Qualquer-Coisa-1')
  };
  await painel(U.alm, 'POST', '/api/emprestimo/colaboradores', { nome: 'Pessoa t2', email: U.t2.email, matricula: MAT.t2, setor: 'Manutenção', centroCusto: 'CC-t2', ativo: false });
  casos.inativo = await ip.entrar(MAT.t2, SENHA.t2);
  await painel(U.alm, 'POST', '/api/emprestimo/colaboradores', { nome: 'Pessoa t2', email: U.t2.email, matricula: MAT.t2, setor: 'Manutenção', centroCusto: 'CC-t2', cargo: 'Mecânico', ativo: true });
  await h.q("UPDATE core.usuario SET bloqueado=true, motivo_bloqueio='Teste do terminal' WHERE id=$1", [U.t2.id]);
  casos.bloqueadoNoSite = await ip.entrar(MAT.t2, SENHA.t2);
  await h.q('UPDATE core.usuario SET bloqueado=false, motivo_bloqueio=NULL WHERE id=$1', [U.t2.id]);
  for (const [k, v] of Object.entries(casos)) { assert.equal(v.s, 401, k); assert.deepEqual(v.j, esperado, k); assert.ok(!v.setCookie.some(c => /biotrop_terminal=[^;]/.test(c)), `${k} sem cookie`); }
  assert.equal((await tablet().entrar(MAT.t2, SENHA.t2)).s, 200, 'reativado entra de novo');
  const tent = (await h.q("SELECT resultado FROM emprestimo.terminal_tentativa WHERE tipo='entrar' ORDER BY id")).rows.map(x => x.resultado);
  for (const k of ['ok', 'senha', 'inexistente', 'sem_senha', 'inativo', 'bloqueado']) assert.ok(tent.includes(k), `tentativa ${k} registrada`);
});

test('bloqueio temporário: 5 erros seguidos travam a matrícula (até com a senha certa); painel desbloqueia; níveis 5/15 min', async () => {
  const t = tablet();
  for (let i = 0; i < 5; i += 1) assert.equal((await t.entrar(MAT.t2, `Errada-${i}-xyz`)).s, 401);
  let r = await t.entrar(MAT.t2, SENHA.t2);
  assert.deepEqual([r.s, r.j.erro], [401, 'Matrícula ou senha inválidas.'], 'bloqueado: mesma resposta, mesmo com a senha certa');
  let c = await cred(U.t2);
  const min = (new Date(c.bloqueado_ate) - Date.now()) / 6e4;
  assert.ok(min > 4 && min <= 5.1, `5 min (${min})`); assert.equal(c.nivel_bloqueio, 1);
  assert.equal((await acesso(U.t2)).situacao, 'bloqueado_temporario');
  assert.equal((await tablet().entrar(MAT.t1, SENHA.t1)).s, 200, 'outra matrícula no mesmo tablet continua');
  // desbloqueio pelo painel (com justificativa); almoxarife não mexe em admin/gestor
  assert.equal((await painel(U.alm, 'POST', `/api/emprestimo/colaboradores/${U.t2.id}/acesso`, { bloqueado: false, justificativa: 'x' })).s, 400);
  assert.equal((await painel(U.tec, 'POST', `/api/emprestimo/colaboradores/${U.t2.id}/acesso`, { bloqueado: false, justificativa: 'Conferido com a pessoa' })).s, 403);
  r = await painel(U.alm, 'POST', `/api/emprestimo/colaboradores/${U.t2.id}/acesso`, { bloqueado: false, justificativa: 'Conferido com a pessoa' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.acesso.situacao, 'ativo');
  assert.equal((await t.entrar(MAT.t2, SENHA.t2)).s, 200);
  // progressivo: bloqueio recente (nível 1) → próximo é de 15 min
  await h.q("UPDATE emprestimo.terminal_credencial SET nivel_bloqueio=1, falhas=4, bloqueado_ate=now() - interval '1 minute' WHERE usuario_id=$1", [U.t2.id]);
  assert.equal((await tablet().entrar(MAT.t2, 'Errada-final-1')).s, 401);
  c = await cred(U.t2);
  const min2 = (new Date(c.bloqueado_ate) - Date.now()) / 6e4;
  assert.ok(min2 > 14 && min2 <= 15.1, `15 min (${min2})`); assert.equal(c.nivel_bloqueio, 2);
  // 5 reservas que não voltaram (pedidos simultâneos) já valem como bloqueio
  await painel(U.alm, 'POST', `/api/emprestimo/colaboradores/${U.t2.id}/acesso`, { bloqueado: false, justificativa: 'Liberado de novo' });
  await h.q('UPDATE emprestimo.terminal_credencial SET falhas=5 WHERE usuario_id=$1', [U.t2.id]);
  assert.equal((await tablet().entrar(MAT.t2, SENHA.t2)).s, 401);
  assert.ok((await cred(U.t2)).bloqueado_ate > new Date());
  await painel(U.alm, 'POST', `/api/emprestimo/colaboradores/${U.t2.id}/acesso`, { bloqueado: false, justificativa: 'Liberado de novo' });
  const tipos = (await h.q('SELECT tipo FROM emprestimo.auditoria WHERE usuario_alvo=$1', [U.t2.id])).rows.map(x => x.tipo);
  assert.ok(tipos.includes('terminal_bloqueio_temporario') && tipos.includes('terminal_desbloqueio'));
});

test('limite por aparelho: muitos erros do mesmo IP → 429; outro IP segue normal', async () => {
  const t = tablet();
  for (let i = 0; i < 30; i += 1) assert.equal((await t.entrar(`79${String(i).padStart(4, '0')}`, 'Qualquer-1x')).s, 401);
  let r = await t.entrar(MAT.t1, SENHA.t1);
  assert.deepEqual([r.s, r.j.erro], [429, 'Muitas tentativas. Aguarde alguns minutos.']);
  r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: 'ABCD-EFGH', senha: '615283' });
  assert.equal(r.s, 429);
  assert.equal((await tablet().entrar(MAT.t1, SENHA.t1)).s, 200);
  const guardados = (await h.q('SELECT DISTINCT ip_hash FROM emprestimo.terminal_tentativa')).rows.map(x => x.ip_hash);
  assert.ok(guardados.every(x => /^[0-9a-f]{64}$/.test(x)) && !guardados.some(x => x.includes('10.20.')), 'só o HMAC do IP');
});

/** Conta as chamadas de uma função da lib da senha (a rota usa senhas.<função> a cada pedido). */
async function contando(nome, fn) {
  const senhas = require('../src/lib/senha-terminal');
  const orig = senhas[nome]; let n = 0;
  senhas[nome] = (...a) => { n += 1; return orig(...a); };
  try { await fn(); } finally { senhas[nome] = orig; }
  return n;
}
const porStatus = rs => rs.reduce((m, r) => ({ ...m, [r.s]: (m[r.s] || 0) + 1 }), {});

test('limite por aparelho com pedidos simultâneos: a tentativa é reservada antes do scrypt — no máximo 30 senhas conferidas, o resto 429', async () => {
  const senhas = require('../src/lib/senha-terminal');
  const t = tablet();
  let rs;
  const conferidas = await contando('verificar', async () => {
    rs = await Promise.all(Array.from({ length: 40 }, (_, i) => t.entrar(`78${String(i).padStart(4, '0')}`, 'Qualquer-1x')));
  });
  // a vaga do scrypt vem antes da reserva no banco (2 + 32 na fila): acima disso, 503 sem reservar nada
  let st = porStatus(rs);
  assert.equal(st[401], 30); assert.equal((st[429] || 0) + (st[503] || 0), 10, JSON.stringify(st));
  assert.equal(conferidas, 30, 'só 30 scrypts para o aparelho');
  const linhas = (await h.q('SELECT resultado, count(*)::int n FROM emprestimo.terminal_tentativa WHERE ip_hash=$1 GROUP BY 1 ORDER BY 1', [senhas.hashIp(t.ip)])).rows;
  assert.deepEqual(linhas, [{ resultado: 'inexistente', n: 30 }, ...(st[429] ? [{ resultado: 'limite_ip', n: st[429] }] : [])], 'toda reserva virou o resultado final (nada pendente; o 503 não reservou)');
  // primeiro acesso do mesmo jeito (matrículas inexistentes: nenhuma credencial é tocada)
  const t2 = tablet();
  const hashes = await contando('gerarHash', async () => {
    rs = await Promise.all(Array.from({ length: 35 }, (_, i) => t2.req('POST', '/api/terminal/primeiro-acesso', { matricula: `77${String(i).padStart(4, '0')}`, codigo: 'ABCD-EFGH', senha: '615283' })));
  });
  st = porStatus(rs);
  assert.equal(st[400], 30); assert.equal((st[429] || 0) + (st[503] || 0), 5, JSON.stringify(st));
  assert.equal(hashes, 30, 'o aparelho barrado não calcula hash');
});

test('primeiro acesso com o aparelho acima do limite: 429 sem calcular o scrypt da senha nova (entrar já fazia assim)', async () => {
  const t = tablet();
  for (let i = 0; i < 30; i += 1) assert.equal((await t.entrar(`76${String(i).padStart(4, '0')}`, 'Qualquer-1x')).s, 401);
  let r;
  const hashes = await contando('gerarHash', async () => {
    r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: 'ABCD-EFGH', senha: '615283' });
  });
  assert.deepEqual([r.s, r.j.erro], [429, 'Muitas tentativas. Aguarde alguns minutos.']);
  assert.equal(hashes, 0, 'nenhum scrypt (128 MiB) para quem já passou do limite');
  r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: 'ABCD', senha: '1234' });
  assert.equal(r.s, 400, 'senha fraca continua recusada antes de tudo');
});

test('limite por IP do app vale também para /ENTRAR/ (maiúsculas e barra final chegam à mesma rota)', async () => {
  const t = tablet();
  const respostas = [];
  // matrícula diferente a cada pedido: não cai no limite de IP + matrícula (depois de 30, o do aparelho no banco responde
  // "Muitas tentativas"; o do app, "Muitas requisições", só a partir do 201º)
  for (let i = 0; i < 201; i += 1) respostas.push(await t.req('POST', i % 2 ? '/api/terminal/ENTRAR/' : '/api/terminal/Entrar', { matricula: `7999xx!${i}`, senha: 'x' }));
  assert.equal(respostas[0].s, 401, 'a variação do caminho chega ao login');
  assert.ok(respostas.slice(0, 200).every(r => r.j.erro !== 'Muitas requisições. Aguarde e tente novamente.'), 'os 200 primeiros passam pelo limite do app');
  assert.deepEqual([respostas[200].s, respostas[200].j.erro], [429, 'Muitas requisições. Aguarde e tente novamente.'], 'a 201ª passa do limite do app');
});

test('limite por IP + matrícula: quem insiste numa matrícula para na 11ª e não gasta o limite dos colegas no mesmo tablet', async () => {
  const t = tablet();
  const respostas = [];
  for (let i = 0; i < 11; i += 1) respostas.push(await t.req('POST', '/api/terminal/entrar', { matricula: ' 7998XX! ', senha: 'x' }));
  assert.deepEqual(respostas.slice(0, 10).map(r => r.s), Array(10).fill(401));
  assert.deepEqual([respostas[10].s, respostas[10].j.erro], [429, 'Muitas requisições. Aguarde e tente novamente.']);
  // a mesma matrícula com outra caixa/espaços é a mesma chave; outra pessoa no mesmo IP entra normalmente
  assert.equal((await t.req('POST', '/api/terminal/entrar', { matricula: '7998xx!', senha: 'x' })).s, 429);
  assert.equal((await t.entrar(MAT.t1, SENHA.t1)).s, 200, 'o colega no mesmo tablet não foi barrado');
});

test('hash com parâmetro antigo é regravado no login certo (sem mudar a versão nem derrubar sessão)', async () => {
  const crypto = require('node:crypto');
  const sal = crypto.randomBytes(16);
  const antigo = ['scrypt', '1', 4096, 8, 1, sal.toString('base64'), crypto.scryptSync(SENHA.t2, sal, 32, { N: 4096, r: 8, p: 1 }).toString('base64')].join('$');
  const v = (await cred(U.t2)).versao;
  await h.q('UPDATE emprestimo.terminal_credencial SET senha_hash=$2 WHERE usuario_id=$1', [U.t2.id, antigo]);
  // a API sabe (sem ler sal nem hash) que há custo antigo gravado: todo login passa a calcular os dois custos
  const emUso = async () => (await h.transaction(null, db => db.query('SELECT emprestimo.terminal_parametros_hash() AS p'))).rows[0].p;
  assert.deepEqual(await emUso(), ['scrypt$1$16384$8$1', 'scrypt$1$4096$8$1']);
  assert.equal((await tablet().entrar(MAT.t2, SENHA.t2)).s, 200);
  const c = await cred(U.t2);
  assert.match(c.senha_hash, /^scrypt\$1\$16384\$8\$1\$/); assert.equal(c.versao, v);
  assert.deepEqual(await emUso(), ['scrypt$1$16384$8$1'], 'regravado: o custo antigo sai da lista');
  assert.equal((await tablet().entrar(MAT.t2, SENHA.t2)).s, 200, 'continua entrando com o hash novo');
});

test('sessões separadas: cookie do terminal não vale no site; cookie do site não vale no terminal; sem sessão → 401', async () => {
  const semSessao = tablet();
  for (const [m, u, b] of [['GET', '/api/terminal/eu'], ['GET', '/api/terminal/ferramentas'], ['GET', '/api/terminal/emprestimos'],
    ['GET', `/api/terminal/emprestimos/${F.alicate}`], ['POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.alicate, quantidade: 1 }], chave: chave() }],
    ['POST', `/api/terminal/emprestimos/${F.alicate}/devolucoes`, { itens: [], chave: chave() }]]) {
    const r = await semSessao.req(m, u, b);
    assert.deepEqual([r.s, r.j], [401, { ok: false, erro: 'Sessão do terminal encerrada.' }], `${m} ${u}`);
  }
  const t = tablet();
  assert.equal((await t.entrar(MAT.t1, SENHA.t1)).s, 200);
  const valor = t.cookie.split('=')[1];
  segredos.push(valor);
  for (const url of ['/auth/me', '/api/emprestimo/ferramentas', '/api/emprestimo/emprestimos', '/api/data/sci', '/api/conta/2fa', '/api/inventario/campanhas', '/assets/modelos/prontuario-diafragmas-rev12.xlsx']) {
    assert.equal((await t.req('GET', url)).s, 401, `cookie do terminal em ${url}`);
    assert.equal((await t.req('GET', url, undefined, { cookie: `biotrop_session=${valor}` })).s, 401, `valor do terminal no cookie do site em ${url}`);
  }
  assert.equal((await t.req('POST', '/auth/logout-todos')).s, 401);
  // cookie do site (almoxarife logado no navegador) não abre o terminal
  const { createSession } = require('../src/auth/session');
  const site = createSession({ id: U.alm.id, sessaoVersao: U.alm.sv }).valor;
  const outro = tablet();
  assert.equal((await outro.req('GET', '/api/terminal/eu', undefined, { cookie: `biotrop_session=${site}` })).s, 401);
  assert.equal((await outro.req('GET', '/api/terminal/eu', undefined, { cookie: `biotrop_terminal=${site}` })).s, 401);
  assert.equal((await outro.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.alicate, quantidade: 1 }], chave: chave() }, { cookie: `biotrop_session=${site}` })).s, 401);
  // e o cookie do terminal continua valendo no terminal
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 200);
});

test('inatividade e validade: depois do prazo o servidor recusa (401) e encerra a sessão; Sair encerra no servidor', async () => {
  const t = tablet();
  assert.equal((await t.entrar(MAT.t1, SENHA.t1)).s, 200);
  const eu = await t.req('GET', '/api/terminal/eu');
  assert.equal(eu.s, 200); assert.ok(new Date(eu.j.expiraEm) > new Date());
  const ina = (await h.q('SELECT inatividade_segundos s FROM emprestimo.config')).rows[0].s;
  await h.q("UPDATE emprestimo.terminal_sessao SET ultimo_uso = now() - make_interval(secs => $2) WHERE usuario_id=$1 AND encerrada_em IS NULL", [U.t1.id, ina + 1]);
  const copia = t.cookie;
  let r = await t.req('GET', '/api/terminal/ferramentas');
  assert.deepEqual([r.s, r.j.erro], [401, 'Sessão do terminal encerrada.']);
  assert.equal(t.cookie, '', 'cookie apagado');
  assert.equal((await t.req('GET', '/api/terminal/eu', undefined, { cookie: copia })).s, 401, 'não volta a valer');
  const motivos = (await h.q("SELECT motivo FROM emprestimo.terminal_sessao WHERE usuario_id=$1 AND encerrada_em IS NOT NULL", [U.t1.id])).rows.map(x => x.motivo);
  assert.ok(motivos.includes('inatividade'));
  // validade absoluta (30 min)
  assert.equal((await t.entrar(MAT.t1, SENHA.t1)).s, 200);
  const dur = (await h.q("SELECT extract(epoch FROM expira - criada_em)::int s FROM emprestimo.terminal_sessao WHERE usuario_id=$1 AND encerrada_em IS NULL", [U.t1.id])).rows[0].s;
  assert.equal(dur, 1800);
  await h.q("UPDATE emprestimo.terminal_sessao SET expira = now() - interval '1 second' WHERE usuario_id=$1 AND encerrada_em IS NULL", [U.t1.id]);
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401);
  // Sair
  assert.equal((await t.entrar(MAT.t1, SENHA.t1)).s, 200);
  const antes = t.cookie;
  r = await t.req('POST', '/api/terminal/sair');
  assert.deepEqual([r.s, r.j], [200, { ok: true }]);
  assert.equal(t.cookie, '');
  assert.equal((await t.req('GET', '/api/terminal/eu', undefined, { cookie: antes })).s, 401, 'cópia do cookie não vale depois de Sair');
  assert.equal((await t.req('POST', '/api/terminal/sair')).s, 200, 'sair sem sessão também responde ok');
});

test('redefinição, bloqueio pelo painel e desligamento derrubam a sessão na hora', async () => {
  const t = tablet();
  assert.equal((await t.entrar(MAT.t1, SENHA.t1)).s, 200);
  const red = await convite(U.alm, U.t1);
  assert.equal(red.s, 201); assert.equal(red.j.redefinicao, true);
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401, 'redefinição derruba');
  assert.equal((await tablet().entrar(MAT.t1, SENHA.t1)).s, 401, 'senha antiga deixa de valer');
  assert.equal((await acesso(U.t1)).situacao, 'convite_pendente');
  let r = await t.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t1, codigo: red.j.codigo, senha: SENHA.t1b });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await tablet().entrar(MAT.t1, SENHA.t1)).s, 401);
  assert.equal((await tablet().entrar(MAT.t1, SENHA.t1b)).s, 200);
  // bloqueio pelo painel
  r = await painel(U.alm, 'POST', `/api/emprestimo/colaboradores/${U.t1.id}/acesso`, { bloqueado: true, justificativa: 'Crachá extraviado' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.acesso.situacao, 'bloqueado');
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401, 'bloqueio derruba');
  assert.equal((await tablet().entrar(MAT.t1, SENHA.t1b)).s, 401);
  assert.equal((await convite(U.alm, U.t1)).s, 409, 'bloqueado não recebe convite');
  assert.equal((await painel(U.alm, 'POST', `/api/emprestimo/colaboradores/${U.t1.id}/acesso`, { bloqueado: false, justificativa: 'Crachá encontrado' })).s, 200);
  // desligamento do colaborador (cadastro inativo) e bloqueio no site
  assert.equal((await t.entrar(MAT.t1, SENHA.t1b)).s, 200);
  await painel(U.alm, 'POST', '/api/emprestimo/colaboradores', { nome: 'Pessoa t1', email: U.t1.email, matricula: MAT.t1, setor: 'Manutenção', centroCusto: 'CC-t1', cargo: 'Mecânico', ativo: false });
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401, 'desligado cai');
  await painel(U.alm, 'POST', '/api/emprestimo/colaboradores', { nome: 'Pessoa t1', email: U.t1.email, matricula: MAT.t1, setor: 'Manutenção', centroCusto: 'CC-t1', cargo: 'Mecânico', ativo: true });
  assert.equal((await t.entrar(MAT.t1, SENHA.t1b)).s, 200);
  await h.q("UPDATE core.usuario SET bloqueado=true, motivo_bloqueio='Teste do terminal' WHERE id=$1", [U.t1.id]);
  await h.q('UPDATE core.usuario SET bloqueado=false, motivo_bloqueio=NULL WHERE id=$1', [U.t1.id]);
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 401, 'bloqueio no site (versão da sessão) também derruba');
  // gerência: gestor convida e bloqueia conta de administrador; almoxarife não bloqueia
  assert.equal((await painel(U.alm, 'POST', `/api/emprestimo/colaboradores/${U.adm.id}/acesso`, { bloqueado: true, justificativa: 'Tentativa indevida' })).s, 403);
  const tipos = (await h.q('SELECT tipo FROM emprestimo.auditoria WHERE usuario_alvo=$1', [U.t1.id])).rows.map(x => x.tipo);
  for (const k of ['terminal_convite', 'terminal_senha_definida', 'terminal_login', 'terminal_bloqueio', 'terminal_desbloqueio']) assert.ok(tipos.includes(k), k);
});

test('retirada e devolução pelo terminal: só ferramenta, só para si, chave contra repetição', async () => {
  const t = tablet();
  assert.equal((await t.entrar(MAT.t1, SENHA.t1b)).s, 200);
  let r = await t.req('GET', '/api/terminal/ferramentas?q=esmerilhadeira');
  assert.equal(r.s, 200);
  assert.deepEqual(r.j.rows.map(x => x.codigo), ['FER-T002']);
  assert.deepEqual(r.j.rows[0].unidadesDisponiveis.map(u => u.identificador), ['PAT-T10', 'PAT-T11']);
  r = await t.req('GET', '/api/terminal/ferramentas');
  const alic = r.j.rows.find(x => x.codigo === 'FER-T001');
  assert.equal(alic.unidadesDisponiveis, undefined); assert.equal(alic.saldo.disponivel, 4);
  assert.ok(!('ativo' in alic) && !('criadoEm' in alic));
  // material → 400; corpo sem chave → 400
  assert.equal((await t.req('POST', '/api/terminal/emprestimos', { itens: [{ materialCodigo: 'MAN-T1', quantidade: 1 }], chave: chave() })).s, 400);
  assert.equal((await t.req('POST', '/api/terminal/emprestimos', { itens: [{ ferramentaId: F.alicate, quantidade: 1 }] })).s, 400);
  // colaboradorId do corpo é ignorado: registra para quem está logado
  const k = chave();
  const corpo = { itens: [{ ferramentaId: F.alicate, quantidade: 2 }, { ferramentaId: F.esmeril, unidadeId: (await t.req('GET', '/api/terminal/ferramentas?q=esmeril')).j.rows[0].unidadesDisponiveis[0].id, quantidade: 1 }], chave: k, colaboradorId: U.t2.id };
  r = await t.req('POST', '/api/terminal/emprestimos', corpo);
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.emp = r.j.id;
  r = await t.req('POST', '/api/terminal/emprestimos', corpo);
  assert.deepEqual([r.s, r.j.repetido, r.j.id], [200, true, F.emp], 'clique duplo');
  const e = (await h.q('SELECT colaborador_id, origem, atendente_id, matricula FROM emprestimo.emprestimo WHERE id=$1', [F.emp])).rows[0];
  assert.deepEqual(e, { colaborador_id: U.t1.id, origem: 'terminal', atendente_id: null, matricula: MAT.t1 });
  // empréstimo de outra pessoa (pelo painel para t2) não aparece nem se devolve pelo terminal de t1
  r = await painel(U.alm, 'POST', '/api/emprestimo/emprestimos', { colaboradorId: U.t2.id, chave: chave(), itens: [{ ferramentaId: F.alicate, quantidade: 1 }, { materialCodigo: 'MAN-T1', quantidade: 2 }] });
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.empT2 = r.j.id;
  r = await t.req('GET', '/api/terminal/emprestimos?situacao=todos');
  assert.deepEqual(r.j.rows.map(x => x.id), [F.emp], 'só os próprios');
  const linha = r.j.rows[0];
  assert.equal(linha.itensLista.length, 2); assert.equal(linha.pendente, 3);
  assert.equal((await t.req('GET', `/api/terminal/emprestimos/${F.empT2}`)).s, 404);
  const itT2 = (await painel(U.alm, 'GET', `/api/emprestimo/emprestimos/${F.empT2}`)).j.emprestimo.itensLista;
  r = await t.req('POST', `/api/terminal/emprestimos/${F.empT2}/devolucoes`, { itens: [{ itemId: itT2[0].id, quantidade: 1, condicao: 'boa' }], chave: chave() });
  assert.equal(r.s, 404, 'devolver empréstimo de outro');
  // o dono (t2) não devolve material pelo terminal
  const t2 = tablet();
  assert.equal((await t2.entrar(MAT.t2, SENHA.t2)).s, 200);
  const mat = itT2.find(i => i.tipo === 'material');
  assert.equal((await t2.req('POST', `/api/terminal/emprestimos/${F.empT2}/devolucoes`, { itens: [{ itemId: mat.id, quantidade: 1, condicao: 'boa' }], chave: chave() })).s, 400);
  // devolução de t1: avaria sem descrição → 400; sem chave → 400; certo → aguardando conferência; reenvio não duplica
  const det = (await t.req('GET', `/api/terminal/emprestimos/${F.emp}`)).j.emprestimo;
  const alicItem = det.itensLista.find(i => i.ferramentaId === F.alicate);
  assert.equal((await t.req('POST', `/api/terminal/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: alicItem.id, quantidade: 1, condicao: 'avaria' }], chave: chave() })).s, 400);
  assert.equal((await t.req('POST', `/api/terminal/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: alicItem.id, quantidade: 1, condicao: 'avaria', observacao: 'ok' }], chave: chave() })).s, 400);
  assert.equal((await t.req('POST', `/api/terminal/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: alicItem.id, quantidade: 1, condicao: 'boa' }] })).s, 400);
  assert.equal((await t.req('POST', `/api/terminal/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: alicItem.id, quantidade: 1, condicao: 'quebrada' }], chave: chave() })).s, 400);
  const kd = chave();
  const dev = { itens: [{ itemId: alicItem.id, quantidade: 1, condicao: 'avaria', observacao: 'Mordente trincado' }], chave: kd };
  r = await t.req('POST', `/api/terminal/emprestimos/${F.emp}/devolucoes`, dev);
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, 'aguardando_conferencia'); assert.equal(r.j.repetido, false);
  const [r1, r2] = await Promise.all([t.req('POST', `/api/terminal/emprestimos/${F.emp}/devolucoes`, dev), t.req('POST', `/api/terminal/emprestimos/${F.emp}/devolucoes`, dev)]);
  assert.deepEqual([r1.s, r1.j.repetido, r2.s, r2.j.repetido], [200, true, 200, true], 'mesma chave: não devolve em dobro');
  const it = (await h.q('SELECT qtd_conferencia FROM emprestimo.emprestimo_item WHERE id=$1', [alicItem.id])).rows[0];
  assert.equal(Number(it.qtd_conferencia), 1);
  const s = (await h.q('SELECT em_conferencia, emprestada FROM emprestimo.ferramenta_saldo WHERE ferramenta_id=$1', [F.alicate])).rows[0];
  assert.deepEqual(s, { em_conferencia: 1, emprestada: 2 });
  const ev = (await h.q("SELECT justificativa, condicao, chave FROM emprestimo.emprestimo_evento WHERE item_id=$1 AND tipo='devolucao'", [alicItem.id])).rows;
  assert.deepEqual(ev, [{ justificativa: 'Mordente trincado', condicao: 'avaria', chave: kd }], 'observação gravada no evento');
  // painel continua: devolução sem chave e com chave repetida
  r = await painel(U.alm, 'POST', `/api/emprestimo/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: alicItem.id, quantidade: 1, condicao: 'boa' }] });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const kp = chave();
  const unidItem = det.itensLista.find(i => i.ferramentaId === F.esmeril);
  r = await painel(U.alm, 'POST', `/api/emprestimo/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: unidItem.id, quantidade: 1, condicao: 'boa', observacao: 'Devolvida no balcão' }], chave: kp });
  assert.equal(r.j.repetido, false);
  r = await painel(U.alm, 'POST', `/api/emprestimo/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: unidItem.id, quantidade: 1, condicao: 'boa' }], chave: kp });
  assert.deepEqual([r.s, r.j.repetido], [200, true]);
  assert.equal((await painel(U.alm, 'POST', `/api/emprestimo/emprestimos/${F.emp}/devolucoes`, { itens: [{ itemId: alicItem.id, quantidade: 1 }, { itemId: alicItem.id, quantidade: 1 }] })).s, 400, 'item repetido');
});

test('saída administrativa: senha do terminal + 2FA do site; perfil, sem 2FA, código errado e reuso recusados', async () => {
  const totp = require('../src/auth/totp');
  const { cifrarSegredo2fa } = require('../src/crypto/pessoais');
  // gerência convida o admin; almoxarife convida outro almoxarife
  await ativar(U.adm, MAT.adm, SENHA.adm, U.ges);
  await ativar(U.alm, MAT.alm, SENHA.alm, U.alm);
  const segredo = totp.generateSecret();
  await h.q('UPDATE core.usuario SET totp_segredo=$2, totp_ativo=true, totp_ultimo_passo=0 WHERE id=$1', [U.adm.id, await cifrarSegredo2fa(U.adm.id, segredo)]);
  const t = tablet();
  assert.equal((await t.entrar(MAT.t2, SENHA.t2)).s, 200, 'colaborador usando o tablet');
  const sair = b => t.req('POST', '/api/terminal/saida-admin', b);
  const negado = { ok: false, erro: 'Não autorizado.' };
  const codigo = () => totp.codeAt(segredo, totp.stepAt());
  let r = await sair({ matricula: MAT.t2, senha: SENHA.t2, codigo: codigo() });
  assert.deepEqual([r.s, r.j], [401, negado], 'perfil terminal não sai');
  r = await sair({ matricula: MAT.alm, senha: SENHA.alm, codigo: '123456' });
  assert.deepEqual([r.s, r.j], [401, negado], 'almoxarife sem 2FA ativo não sai');
  r = await sair({ matricula: MAT.adm, senha: 'Senha-Errada-99', codigo: codigo() });
  assert.deepEqual([r.s, r.j], [401, negado], 'senha errada');
  r = await sair({ matricula: MAT.adm, senha: SENHA.adm, codigo: totp.codeAt(segredo, totp.stepAt() - 5) });
  assert.deepEqual([r.s, r.j], [401, negado], 'código do autenticador errado');
  r = await sair({ matricula: MAT.adm, senha: SENHA.adm });
  assert.deepEqual([r.s, r.j], [401, negado], 'sem código');
  assert.equal((await t.req('GET', '/api/terminal/eu')).s, 200, 'nada disso derruba a sessão do colaborador');
  const bom = codigo();
  r = await sair({ matricula: MAT.adm, senha: SENHA.adm, codigo: bom });
  assert.deepEqual([r.s, r.j], [200, { ok: true, liberado: true }]);
  assert.equal(t.cookie, '', 'cookie do terminal apagado');
  const sessoes = (await h.q("SELECT motivo FROM emprestimo.terminal_sessao WHERE usuario_id=$1 AND motivo='saida_admin'", [U.t2.id])).rows;
  assert.equal(sessoes.length, 1, 'a sessão do colaborador foi encerrada no servidor');
  r = await tablet().req('POST', '/api/terminal/saida-admin', { matricula: MAT.adm, senha: SENHA.adm, codigo: bom });
  assert.deepEqual([r.s, r.j], [401, negado], 'o mesmo código não vale duas vezes');
  assert.ok(!r.setCookie.some(c => /biotrop_session=[^;]/.test(c)), 'nenhuma sessão do site é criada');
  const aud = (await h.q("SELECT por, detalhe FROM emprestimo.auditoria WHERE tipo='terminal_saida_admin'")).rows;
  assert.equal(aud.length, 1); assert.equal(aud[0].por, U.adm.id); assert.deepEqual(aud[0].detalhe, { perfil: 'admin' });
  const tent = (await h.q("SELECT resultado FROM emprestimo.terminal_tentativa WHERE tipo='saida_admin' ORDER BY id")).rows.map(x => x.resultado);
  assert.deepEqual(tent, ['perfil', 'sem_2fa', 'senha', '2fa', '2fa', 'ok', '2fa']);
});

test('matrícula com letra não diferencia maiúsculas no tablet: entrar e primeiro acesso acham a pessoa com "a70001" ou "A70001"', async () => {
  let r = await tablet().entrar(MAT.adm.toLowerCase(), SENHA.adm);
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.colaborador.matricula, MAT.adm, 'a matrícula volta como foi cadastrada');
  const nova = '283946'; segredos.push(nova);
  const c = await convite(U.alm, U.alm);
  r = await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.alm.toLowerCase(), codigo: c.j.codigo, senha: nova });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await tablet().entrar(MAT.alm, nova)).s, 200);
  assert.equal((await tablet().entrar(` ${MAT.alm.toLowerCase()} `, nova)).s, 200, 'espaços nas pontas também');
});

test('entrar, primeiro acesso e /eu informam o prazo padrão da retirada (o resumo do tablet mostra a data prevista de devolução)', async () => {
  const atual = (await h.q('SELECT prazo_padrao_horas p FROM emprestimo.config')).rows[0].p;
  const t = tablet();
  let r = await t.entrar(MAT.t1, SENHA.t1b);
  assert.equal(r.s, 200); assert.equal(r.j.prazoPadraoHoras, atual);
  assert.equal((await painel(U.ges, 'PUT', '/api/emprestimo/config', { prazoPadraoHoras: 72 })).s, 200);
  try {
    r = await t.req('GET', '/api/terminal/eu');
    assert.deepEqual([r.s, r.j.prazoPadraoHoras], [200, 72], 'a configuração vale na hora');
    const senha = '502719'; segredos.push(senha);
    const c = await convite(U.alm, U.t3);
    r = await tablet().req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT.t3, codigo: c.j.codigo, senha });
    assert.deepEqual([r.s, r.j.prazoPadraoHoras], [200, 72]);
    assert.deepEqual(Object.keys(r.j), ['ok', 'colaborador', 'inatividadeSegundos', 'expiraEm', 'prazoPadraoHoras']);
  } finally { await painel(U.ges, 'PUT', '/api/emprestimo/config', { prazoPadraoHoras: atual }); }
  assert.equal((await tablet().req('GET', '/api/terminal/eu')).s, 401, 'sem sessão, nada');
});

test('auditoria e respostas sem senha, código, hash ou cookie; a role da API não lê as tabelas do terminal', async () => {
  const aud = JSON.stringify((await h.q("SELECT * FROM emprestimo.auditoria WHERE tipo LIKE 'terminal_%'")).rows);
  const tent = JSON.stringify((await h.q('SELECT * FROM emprestimo.terminal_tentativa')).rows);
  const evento = JSON.stringify((await h.q('SELECT * FROM seguranca.evento')).rows);
  for (const texto of [aud, tent, evento]) {
    for (const s of segredos) assert.ok(!texto.includes(s) && !texto.includes(s.replace('-', '')), 'segredo na trilha');
    assert.ok(!/scrypt\$/.test(texto), 'hash na trilha');
  }
  const tipos = new Set((await h.q("SELECT tipo FROM emprestimo.auditoria WHERE tipo LIKE 'terminal_%'")).rows.map(x => x.tipo));
  for (const k of ['terminal_login', 'terminal_logout', 'terminal_convite', 'terminal_senha_definida', 'terminal_bloqueio', 'terminal_desbloqueio', 'terminal_bloqueio_temporario', 'terminal_saida_admin']) {
    assert.ok(tipos.has(k), k);
  }
  for (const tabela of ['terminal_credencial', 'terminal_convite', 'terminal_tentativa', 'terminal_sessao']) {
    await assert.rejects(h.transaction(U.adm, db => db.query(`SELECT * FROM emprestimo.${tabela}`)), e => e.code === '42501', `${tabela}: sem leitura direta`);
    await assert.rejects(h.transaction(U.adm, db => db.query(`DELETE FROM emprestimo.${tabela}`)), e => e.code === '42501', `${tabela}: sem DML direto`);
  }
  await assert.rejects(h.transaction(U.adm, db => db.query('SELECT emprestimo.terminal_aplicar_bloqueio($1)', [U.t1.id])), e => e.code === '42501', 'função interna sem GRANT');
  // panel: almoxarife sem permissão de ler a situação fora do painel (canal terminal não é gestão)
  const fora = await h.transaction(U.alm, async db => { await db.query("SELECT set_config('app.canal','terminal',true)"); return (await db.query('SELECT * FROM emprestimo.terminal_acessos()')).rows; });
  assert.equal(fora.length, 0);
});

test('reaplicar as migrations 40 e 41 duas vezes (como o deploy) não perde nada nem abre as tabelas', async () => {
  const conta = async () => (await h.q(`SELECT (SELECT count(*) FROM emprestimo.terminal_credencial)::int c, (SELECT count(*) FROM emprestimo.terminal_convite)::int v,
    (SELECT count(*) FROM emprestimo.terminal_tentativa)::int t, (SELECT count(*) FROM emprestimo.terminal_sessao)::int s,
    (SELECT count(*) FROM emprestimo.emprestimo_evento WHERE chave IS NOT NULL)::int k,
    (SELECT string_agg(senha_hash, ',' ORDER BY usuario_id) FROM emprestimo.terminal_credencial) h`)).rows[0];
  const antes = await conta();
  for (let i = 0; i < 2; i += 1) {
    await h.db.exec(fs.readFileSync(path.join(MIG, '40-emprestimo.sql'), 'utf8'));
    // logo depois da 40 (que dá SELECT no schema todo), a policy restritiva já segura as linhas
    assert.equal((await h.transaction(U.adm, db => db.query('SELECT * FROM emprestimo.terminal_credencial'))).rows.length, 0);
    await h.db.exec(fs.readFileSync(path.join(MIG, '41-terminal-acesso.sql'), 'utf8'));
  }
  assert.deepEqual(await conta(), antes);
  assert.equal((await tablet().entrar(MAT.t1, SENHA.t1b)).s, 200, 'login continua funcionando');
});

test('catálogo do tablet: ?modalidade=retirada filtra as retiráveis no banco, até 1000 com "cortado", sem campos da planilha', async () => {
  const t = tablet();
  assert.equal((await t.entrar(MAT.t1, SENHA.t1b)).s, 200);
  let r = await painel(U.alm, 'POST', '/api/emprestimo/ferramentas', { codigo: 'FER-T090', nome: 'Disco retirável (teste)', controle: 'quantidade', total: 3, retiravel: true, codigoCompra: 'CC-T90', patrimonio: 'PAT-T90' });
  assert.equal(r.s, 201, JSON.stringify(r.j));
  r = await t.req('GET', '/api/terminal/ferramentas?modalidade=retirada');
  assert.equal(r.s, 200);
  assert.deepEqual([r.j.rows.map(x => x.codigo), r.j.cortado], [['FER-T090'], false]);
  assert.ok(!('codigoCompra' in r.j.rows[0]) && !('patrimonio' in r.j.rows[0]), 'o tablet não recebe código de compra nem patrimônio');
  r = await t.req('GET', '/api/terminal/ferramentas');
  assert.ok(r.j.rows.some(x => x.codigo === 'FER-T001') && r.j.rows.some(x => x.codigo === 'FER-T090'), 'Empréstimo traz todas');
  // 1000 retiráveis importadas (no fim da ordem por nome) + FER-T090 = 1001: vem cheio e cortado
  const linhas = Array.from({ length: 1000 }, (_, i) => ({ codigo: `FMNT-T${String(i).padStart(4, '0')}`, nome: `Zz peça de lote (teste) ${i}`, retiravel: true }));
  r = await painel(U.alm, 'POST', '/api/emprestimo/ferramentas/importar', { linhas });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await t.req('GET', '/api/terminal/ferramentas?modalidade=retirada');
  assert.deepEqual([r.s, r.j.rows.length, r.j.cortado], [200, 1000, true]);
  assert.ok(r.j.rows.every(x => x.retiravel === true));
  assert.equal(r.j.rows[0].codigo, 'FER-T090', 'ordem por nome: a busca no banco vem antes do limite');
  r = await t.req('GET', '/api/terminal/ferramentas?modalidade=retirada&q=disco');
  assert.deepEqual([r.j.rows.map(x => x.codigo), r.j.cortado], [['FER-T090'], false]);
});
