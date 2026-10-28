// O pacote sai em ESM (front) e em CommonJS (servidor, com require). Roda depois do build (npm test na raiz faz o build antes).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('dist', () => {
  it('CommonJS: o servidor consegue dar require no pacote', () => {
    const cjs = require('../dist/cjs/index.js') as typeof import('../src/index.js');
    expect(cjs.PERFIS).toHaveLength(7);
    expect(cjs.acessoDaTela('admin', 'admin_fila_email')).toBe('le');
  });

  it('ESM: o mesmo conteúdo', async () => {
    const esm = (await import('../dist/esm/index.js')) as typeof import('../src/index.js');
    expect(esm.telasDoPerfil('tecnico')).toContain('util_apontar');
  });
});
