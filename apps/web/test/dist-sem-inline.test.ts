// @vitest-environment node
// Build (apps/web/dist): HTML sem <script> inline nem on*= (a CSP do servidor é script-src 'self'; script-src-attr 'none')
// e JS inicial dentro do orçamento (≤ 180 KB gzip). Roda no fim de `npm run build` e `npm run build:demo`; sem dist
// (npm test antes de qualquer build), os testes ficam marcados como pulados.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const DIST = resolve(import.meta.dirname, '..', 'dist');
const temDist = existsSync(join(DIST, 'index.html'));
const ORCAMENTO_GZIP = 180 * 1024;

const ler = (arq: string) => readFileSync(join(DIST, arq), 'utf8');
const scripts = (html: string) =>
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({ attrs: m[1] ?? '', corpo: m[2] ?? '' }));
const src = (attrs: string) => /\bsrc="([^"]+)"/.exec(attrs)?.[1];

describe.skipIf(!temDist)('dist', () => {
  for (const pagina of ['index.html', 'terminal.html']) {
    it(`${pagina}: todo <script> é arquivo (src), sem corpo; nenhum on*= e nenhum javascript:`, () => {
      const html = ler(pagina);
      const lista = scripts(html);
      expect(lista.length).toBeGreaterThan(0);
      for (const s of lista) {
        expect(src(s.attrs), `script sem src em ${pagina}: ${s.attrs}`).toBeTruthy();
        expect(s.corpo.trim(), `script com corpo em ${pagina}`).toBe('');
      }
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/javascript:/i);
    });
  }

  it('index.html: o tema sai de /theme-boot.js no <head>, antes do módulo do app', () => {
    const html = ler('index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<script src="/theme-boot.js"></script>');
    expect(existsSync(join(DIST, 'theme-boot.js'))).toBe(true);
    expect(existsSync(join(DIST, 'ferramentas', 'inventario.html'))).toBe(true);
  });

  it('JS inicial do index.html (módulo de entrada + modulepreload) ≤ 180 KB gzip', () => {
    const html = ler('index.html');
    const iniciais = new Set<string>();
    for (const s of scripts(html)) {
      const u = src(s.attrs);
      if (u && /type="module"/.test(s.attrs)) iniciais.add(u);
    }
    for (const m of html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)) if (m[1]) iniciais.add(m[1]);
    expect(iniciais.size).toBeGreaterThan(0);
    const total = [...iniciais].reduce(
      (soma, u) => soma + gzipSync(readFileSync(join(DIST, u.replace(/^\//, '')))).length,
      0,
    );
    console.log(`JS inicial: ${(total / 1024).toFixed(1)} KB gzip em ${iniciais.size} arquivo(s)`);
    expect(total).toBeLessThanOrEqual(ORCAMENTO_GZIP);
  });
});
