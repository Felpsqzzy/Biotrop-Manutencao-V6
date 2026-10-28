'use strict';
// App real, sem banco: o estático (scripts e estilos de cada página) sai antes do limite de requisições e não o consome.
// Build do Vite (apps/web/dist): assets/ com hash no nome = 1 ano, imutável; HTML e JS/CSS sem hash = no-cache + ETag
// (revalidação barata; depois de um deploy, o index novo não roda com o JS antigo). Build de exemplo em test/fixtures.
process.env.NODE_ENV = 'test';
process.env.APP_BASE_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgres://ninguem:x@127.0.0.1:1/nada';
process.env.SESSION_SECRET = 'teste-'.padEnd(48, 'x');
process.env.ENTRA_TENANT_ID = '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET = 'segredo-de-teste';
process.env.WEB_DIR = require('node:path').join(__dirname, 'fixtures', 'web-dist');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

const IMUTAVEL = 'public, max-age=31536000, immutable';

async function servidor(fn) {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}
// node:http, não fetch: o fetch acrescenta "Cache-Control: no-cache" ao pedido condicional e o servidor nunca dá 304
const condicional = (url, etag) => new Promise((ok, falha) => require('node:http').get(url, { headers: { 'if-none-match': etag, 'accept-encoding': 'gzip' } }, res => { res.resume(); ok(res.statusCode); }).on('error', falha));

test('estático antes do limite: 700 arquivos do mesmo IP passam e não gastam o limite geral (600/min)', () => servidor(async base => {
  for (let i = 0; i < 700; i += 1) {
    const r = await fetch(`${base}/assets/index-Fx7aB2cD.js`);
    assert.equal(r.status, 200, `pedido ${i + 1}`);
    assert.equal(r.headers.get('ratelimit-limit'), null, 'o estático não passa pelo limitador');
    await r.arrayBuffer();
  }
  const r = await fetch(`${base}/auth/me`);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('ratelimit-limit'), '600');
  assert.equal(r.headers.get('ratelimit-remaining'), '599', 'só a chamada de API contou');
}));

test('assets com hash do Vite: cache de 1 ano, imutável', () => servidor(async base => {
  for (const arq of ['/assets/index-Fx7aB2cD.js', '/assets/index-Fx7aB2cD.css', '/assets/terminal-Qw3eR4tY.js']) {
    const r = await fetch(base + arq);
    assert.equal(r.status, 200, arq);
    assert.equal(r.headers.get('cache-control'), IMUTAVEL, arq);
    await r.arrayBuffer();
  }
}));

test('JS sem hash: Cache-Control no-cache com ETag, e 304 na revalidação', () => servidor(async base => {
  const arq = '/theme-boot.js';
  const r = await fetch(base + arq);
  assert.equal(r.status, 200, arq);
  assert.equal(r.headers.get('cache-control'), 'no-cache', arq);
  const etag = r.headers.get('etag');
  assert.ok(etag, `${arq} sem ETag`);
  await r.arrayBuffer();
  assert.equal(await condicional(base + arq, etag), 304, arq);
}));

test('HTML: no-cache em /, /index.html, rota do app e /terminal (que aponta para dist/terminal.html)', () => servidor(async base => {
  for (const c of ['/', '/index.html', '/utilidades/apontar']) {
    const r = await fetch(base + c);
    assert.equal(r.status, 200, c);
    assert.equal(r.headers.get('cache-control'), 'no-cache', c);
    assert.match(await r.text(), /index-Fx7aB2cD\.js/, `${c} entrega o index.html do build`);
  }
  const pagina = await fetch(`${base}/terminal`);
  assert.equal(pagina.status, 200);
  assert.equal(pagina.headers.get('cache-control'), 'no-cache');
  assert.match(await pagina.text(), /terminal-Qw3eR4tY\.js/, '/terminal entrega o terminal.html, não o site');
}));
