'use strict';
// Câmera (leitor de código com BarcodeDetector) liberada SÓ no Inventário offline, /ferramentas/inventario.html.
// O resto do site continua com camera=(). Vale na VM (nginx; o helmet não manda Permissions-Policy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const ler = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BLOQUEADA = 'camera=(), microphone=(), geolocation=(self)';
const LIBERADA = 'camera=(self), microphone=(), geolocation=(self)';


/* ---------------------------------------------------------------- VM (nginx) */
const nginx = ler('deploy/nginx/biotrop.conf').replace(/\r\n/g, '\n');
const site = nginx.slice(nginx.indexOf('# Site em HTTPS'));

test('nginx: câmera bloqueada no site e liberada só na location exata do inventário (repetindo HSTS)', () => {
  const pp = [...site.matchAll(/add_header Permissions-Policy "([^"]+)"/g)].map(m => m[1]);
  assert.equal(pp.length, 2);
  assert.match(pp[0], /^camera=\(\), /); assert.match(pp[1], /^camera=\(self\), /);
  assert.equal(pp[1], pp[0].replace('camera=()', 'camera=(self)'), 'só a câmera muda');
  const loc = /location = \/ferramentas\/inventario\.html \{([\s\S]*?)\n {2}\}/.exec(site);
  assert.ok(loc, 'location exata do inventário');
  assert.ok(loc[1].includes('camera=(self)'));
  assert.match(loc[1], /add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;/, 'add_header na location apaga os de cima');
  assert.match(loc[1], /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.equal((nginx.match(/camera=\(self\)/g) || []).length, 1, 'nenhum outro lugar libera a câmera');
});

test('app (helmet) não manda Permissions-Policy: a política da VM é só a do nginx', () => {
  assert.doesNotMatch(ler('server/src/app.js'), /Permissions-Policy|permissionsPolicy/i);
});
