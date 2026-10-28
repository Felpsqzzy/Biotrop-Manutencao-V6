'use strict';
// Rota do painel do empréstimo (routes/emprestimo.js), sem banco: tradução dos erros do PostgreSQL e conversão da
// entrada (texto, identificador, quantidade). Valores fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

const { _lib: E } = require('../src/routes/emprestimo');
const UUID = '00000000-0000-4000-8000-000000000001';

/** Roda um handler que lança o erro dado; devolve a resposta montada e o que foi para o tratador geral (next). */
async function comErro(erro) {
  const res = { statusCode: 200, body: null, set() { return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let proximo = null;
  await E.handle(async () => { throw erro; })({}, res, e => { proximo = e; });
  return { res, proximo };
}
const erroPg = (code, msg = 'falha do banco') => Object.assign(new Error(msg), { code });

test('impasse (40P01) e conflito de serialização (40001) com outra operação viram 409 "tente de novo", não erro interno', async () => {
  for (const code of ['40P01', '40001']) {
    const { res, proximo } = await comErro(erroPg(code, 'deadlock detected'));
    assert.equal(proximo, null, code);
    assert.deepEqual([res.statusCode, res.body], [409, { ok: false, erro: 'Outra operação mexeu nos mesmos itens ao mesmo tempo. Tente de novo.' }], code);
  }
});

test('NUL que o PostgreSQL recusa em texto (22021) ou em jsonb (22P05) vira 400; erro desconhecido segue para o tratador geral', async () => {
  for (const code of ['22021', '22P05']) {
    const { res } = await comErro(erroPg(code));
    assert.deepEqual([res.statusCode, res.body], [400, { ok: false, erro: 'Texto com caractere inválido.' }], code);
  }
  const { proximo } = await comErro(erroPg('XX000'));
  assert.ok(proximo, 'erro interno de verdade continua indo para o log');
  const { res } = await comErro(new TypeError('Cannot convert object to primitive value'));
  assert.equal(res.body, null, 'TypeError não vira resposta inventada');
});

test('texto do corpo: caracteres de controle (NUL) saem; objeto estranho ({"toString":1}) e lista viram vazio, sem TypeError', () => {
  const estranho = { toString: 1 };
  assert.equal(E.texto('a\u0000b\u0007c \t d', 40), 'a b c d');
  assert.equal(E.texto(estranho, 40), '');
  assert.equal(E.texto(['a', 'b'], 40), '');
  assert.equal(E.texto(12, 40), '12');
  assert.equal(E.texto('  longo demais  ', 5), 'longo');
});

test('identificador e itens: só texto no formato uuid; quantidade estranha vira vazia (o banco recusa), nunca TypeError', () => {
  const estranho = { toString: 1 };
  assert.equal(E.id(UUID), UUID);
  for (const v of [estranho, [UUID], 123, null, undefined, 'nao-e-uuid']) assert.throws(() => E.id(v), e => e.status === 400, JSON.stringify(v));
  assert.deepEqual(E.itensMovimento([{ itemId: UUID, quantidade: estranho, observacao: estranho }], ['observacao']), [{ itemId: UUID, quantidade: '', observacao: '' }]);
  assert.deepEqual(E.itensMovimento([{ itemId: UUID, quantidade: 2 }], []), [{ itemId: UUID, quantidade: '2' }]);
  assert.deepEqual(E.itensEmprestimo([{ ferramentaId: UUID, quantidade: true }]), [{ quantidade: '', ferramentaId: UUID }]);
  assert.throws(() => E.itensEmprestimo([{ ferramentaId: estranho, quantidade: 1 }]), e => e.status === 400);
});
