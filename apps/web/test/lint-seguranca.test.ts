// @vitest-environment node
// O ESLint do projeto (eslint.config.mjs na raiz) recusa dangerouslySetInnerHTML, innerHTML, eval e new Function no front.
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const RAIZ = resolve(import.meta.dirname, '..', '..', '..');
const eslint = new ESLint({ cwd: RAIZ });

async function regras(codigo: string): Promise<string[]> {
  const [r] = await eslint.lintText(codigo, { filePath: resolve(RAIZ, 'apps/web/src/exemplo-lint.tsx') });
  return (r?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

describe('lint de segurança', () => {
  it('dangerouslySetInnerHTML (JSX e objeto) é erro', async () => {
    expect(await regras('export const A = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n')).toContain(
      'no-restricted-syntax',
    );
    expect(await regras('export const p = { dangerouslySetInnerHTML: { __html: "x" } };\n')).toContain(
      'no-restricted-syntax',
    );
  });

  it('eval, new Function e innerHTML são erro', async () => {
    expect(await regras('export const f = (s: string) => eval(s);\n')).toContain('no-eval');
    expect(await regras('export const f = new Function("return 1");\n')).toContain('no-new-func');
    expect(await regras('export const f = (e: HTMLElement) => { e.innerHTML = "x"; };\n')).toContain(
      'no-restricted-properties',
    );
  });

  it('código comum passa', async () => {
    expect(await regras('export const A = () => <div>ok</div>;\n')).toEqual([]);
  });
});
