'use strict';
// "Sair" encerra a sessão no servidor (migration 26): uma cópia do cookie feita antes do logout não vale mais.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h;
test.before(async () => { h = await subirApp({ tec: 'tecnico', outro: 'tecnico' }); });
test.after(() => h?.fechar());

function cookieDe(u, sid) {
  const { createSession } = require('../src/auth/session');
  return `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv, sid }).valor}`;
}
const pedir = (cookie, method, url) => fetch(h.raiz + url, { method, headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' } });

test('depois de Sair, o mesmo cookie é recusado; outras sessões da pessoa continuam', async () => {
  const roubado = cookieDe(h.users.tec, 'sessao-do-notebook'), celular = cookieDe(h.users.tec, 'sessao-do-celular');
  assert.equal((await pedir(roubado, 'GET', '/auth/me')).status, 200);
  const r = await pedir(roubado, 'POST', '/auth/logout');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).encerradaNoServidor, true);
  assert.equal((await pedir(roubado, 'GET', '/auth/me')).status, 401, 'cópia do cookie não vale depois do logout');
  assert.equal((await pedir(roubado, 'GET', '/api/data?namespace=sci')).status, 401);
  assert.equal((await pedir(celular, 'GET', '/auth/me')).status, 200, 'sair num aparelho não derruba o outro');
  const guardado = (await h.q('SELECT sid_hash FROM seguranca.sessao_encerrada')).rows;
  assert.equal(guardado.length, 1);
  assert.match(guardado[0].sid_hash, /^[0-9a-f]{64}$/, 'só o hash do sid fica guardado, nunca o cookie');
});

test('tempo real: no máximo 4 conexões abertas por pessoa', async () => {
  const c = cookieDe(h.users.outro, 'abas');
  const ctrl = [];
  for (let i = 0; i < 4; i++) {
    const a = new AbortController(); ctrl.push(a);
    const r = await fetch(h.raiz + '/api/realtime?namespaces=sci', { headers: { cookie: c, origin: 'http://localhost:3000' }, signal: a.signal });
    assert.equal(r.status, 200);
  }
  const quinta = await fetch(h.raiz + '/api/realtime?namespaces=sci', { headers: { cookie: c, origin: 'http://localhost:3000' } });
  assert.equal(quinta.status, 429);
  ctrl.forEach(a => a.abort());
  await new Promise(r => setTimeout(r, 200));
  const a = new AbortController();
  const depois = await fetch(h.raiz + '/api/realtime?namespaces=sci', { headers: { cookie: c, origin: 'http://localhost:3000' }, signal: a.signal });
  assert.equal(depois.status, 200, 'fechou as abas, libera de novo');
  a.abort();
});
