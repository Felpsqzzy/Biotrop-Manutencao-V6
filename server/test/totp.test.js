const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const totp = require('../src/auth/totp');

// Segredo ASCII "12345678901234567890" da RFC 6238, em base32.
const RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('matches the RFC 6238 SHA-1 vectors (6 digits)', () => {
  assert.equal(totp.codeAt(RFC, Math.floor(59 / 30)), '287082');
  assert.equal(totp.codeAt(RFC, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totp.codeAt(RFC, Math.floor(1234567890 / 30)), '005924');
  assert.equal(totp.codeAt(RFC, Math.floor(2000000000 / 30)), '279037');
});

test('accepts one step of clock drift and refuses replay', () => {
  const now = 1234567890 * 1000, step = totp.stepAt(now);
  assert.equal(totp.verify(RFC, totp.codeAt(RFC, step), { now }), step);
  assert.equal(totp.verify(RFC, totp.codeAt(RFC, step - 1), { now }), step - 1);
  assert.equal(totp.verify(RFC, totp.codeAt(RFC, step - 3), { now }), null);
  assert.equal(totp.verify(RFC, totp.codeAt(RFC, step), { now, lastStep: step }), null, 'mesmo código não vale duas vezes');
  assert.equal(totp.verify(RFC, 'abc123', { now }), null);
});

test('round-trips base32, encryption and recovery codes', () => {
  const s = totp.generateSecret();
  assert.equal(totp.base32Encode(totp.base32Decode(s)), s);
  const packed = totp.encrypt(s, 'chave');
  assert.notEqual(packed, s);
  assert.equal(totp.decrypt(packed, 'chave'), s);
  assert.equal(totp.decrypt(packed, 'outra'), null);
  const codes = totp.recoveryCodes();
  assert.equal(codes.length, 8);
  assert.match(codes[0], /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(totp.hashRecovery(codes[0].toLowerCase(), 'k'), totp.hashRecovery(codes[0], 'k'));
});

test('step-up confirmation is bound to the user and expires', () => {
  const now = Date.now(), tok = totp.signStepUp('u1', 'k', 10, now);
  assert.ok(totp.verifyStepUp(tok, 'u1', 'k', now) > now);
  assert.equal(totp.verifyStepUp(tok, 'u2', 'k', now), 0);
  assert.equal(totp.verifyStepUp(tok, 'u1', 'k', now + 11 * 60000), 0);
  assert.equal(totp.verifyStepUp(tok + 'x', 'u1', 'k', now), 0);
});

test('server guards sensitive actions', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../src/routes/twofa.js'), 'utf8');
  const account = fs.readFileSync(path.resolve(__dirname, '../src/routes/account.js'), 'utf8');
  assert.match(route, /router\.post\('\/desativar', requireStepUp/);
  assert.match(route, /router\.post\('\/codigos', requireStepUp/);
  assert.match(route, /twofa_registrar_passo\(\$1\) AS ok/);
  const migration = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/11-dois-fatores.sql'), 'utf8');
  assert.match(migration, /totp_ultimo_passo < p_passo/);
  assert.match(migration, /RETURNS boolean/);
  assert.match(account, /router\.patch\('\/perfil', stepUpForContact/);
});
