'use strict';
// CSP sem 'unsafe-inline' no script-src em todo o site (index.html e terminal.html do build do Vite não têm script
// inline), com script-src-attr 'none'. Exceção: o Inventário offline (/ferramentas/inventario.html, JS embutido na
// página), que mantém 'unsafe-inline'. Regra do helmet (VM); o nginx não manda CSP. O estático vem de um build de
// exemplo (test/fixtures/web-dist, via WEB_DIR); o dist de verdade é conferido em apps/web (dist-sem-inline.test.ts).
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
const fs = require('node:fs');
const path = require('node:path');
const app = require('../src/app');

const ROOT = path.resolve(__dirname, '../..');
const ler = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const scriptSrc = csp => (/(?:^|;)\s*script-src ([^;]*)/.exec(csp) || [])[1];
const ESTRITOS = ['/', '/index.html', '/terminal', '/terminal.html', '/login', '/theme-boot.js', '/assets/index-Fx7aB2cD.js',
  '/ferramentas/outra.html', '/ferramentas/inventario.html.bak', '/ferramentas/inventario2', '/x/ferramentas/inventario.html'];
const INVENTARIO = ['/ferramentas/inventario.html', '/ferramentas/inventario'];

function confereEstrita(csp, c) {
  assert.ok(csp, `${c}: sem CSP`);
  assert.equal(scriptSrc(csp), "'self'", `${c}: ${csp}`);
  assert.match(csp, /script-src-attr 'none'/, c);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/, `${c}: style-src segue com 'unsafe-inline'`);
}
function confereInventario(csp, c) {
  assert.ok(csp, `${c}: sem CSP`);
  assert.equal(scriptSrc(csp), "'self' 'unsafe-inline'", `${c}: ${csp}`);
}

/* ---------------------------------------------------------------- VM (helmet) */
async function servidor(fn) {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('helmet: CSP estrita em / e /index.html (e no resto); inventário com unsafe-inline', () => servidor(async base => {
  for (const c of ESTRITOS) {
    const r = await fetch(base + c, { redirect: 'manual' });
    await r.arrayBuffer();
    confereEstrita(r.headers.get('content-security-policy'), c);
  }
  const r = await fetch(base + '/ferramentas/inventario.html');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<script>/, 'a página do inventário ainda tem script inline');
  for (const c of INVENTARIO) {
    const x = await fetch(base + c, { redirect: 'manual' });
    await x.arrayBuffer();
    confereInventario(x.headers.get('content-security-policy'), c);
  }
}));

test('as duas políticas só diferem no script-src', () => servidor(async base => {
  const a = await fetch(base + '/'), b = await fetch(base + '/ferramentas/inventario.html');
  await a.arrayBuffer(); await b.arrayBuffer();
  const estrita = a.headers.get('content-security-policy'), inv = b.headers.get('content-security-policy');
  assert.equal(inv, estrita.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"));
}));

test('nginx não define CSP (a da VM é só a do helmet)', () => {
  assert.doesNotMatch(ler('deploy/nginx/biotrop.conf'), /Content-Security-Policy/i);
});
