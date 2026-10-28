const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('rate limiting and same-origin checks run before JSON parsing', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/app.js'), 'utf8');
  const rate = source.indexOf("app.use(rateLimit({ limit: 600, windowMs: 60_000, porUsuario: true");
  const origin = source.indexOf("app.use('/api', requireSameOrigin)");
  const json = source.indexOf("app.use(express.json({ limit:'2mb' }))");
  assert.ok(rate >= 0 && origin >= 0 && json >= 0);
  assert.ok(rate < json);
  assert.ok(origin < json);
});

test('session endpoints prevent caching and logout requires same origin', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/auth.js'), 'utf8');
  assert.match(source, /router\.get\('\/me',[\s\S]*Cache-Control[\s\S]*no-store/);
  assert.match(source, /router\.post\('\/logout', requireSameOrigin/);
});
