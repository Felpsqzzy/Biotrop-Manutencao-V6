const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

const { _test } = require('../src/routes/master-data');

test('accepts only known master-data resources', () => {
  assert.deepEqual(_test.validateResource({ resource: 'lista', list: 'scm_time' }), {
    resource: 'lista', list: 'scm_time'
  });
  assert.deepEqual(_test.validateResource({ resource: 'familias' }), {
    resource: 'familias', list: null
  });
  assert.equal(_test.validateResource({ resource: 'lista', list: 'admin_users' }), null);
  assert.equal(_test.validateResource({ resource: 'arbitrary_table' }), null);
});

test('cadastros dos formulários são do almoxarifado: o PCM não edita', () => {
  for (const r of ['lista', 'camm', 'familias']) {
    assert.equal(_test.canEdit({ perfilId: 'almoxarife' }, r), true, r);
    assert.equal(_test.canEdit({ perfilId: 'gestor' }, r), true, r);
    assert.equal(_test.canEdit({ perfilId: 'admin' }, r), true, r);
    assert.equal(_test.canEdit({ perfilId: 'pcm' }, r), false, r);
    assert.equal(_test.canEdit({ perfilId: 'tecnico' }, r), false, r);
  }
});

test('normalizes database rows for the editor', () => {
  assert.deepEqual(_test.expose({ id: '1', codigo: 'A', nome: 'Área', posicao: '2', ativo: false }), {
    id: '1', codigo: 'A', nome: 'Área', posicao: 2, ativo: false, metadata: {}, campos: []
  });
});

test('bounds user-controlled text', () => {
  assert.equal(_test.clean('  abc  ', 10), 'abc');
  assert.equal(_test.clean('abcdefghijk', 5), 'abcde');
});
