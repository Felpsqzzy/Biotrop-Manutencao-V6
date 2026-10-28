'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const F = require('../src/crypto/formato');
const { provedorLocal, criarProvedor } = require('../src/crypto/kms');
const { criarChaveiro, armazemMemoria } = require('../src/crypto/chaveiro');
const { criarServicoCifra } = require('../src/crypto/cifra');

const KEK = crypto.randomBytes(32).toString('base64');
function montar({ kek = KEK, opcoes = {}, armazem = armazemMemoria(), kms } = {}) {
  const provedor = kms || provedorLocal({ kekBase64: kek, producao: false });
  const chaveiro = criarChaveiro({ armazem, kms: provedor, opcoes });
  return { armazem, chaveiro, s: criarServicoCifra({ chaveiro, inquilino: 'biotrop' }) };
}
const CTX = { recurso: 'app.sync_registro', registro: 'sci/abc', campo: 'payload._cifrado', finalidade: 'dados-operacionais', versao: '3' };
/** Troca um byte do corpo base64url (posição relativa ao binário). */
function adulterar(texto, pos) {
  const b = Buffer.from(texto.slice(4), 'base64url'); b[pos] ^= 0x01; return 'bm1.' + b.toString('base64url');
}

test('cifra e decifra texto e JSON; formato versionado com prefixo', async () => {
  const { s } = montar();
  const t = await s.cifrarTexto(CTX, 'observação sigilosa');
  assert.ok(t.startsWith('bm1.'));
  assert.equal(await s.decifrarTexto(CTX, t), 'observação sigilosa');
  const j = await s.cifrarJSON(CTX, { latitude: -25.4, foto: 'data:image/jpeg;base64,AAAA' });
  assert.deepEqual(await s.decifrarJSON(CTX, j), { latitude: -25.4, foto: 'data:image/jpeg;base64,AAAA' });
  const p = F.desempacotar(t);
  assert.equal(p.nonce.length, 12); assert.equal(p.tag.length, 16); assert.equal(p.cabecalho[0], 1); assert.equal(p.cabecalho[1], 1);
});

test('mesma entrada gera textos cifrados diferentes (nonce novo a cada cifragem)', async () => {
  const { s } = montar();
  const a = await s.cifrarTexto(CTX, 'x'), b = await s.cifrarTexto(CTX, 'x');
  assert.notEqual(a, b);
});

test('chave errada (outra KEK / outro chaveiro) não abre', async () => {
  const a = montar(), b = montar({ kek: crypto.randomBytes(32).toString('base64'), armazem: a.armazem });
  const t = await a.s.cifrarTexto(CTX, 'segredo');
  await assert.rejects(() => b.s.decifrarTexto(CTX, t), e => e.codigo === 'KEK_DESCONHECIDA' || e.codigo === 'DEK_AUTENTICACAO');
});

test('tag, ciphertext e nonce adulterados são recusados antes de devolver texto', async () => {
  const { s } = montar();
  const t = await s.cifrarTexto(CTX, 'valor original com alguns bytes');
  const bin = Buffer.from(t.slice(4), 'base64url');
  for (const pos of [bin.length - 1, bin.length - 20, 19, 25]) {   // tag, ciphertext, nonce
    await assert.rejects(() => s.decifrarTexto(CTX, adulterar(t, pos)), e => e.codigo === 'AUTENTICACAO');
  }
});

test('dado truncado, formato desconhecido, versão/algoritmo/byte reservado inválidos', async () => {
  const { s } = montar();
  const t = await s.cifrarTexto(CTX, 'abc');
  await assert.rejects(() => s.decifrarTexto(CTX, t.slice(0, 30)), e => e.codigo === 'TRUNCADO' || e.codigo === 'AUTENTICACAO');
  await assert.rejects(() => s.decifrarTexto(CTX, t.slice(0, -4)), e => e.codigo === 'AUTENTICACAO');
  await assert.rejects(() => s.decifrarTexto(CTX, 'texto em claro'), e => e.codigo === 'FORMATO_DESCONHECIDO');
  await assert.rejects(() => s.decifrarTexto(CTX, 'bm1.@@@'), e => e.codigo === 'FORMATO');
  await assert.rejects(() => s.decifrarTexto(CTX, adulterar(t, 0)), e => e.codigo === 'VERSAO_NAO_PERMITIDA');
  await assert.rejects(() => s.decifrarTexto(CTX, adulterar(t, 1)), e => e.codigo === 'ALGORITMO_NAO_PERMITIDO');
  await assert.rejects(() => s.decifrarTexto(CTX, adulterar(t, 2)), e => e.codigo === 'FORMATO');
});

test('AAD: trocar inquilino, recurso, registro, campo, finalidade ou versão impede a abertura', async () => {
  const { s, chaveiro } = montar();
  const t = await s.cifrarTexto(CTX, 'vinculado');
  for (const [k, v] of [['recurso', 'core.usuario'], ['registro', 'sci/outro'], ['campo', 'outro'], ['versao', '4']]) {
    await assert.rejects(() => s.decifrarTexto({ ...CTX, [k]: v }, t), e => e.codigo === 'AUTENTICACAO', `troca de ${k}`);
  }
  await assert.rejects(() => s.decifrarTexto({ ...CTX, finalidade: 'segredo-2fa' }, t), e => e.codigo === 'FINALIDADE_DIVERGENTE');
  const outroInquilino = criarServicoCifra({ chaveiro, inquilino: 'outra-empresa' });
  await assert.rejects(() => outroInquilino.decifrarTexto(CTX, t), e => e.codigo === 'AUTENTICACAO');
  // o id da DEK no cabeçalho também é autenticado: apontar para outra DEK falha
  await assert.rejects(() => s.decifrarTexto(CTX, adulterar(t, 10)), e => ['DEK_INEXISTENTE', 'AUTENTICACAO'].includes(e.codigo));
});

test('contexto incompleto é recusado ao cifrar', async () => {
  const { s } = montar();
  await assert.rejects(() => s.cifrarTexto({ ...CTX, registro: '' }, 'x'), e => e.codigo === 'CONTEXTO_INCOMPLETO');
});

test('nonces distintos em 20 mil cifragens concorrentes (verificação empírica, não prova)', async () => {
  const { s } = montar();
  const textos = await Promise.all(Array.from({ length: 20000 }, (_, i) => s.cifrarTexto(CTX, String(i))));
  const nonces = new Set(textos.map(t => F.desempacotar(t).nonce.toString('hex')));
  assert.equal(nonces.size, textos.length);
});

test('limite de uso por DEK respeitado sob concorrência; rotação cria nova DEK e tudo continua abrindo', async () => {
  const { s, armazem } = montar({ opcoes: { limiteUsos: 64, tamanhoBloco: 8 } });
  const textos = await Promise.all(Array.from({ length: 300 }, (_, i) => s.cifrarTexto(CTX, 'v' + i)));
  const linhas = [...armazem.linhas.values()];
  assert.ok(linhas.length >= Math.ceil(300 / 64), `DEKs criadas: ${linhas.length}`);
  for (const l of linhas) assert.ok(l.usos_reservados <= l.limite_usos, 'reserva nunca passa do limite');
  const porDek = new Map();
  for (const t of textos) { const id = F.desempacotar(t).dekId; porDek.set(id, (porDek.get(id) || 0) + 1); }
  for (const n of porDek.values()) assert.ok(n <= 64, 'nenhuma DEK cifrou além do limite');
  for (let i = 0; i < textos.length; i++) assert.equal(await s.decifrarTexto(CTX, textos[i]), 'v' + i);
});

test('DEK vencida é aposentada e substituída; revogada não decifra mais', async () => {
  const { s, armazem, chaveiro } = montar();
  const t1 = await s.cifrarTexto(CTX, 'antes');
  const d1 = F.desempacotar(t1).dekId;
  armazem.linhas.get(d1).expira_em = new Date(Date.now() - 1000);
  chaveiro.esquecer();
  const t2 = await s.cifrarTexto(CTX, 'depois');
  assert.notEqual(F.desempacotar(t2).dekId, d1);
  assert.equal(await s.decifrarTexto(CTX, t1), 'antes');        // aposentada ainda decifra
  armazem.linhas.get(d1).estado = 'revogada';
  chaveiro.esquecer();
  await assert.rejects(() => s.decifrarTexto(CTX, t1), e => e.codigo === 'DEK_INDISPONIVEL');
});

test('KMS indisponível: falha fechada, nada é cifrado nem devolvido em claro', async () => {
  const fora = { nome: 'falho', async embrulhar() { throw new F.ErroCifra('KMS_INDISPONIVEL'); }, async desembrulhar() { throw new F.ErroCifra('KMS_INDISPONIVEL'); } };
  const { s } = montar({ kms: fora });
  await assert.rejects(() => s.cifrarTexto(CTX, 'x'), e => e.codigo === 'KMS_INDISPONIVEL');
  const ok = montar();
  const t = await ok.s.cifrarTexto(CTX, 'x');
  const semKms = criarServicoCifra({ chaveiro: criarChaveiro({ armazem: ok.armazem, kms: fora }), inquilino: 'biotrop' });
  await assert.rejects(() => semKms.decifrarTexto(CTX, t), e => e.codigo === 'KMS_INDISPONIVEL');
});

test('KEK local é proibida em produção e exige 32 bytes; provedor desconhecido é recusado', () => {
  assert.throws(() => provedorLocal({ kekBase64: KEK, producao: true }), e => e.codigo === 'KMS_LOCAL_EM_PRODUCAO');
  assert.throws(() => provedorLocal({ kekBase64: Buffer.alloc(16).toString('base64'), producao: false }), e => e.codigo === 'KMS_CONFIG');
  assert.throws(() => criarProvedor({ provedor: 'nenhum' }), e => e.codigo === 'KMS_CONFIG');
  assert.throws(() => criarProvedor({ provedor: 'azure', azureKeyId: 'http://exemplo/keys/x' }), e => e.codigo === 'KMS_CONFIG');
});

test('DEK embrulhada adulterada no banco é recusada pela KEK', async () => {
  const { s, armazem, chaveiro } = montar();
  const t = await s.cifrarTexto(CTX, 'x');
  const l = armazem.linhas.get(F.desempacotar(t).dekId);
  l.dek_envelopada[20] ^= 1; chaveiro.esquecer();
  await assert.rejects(() => s.decifrarTexto(CTX, t), e => e.codigo === 'DEK_AUTENTICACAO');
});
