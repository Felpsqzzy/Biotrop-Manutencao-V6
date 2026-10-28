'use strict';
// O Map em memória do rateLimit (soFalhas e porUsuario) não pode crescer sem teto: milhares de IPs/chaves distintas dentro da
// mesma janela. O Map é privado na closure; captura-se a instância criada por rateLimit() trocando o Map global só durante a chamada.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

const { rateLimit } = require('../src/middleware/security');
const { createSession, COOKIE } = require('../src/auth/session');

function comMapEspiao(opcoes) {
  const Real = global.Map, vistos = [];
  global.Map = class extends Real { constructor(...a) { super(...a); vistos.push(this); } };
  let guard; try { guard = rateLimit(opcoes); } finally { global.Map = Real; }
  return { guard, mapa: vistos[0] };
}
const res = () => { const r = { statusCode: 200, listeners: [], set() {}, status(c) { r.statusCode = c; return r; }, json() { return r; }, on(_e, fn) { r.listeners.push(fn); } }; return r; };
const N = 20_000, TETO = 10_000;   // teto razoável: bem abaixo de N, bem acima do uso real de uma fábrica (~50 pessoas)

test('soFalhas: N IPs distintos errando o login não deixam o Map crescer sem limite', () => {
  const { guard, mapa } = comMapEspiao({ limit: 10, windowMs: 15 * 60_000, soFalhas: true, chave: req => req.body.matricula });
  assert.ok(mapa, 'Map capturado');
  for (let i = 0; i < N; i += 1) {
    const r = res();
    guard({ ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, body: { matricula: String(700000 + (i % 50)) } }, r, () => { r.statusCode = 401; r.listeners.forEach(f => f()); });
  }
  assert.ok(mapa.size <= TETO, `Map com ${mapa.size} entradas após ${N} IPs distintos: sem teto (memória cresce até a janela expirar)`);
});

test('soFalhas: um IP só variando a matrícula (chave controlada pelo cliente) não cria entradas sem limite', () => {
  const { guard, mapa } = comMapEspiao({ limit: 10, windowMs: 15 * 60_000, soFalhas: true, chave: req => req.body.matricula });
  for (let i = 0; i < N; i += 1) {
    const r = res();
    guard({ ip: '10.0.0.1', body: { matricula: 'x' + i } }, r, () => { r.statusCode = 401; r.listeners.forEach(f => f()); });
  }
  assert.ok(mapa.size <= TETO, `Map com ${mapa.size} entradas para um único IP`);
});

test('porUsuario: N pessoas/IPs distintos não deixam o Map crescer sem limite', () => {
  const { guard, mapa } = comMapEspiao({ limit: 600, windowMs: 60_000, porUsuario: true });
  for (let i = 0; i < N; i += 1) {
    const cookies = i % 2 ? { [COOKIE]: createSession({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, sessaoVersao: 1 }).valor } : {};
    guard({ ip: `172.16.${(i >> 8) & 255}.${i & 255}`, cookies }, res(), () => {});
  }
  assert.ok(mapa.size <= TETO, `Map com ${mapa.size} entradas após ${N} chaves distintas`);
});

test('contrato que o teste de teto não pode quebrar: abaixo do teto o limite continua exato', () => {
  const { guard } = comMapEspiao({ limit: 2, windowMs: 60_000, soFalhas: true, chave: req => req.body.matricula });
  const tenta = m => { const r = res(); let ok = false; guard({ ip: '10.5.5.5', body: { matricula: m } }, r, () => { ok = true; r.statusCode = 401; r.listeners.forEach(f => f()); }); return ok; };
  assert.deepEqual([tenta('a'), tenta('a'), tenta('a')], [true, true, false]);
});
