const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('container services receive only the secrets required by their role', () => {
  const compose = read('docker-compose.yml');
  const app = compose.split(/\n  app:/)[1].split(/\n  email-worker:/)[0];
  const worker = compose.split(/\n  email-worker:/)[1];
  assert.doesNotMatch(app, /DATABASE_ADMIN_URL|POSTGRES_PASSWORD|GRAPH_CLIENT_SECRET|DATABASE_WORKER_URL/);
  assert.doesNotMatch(worker, /DATABASE_ADMIN_URL|POSTGRES_PASSWORD|SESSION_SECRET|ENTRA_CLIENT_SECRET/);
  const config = read('server/src/config.js');
  assert.match(config, /NODE_ENV !== 'production'/);
});

test('latest migration hides draft courses and grants the reminder function to the worker', () => {
  const migration = read('database/migrations/14-security-audit-hardening.sql');
  assert.match(migration, /payload->>'status'='publicado'/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION lms\.enfileirar_cobrancas_treinamento\(timestamptz\) TO biotrop_worker/);
});
