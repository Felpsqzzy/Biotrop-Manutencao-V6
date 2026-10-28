const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataRoute = fs.readFileSync(path.resolve(__dirname, '../src/routes/data.js'), 'utf8');
const realtime = fs.readFileSync(path.resolve(__dirname, '../src/routes/realtime.js'), 'utf8');
const readScope = fs.readFileSync(path.resolve(__dirname, '../src/routes/read-scope.js'), 'utf8');
const app = fs.readFileSync(path.resolve(__dirname, '../src/app.js'), 'utf8');
const migration = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/09-lms-academy-sync.sql'), 'utf8');

test('syncs courses and progress through the data API', () => {
  for (const source of [dataRoute, realtime]) {
    assert.match(source, /'lms_courses'/);
    assert.match(source, /'lms_progress'/);
  }
  assert.match(dataRoute, /lms_courses:new Set\(\['admin','gestor'\]\)/);
  assert.match(dataRoute, /buildReadScope\(req\.user, ns, 2\)/);
  assert.match(realtime, /buildReadScope\(user, ns, n \+ 1\)/);
  assert.match(readScope, /new Set\(\['sci', 'scm', 'utility_readings', 'lms_progress'\]\)/);
});

test('protects LMS records with row level security', () => {
  assert.match(migration, /namespace='lms_courses' AND app\.tem_perfil\(ARRAY\['admin','gestor'\]\)/);
  assert.match(migration, /payload->>'usuarioId' = app\.usuario_atual\(\)::text/);
  // As regras anteriores continuam presentes na policy recriada.
  assert.match(migration, /namespace='utility_readings'/);
  assert.match(migration, /namespace='scm'/);
});

test('allows lesson media that the player embeds', () => {
  assert.match(app, /frameSrc: \[[^\]]*https:\/\/www\.youtube-nocookie\.com/);
  assert.match(app, /imgSrc: \[[^\]]*https:\/\/i\.ytimg\.com/);
  assert.match(app, /referrerPolicy: \{ policy: 'strict-origin-when-cross-origin' \}/);
});
