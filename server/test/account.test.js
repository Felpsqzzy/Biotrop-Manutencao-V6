const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validate, cleanPrefs } = require('../src/routes/account-rules');

const migration = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/10-minha-conta.sql'), 'utf8');
const app = fs.readFileSync(path.resolve(__dirname, '../src/app.js'), 'utf8');

test('accepts only safe profile values', () => {
  const ok = validate({ telefone: '(41) 99999-0000', tema: 'escuro', notificacoes: false, preferencias: { escala: 125, contraste: true } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values[3], 'escuro');
  assert.deepEqual(JSON.parse(ok.values[5]), { escala: 125, contraste: true });

  const bad = validate({ foto: 'javascript:alert(1)', telefone: '<script>', tema: 'roxo' });
  assert.equal(bad.errors.length, 3);
  assert.equal(validate({ foto: 'data:image/png;base64,' + 'A'.repeat(400001) }).errors.length, 1);
  assert.equal(validate({ foto: null }).values[1], true, 'foto null remove a foto');
});

test('drops unknown or out-of-range preferences', () => {
  assert.deepEqual(cleanPrefs({ escala: 999, contraste: 'sim', perfil_id: 'admin', fonte_leitura: true }), { fonte_leitura: true });
  assert.equal(cleanPrefs([1, 2]), null);
});

test('self-service writes only reach the session user and never the access profile', () => {
  assert.match(migration, /WHERE u\.id = app\.usuario_atual\(\)/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.doesNotMatch(migration, /perfil_id\s*=/);
  assert.doesNotMatch(migration, /grupo_id\s*=/);
  assert.match(app, /app\.use\('\/api\/conta', require\('\.\/routes\/account'\)\)/);
});

test('telefone num formato só (+55 (DDD) 9 9999-9999) no servidor', () => {
  const S = require('../src/lib/telefone');
  const casos = {
    '41999998888': '+55 (41) 9 9999-8888', '(41) 99999-8888': '+55 (41) 9 9999-8888', '+55 41 99999-8888': '+55 (41) 9 9999-8888',
    '041 3333-4444': '+55 (41) 3333-4444', '41 3333-4444 ramal 215': '+55 (41) 3333-4444 · ramal 215', 'ramal 215': 'Ramal 215', '': ''
  };
  for (const [entrada, saida] of Object.entries(casos)) {
    assert.equal(S.normalizar(entrada).valor, saida, entrada);
  }
  for (const ruim of ['<script>', '20 99999-8888', '11 89999-8888', '419999988', '41 99999-8888 ramal 1234567']) {
    assert.equal(S.normalizar(ruim).ok, false, ruim);
  }
  assert.equal(validate({ telefone: '41 99999-0000' }).values[2], '+55 (41) 9 9999-0000', 'a conta grava o formato canônico');
});
