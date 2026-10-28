'use strict';
// Semáforo do scrypt (lib/senha-terminal.js): no máximo 2 ao mesmo tempo, fila de até 32 e 503 acima disso, sem
// calcular nada. O crypto.scrypt é trocado por um falso que conta quantos rodam juntos (antes de carregar a lib).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

let rodando = 0, pico = 0, chamadas = 0;
crypto.scrypt = (_senha, _sal, tam, _op, cb) => {
  rodando += 1; chamadas += 1; pico = Math.max(pico, rodando);
  setTimeout(() => { rodando -= 1; cb(null, Buffer.alloc(tam, 7)); }, 5);
};
const s = require('../src/lib/senha-terminal');

test('rajada de 40 hashes: no máximo 2 scrypts juntos, 32 na fila e o resto 503 sem calcular', async () => {
  assert.deepEqual([s.MAX_SIMULTANEOS, s.MAX_FILA], [2, 32]);
  const rs = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => s.gerarHash(`Senha-Ficticia-${i}`)));
  const ok = rs.filter(r => r.status === 'fulfilled').length;
  const recusados = rs.filter(r => r.status === 'rejected');
  assert.equal(pico, 2, 'nunca mais de 2 scrypts ao mesmo tempo');
  assert.equal(ok, 34, '2 rodando + 32 na fila');
  assert.equal(recusados.length, 6);
  assert.ok(recusados.every(r => r.reason.status === 503 && r.reason.codigo === 'SCRYPT_OCUPADO'));
  assert.equal(chamadas, 34, 'quem foi recusado não calculou nada');
  assert.equal(s.ocupado(), false, 'a fila esvazia depois da rajada');
});

test('conferência com vários custos ocupa uma vaga só e não para no meio; ocupado() avisa a rota antes de reservar no banco', async () => {
  pico = 0; chamadas = 0;
  const antigo = `scrypt$1$${2 ** 12}$8$1`;
  const rs = await Promise.allSettled(Array.from({ length: 34 }, () => s.verificar('Senha-Ficticia-1', null, [antigo])));
  assert.ok(rs.every(r => r.status === 'fulfilled' && r.value === false));
  assert.equal(pico, 2);
  assert.equal(chamadas, 68, 'cada conferência calculou os 2 custos (atual e antigo)');
  // enche a fila e confere o aviso
  const cheia = Array.from({ length: 34 }, () => s.gerarHash('Senha-Ficticia-2'));
  assert.equal(s.ocupado(), true);
  await Promise.all(cheia);
  assert.equal(s.ocupado(), false);
});

test('UV_THREADPOOL_SIZE=8 documentado no .env.example e aplicado no Dockerfile e na unit systemd da VM', () => {
  const fs = require('node:fs'), path = require('node:path'), raiz = path.resolve(__dirname, '../..');
  assert.match(fs.readFileSync(path.join(raiz, '.env.example'), 'utf8'), /^UV_THREADPOOL_SIZE=8$/m);
  assert.match(fs.readFileSync(path.join(raiz, 'Dockerfile'), 'utf8'), /^ENV UV_THREADPOOL_SIZE=8$/m);
  assert.match(fs.readFileSync(path.join(raiz, 'deploy/systemd/biotrop.service'), 'utf8'), /^Environment=UV_THREADPOOL_SIZE=8\r?$/m);
});
