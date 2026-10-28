'use strict';
// Perfil "terminal" (empréstimo no tablet): a API do site não lê nada para ele, nem os namespaces públicos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReadScope } = require('../src/routes/read-scope');

test('perfil terminal: leitura fechada em todos os namespaces do site', () => {
  const terminal = { id: '00000000-0000-0000-0000-000000000001', email: 't@teste.biotrop', perfilId: 'terminal' };
  for (const ns of ['sci', 'scm', 'utility_meters', 'utility_readings', 'lms_courses', 'lms_progress', 'groups', 'users']) {
    assert.match(buildReadScope(terminal, ns, 3).sql, /^ AND false/, ns);
  }
});
