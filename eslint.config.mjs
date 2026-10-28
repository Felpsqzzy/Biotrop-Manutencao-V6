// ESLint (flat config) do front e do pacote compartilhado. O servidor (CommonJS) tem os testes dele e fica fora daqui.
// Regras de segurança fixas: nada de dangerouslySetInnerHTML, eval ou new Function (a CSP já recusa os dois últimos;
// o lint pega antes de chegar ao navegador).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const PROIBIDO_HTML = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message: 'dangerouslySetInnerHTML é proibido: monte o conteúdo com elementos React.',
};
const PROIBIDO_HTML_OBJ = {
  selector: "Property[key.name='dangerouslySetInnerHTML']",
  message: 'dangerouslySetInnerHTML é proibido: monte o conteúdo com elementos React.',
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'server/**', 'database/**', 'apps/web/public/**', 'coverage/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', PROIBIDO_HTML, PROIBIDO_HTML_OBJ],
      'no-restricted-properties': ['error', { property: 'innerHTML', message: 'innerHTML é proibido: use elementos React.' }],
    },
  },
  {
    files: ['*.{js,mjs,ts}', 'apps/web/*.ts', 'apps/web/test/**/*.ts', 'packages/shared/scripts/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
