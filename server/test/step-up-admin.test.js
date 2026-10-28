'use strict';
// Step-up das ações administrativas (routes/twofa.js → requireStepUpAdmin), sem banco: o estado do 2FA vem de um
// pool falso. E o contrato: quais rotas usam o portão e quais ficam de fora (rotina).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

let ativo = true;
require.cache[require.resolve('../src/db/pool')] = { loaded: true, exports: {
  transaction: async (_u, fn) => fn({ query: async () => ({ rows: [{ s: { ativo } }] }) }), pool: {} } };
const config = require('../src/config');
const totp = require('../src/auth/totp');
const { requireStepUpAdmin, requireStepUp } = require('../src/routes/twofa');

const user = { id: '11111111-1111-4111-8111-111111111111', perfilId: 'admin' };
function chamar(mw, { method = 'POST', perfil = 'admin', cookie } = {}) {
  return new Promise(resolve => {
    const req = { method, user: { ...user, perfilId: perfil }, sessao: { sid: 'sid-1' }, cookies: cookie ? { biotrop_2fa: cookie } : {} };
    const res = { status(s) { this.s = s; return this; }, json(j) { resolve({ s: this.s, j }); } };
    mw(req, res, e => resolve(e ? { erro: e } : { next: true }));
  });
}
const valido = (agora = Date.now()) => totp.signStepUp(`${user.id}:sid-1`, config.twofaKey, 10, agora);
const ADMIN = new Set(['admin', 'gestor']);

test('ação administrativa: sem confirmação recusa; com confirmação da mesma sessão passa', async () => {
  ativo = true;
  const mw = requireStepUpAdmin(ADMIN);
  const r = await chamar(mw);
  assert.equal(r.s, 403); assert.equal(r.j.precisa2fa, true); assert.equal(r.j.configurar2fa, undefined);
  assert.deepEqual(await chamar(mw, { cookie: valido() }), { next: true });
  assert.equal((await chamar(mw, { cookie: totp.signStepUp(`${user.id}:outra`, config.twofaKey, 10) })).s, 403, 'outra sessão');
});

test('a janela de 10 minutos expira', async () => {
  ativo = true;
  const mw = requireStepUpAdmin(ADMIN);
  assert.deepEqual(await chamar(mw, { cookie: valido(Date.now() - 9 * 60000) }), { next: true }, '9 min: vale');
  assert.equal((await chamar(mw, { cookie: valido(Date.now() - 11 * 60000) })).s, 403, '11 min: vencido');
});

test('sem 2FA ativo: a ação administrativa pede para ativar; a sensível da conta (requireStepUp) segue como antes', async () => {
  ativo = false;
  const r = await chamar(requireStepUpAdmin(ADMIN));
  assert.equal(r.s, 403); assert.equal(r.j.configurar2fa, true); assert.equal(r.j.precisa2fa, true);
  assert.deepEqual(await chamar(requireStepUp), { next: true }, 'trocar o próprio contato sem 2FA continua livre');
  ativo = true;
});

test('leitura e perfil fora da regra da rota passam direto (a rota responde o 403 dela)', async () => {
  ativo = true;
  const mw = requireStepUpAdmin(ADMIN);
  assert.deepEqual(await chamar(mw, { method: 'GET' }), { next: true });
  assert.deepEqual(await chamar(mw, { perfil: 'tecnico' }), { next: true });
});

test('contrato: rotas administrativas usam o portão; rotina não', () => {
  const ler = f => fs.readFileSync(path.resolve(__dirname, '../src/routes', f), 'utf8');
  const sim = ler('simulacao.js');
  assert.match(sim, /router\.post\('\/iniciar', stepUp,/);
  assert.match(sim, /router\.post\('\/limpar', stepUp,/);
  assert.match(sim, /router\.post\('\/parar', \(req/, 'parar é o freio de emergência');
  const md = ler('master-data.js');
  assert.match(md, /router\.post\('\/', requireStepUpAdmin\(EDITORS\), saveRow\)/);
  assert.match(md, /router\.delete\('\/', requireStepUpAdmin\(EDITORS\), deactivateRow\)/);
  assert.match(ler('almox-materiais.js'), /router\.use\(requireAuth\);\n[^\n]*\nrouter\.use\(requireStepUpAdmin\(ESCRITA\)\);/);
  const pv = ler('pcm-preventivas.js');
  assert.match(pv, /router\.post\('\/equipamentos', requireStepUpAdmin\(GESTAO\)/);
  assert.match(pv, /router\.post\('\/importar', stepUpSalvoPrevia,/);
  assert.match(pv, /function stepUpSalvoPrevia\(req, res, next\) \{ return req\.body\?\.simular === true \? next\(\) : stepUpImportar\(req, res, next\); \}/, 'prévia não grava: sem código');
  assert.match(pv, /router\.put\('\/preventivas\/:id\/itens', handle\(/, 'preencher a folha é rotina');
  const bt = ler('pcm-bateladas.js');
  assert.match(bt, /const stepUpGestao = requireStepUpAdmin\(GESTAO\);/);
  for (const r of ["post('/importar'", "post('/preventivas'", "delete('/preventivas/:id'", "delete('/eba/:id'"]) {
    assert.ok(bt.includes(`router.${r}, stepUpGestao, async`), `bateladas ${r}: cadastro/exclusão com portão`);
  }
  assert.match(bt, /router\.put\('\/apontamento', async/, 'apontar batelada é rotina');
  for (const r of ['programacao/:ativoId', 'tarefas', 'eba']) assert.ok(bt.includes(`router.put('/${r}', async`), `PUT /${r}: planejamento do dia a dia, sem portão`);
  const inv = ler('inventario.js');
  assert.match(inv, /router\.post\('\/campanhas\/:id\/fechar', requireStepUpAdmin\(APPROVERS\)/);
  assert.match(inv, /router\.post\('\/itens\/:id\/justificativas', requireStepUpAdmin\(MANAGERS\)/);
  assert.match(inv, /router\.post\('\/itens\/:id\/contagens', handle\(/, 'contar é rotina');
  const emp = ler('emprestimo.js');
  assert.match(emp, /router\.post\('\/colaboradores', stepUpGestao,/);
  assert.match(emp, /router\.post\('\/colaboradores\/:usuarioId\/convite', stepUpGestao,/);
  assert.match(emp, /router\.post\('\/colaboradores\/:usuarioId\/acesso', stepUpParaLiberar,/);
  assert.match(emp, /router\.post\('\/ferramentas', stepUpGestao,/);
  assert.match(emp, /router\.put\('\/ferramentas\/:id', stepUpGestao,/);
  assert.match(emp, /router\.post\('\/ferramentas\/:id\/ajustes', stepUpGestao,/);
  assert.match(emp, /router\.put\('\/config', stepUpGestao,/);
  assert.ok(emp.indexOf('const stepUpGestao') < emp.indexOf("router.post('/ferramentas'"), 'definido antes do uso (const)');
  assert.match(ler('emprestimo-avisos.js'), /router\.put\('\/config', requireStepUpAdmin\(GERENCIA\),/);
  assert.match(emp, /router\.post\('\/emprestimos', handle\(/, 'emprestar é rotina');
  assert.doesNotMatch(ler('terminal.js'), /requireStepUpAdmin/, 'terminal fora');
});
