'use strict';
// Senha do terminal (lib/senha-terminal.js): scrypt versionado com os parâmetros de produção, comparação, hash fictício,
// regra de senha fraca e código de convite. Senhas fictícias.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';
delete process.env.TERMINAL_SCRYPT_LOG2N;   // aqui vale o padrão de produção (2^17)

const s = require('../src/lib/senha-terminal');

test('hash scrypt versionado com os parâmetros de produção; confere só a senha certa', async () => {
  const h = await s.gerarHash('Furadeira#Azul7');
  const p = h.split('$');
  assert.deepEqual(p.slice(0, 5), ['scrypt', '1', String(2 ** 17), '8', '1']);
  assert.equal(Buffer.from(p[5], 'base64').length, 16, 'sal de 16 bytes');
  assert.equal(Buffer.from(p[6], 'base64').length, 32, 'hash de 32 bytes');
  assert.ok(!h.includes('Furadeira'));
  assert.notEqual(await s.gerarHash('Furadeira#Azul7'), h, 'sal aleatório');
  assert.equal(await s.verificar('Furadeira#Azul7', h), true);
  assert.equal(await s.verificar('furadeira#azul7', h), false);
  assert.equal(await s.verificar('', h), false);
  assert.equal(await s.verificar(null, h), false);
  assert.equal(await s.verificar('x'.repeat(200), h), false, 'senha longa demais nunca confere');
  assert.equal(s.precisaRehash(h), false);
  assert.equal(s.precisaRehash(h.replace('$131072$', '$16384$')), true, 'parâmetro antigo: regrava no próximo login');
  assert.equal(s.precisaRehash('bcrypt$xx'), true);
});

test('sem hash (matrícula inexistente, sem senha): responde não, com um scrypt completo (tempo parecido)', async () => {
  const h = await s.gerarHash('Chave.Inglesa9');
  await s.hashFicticio();
  const medir = async hash => { const t = process.hrtime.bigint(); const r = await s.verificar('Chave.Inglesa9', hash); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
  const real = await medir(h);
  const nulo = await medir(null);
  const lixo = await medir('scrypt$1$999$8$1$aa$bb');
  assert.equal(real.r, true); assert.equal(nulo.r, false); assert.equal(lixo.r, false);
  for (const x of [nulo, lixo]) assert.ok(x.ms > real.ms * 0.4 && x.ms < real.ms * 2.5, `tempo ${x.ms.toFixed(0)} ms x ${real.ms.toFixed(0)} ms`);
});

test('custo antigo ainda gravado (TERMINAL_SCRYPT_LOG2N mudou): quem tem hash antigo e quem não existe fazem o MESMO trabalho', async () => {
  // registra cada scrypt (N, r, p) sem mudar o resultado: carrega uma cópia nova da lib com o scrypt observado
  const crypto = require('node:crypto');
  const orig = crypto.scrypt, chamadas = [];
  crypto.scrypt = function (senha, sal, tam, op, cb) { chamadas.push(`${op.N}/${op.r}/${op.p}`); return orig.call(this, senha, sal, tam, op, cb); };
  const caminho = require.resolve('../src/lib/senha-terminal');
  delete require.cache[caminho];
  let L;
  try { L = require('../src/lib/senha-terminal'); } finally { crypto.scrypt = orig; delete require.cache[caminho]; }
  const sal = crypto.randomBytes(16);
  const antigo = ['scrypt', '1', 4096, 8, 1, sal.toString('base64'), crypto.scryptSync('Furadeira#Azul7', sal, 32, { N: 4096, r: 8, p: 1 }).toString('base64')].join('$');
  const emUso = ['scrypt$1$4096$8$1', `scrypt$1$${2 ** 17}$8$1`];
  const trabalho = async (senha, hash, lista) => { chamadas.length = 0; const r = await L.verificar(senha, hash, lista); return { r, feito: [...chamadas] }; };
  const certo = await trabalho('Furadeira#Azul7', antigo, emUso);
  const errado = await trabalho('Senha-Errada-1', antigo, emUso);
  const ninguem = await trabalho('Senha-Errada-1', null, emUso);
  const lixo = await trabalho({ toString: 1 }, antigo, emUso);
  assert.equal(certo.r, true, 'o hash antigo continua valendo'); assert.equal(errado.r, false); assert.equal(ninguem.r, false); assert.equal(lixo.r, false);
  const esperado = [`4096/8/1`, `${2 ** 17}/8/1`];
  for (const x of [certo, errado, ninguem, lixo]) assert.deepEqual(x.feito, esperado, 'um scrypt de cada custo em uso, na mesma ordem');
  // lista do banco ainda sem o custo do hash real (lida há pouco): o do hash entra mesmo assim
  assert.deepEqual((await trabalho('Furadeira#Azul7', antigo, [])).feito, esperado);
  // parâmetro absurdo vindo do banco é ignorado; sem custo antigo, um scrypt só (como antes)
  assert.deepEqual((await trabalho('x', null, ['scrypt$1$999$8$1', 'bcrypt$2b$10', `scrypt$1$${2 ** 17}$8$1`])).feito, [`${2 ** 17}/8/1`]);
});

test('texto recebido como objeto estranho ({"toString":1}) não derruba a regra do PIN nem o código do convite', () => {
  const estranho = { toString: 1 };
  assert.equal(s.validarSenha('480613', estranho), null, 'matrícula estranha vira vazia');
  assert.equal(s.hashCodigo(estranho), s.hashCodigo(''), 'código estranho vira vazio');
  assert.equal(s.textoDe(700001), '700001'); assert.equal(s.textoDe(['A1']), ''); assert.equal(s.textoDe(null), '');
});

test('PIN fora da regra: tamanho, matrícula, repetido e sequência; PIN razoável passa', () => {
  assert.match(s.validarSenha('12345', '700001'), /6 dígitos/);
  assert.match(s.validarSenha(undefined, '700001'), /6 dígitos/);
  assert.match(s.validarSenha('1'.repeat(129), '700001'), /6 dígitos/);
  assert.match(s.validarSenha('700001', '700001'), /matrícula/);
  assert.match(s.validarSenha('700001', 'a700001'), /matrícula/, 'só os dígitos da matrícula contam');
  assert.match(s.validarSenha('999999'), /iguais/);
  for (const seq of ['123456', '654321', '012345', '987654']) assert.match(s.validarSenha(seq), /sequência/, seq);
  for (const ok of ['480613', '592816', '121212', '890123']) assert.equal(s.validarSenha(ok, '700001'), null, ok);
});

test('convite: XXXX-XXXX sem 0/O/1/I; HMAC aceita minúsculas, espaço e sem traço; IP vira HMAC', () => {
  const vistos = new Set();
  for (let i = 0; i < 200; i += 1) {
    const c = s.gerarCodigo();
    assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    vistos.add(c);
  }
  assert.ok(vistos.size > 195, 'aleatório');
  const h = s.hashCodigo('ABCD-EF23');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(s.hashCodigo('abcd ef23'), h); assert.equal(s.hashCodigo('ABCDEF23'), h);
  assert.notEqual(s.hashCodigo('ABCD-EF24'), h);
  assert.ok(!h.includes('ABCD'));
  assert.match(s.hashIp('10.0.0.1'), /^[0-9a-f]{64}$/);
  assert.notEqual(s.hashIp('10.0.0.1'), s.hashIp('10.0.0.2'));
});
