# src/ui · sistema visual (Liquid Glass)

Tokens em `tokens.css` (`--bm-*`, claro em `:root`, escuro em `[data-theme=dark]`), base e classes globais em
`estilos.css`, componentes exportados por `index.ts`. Verde BIOTROP é a cor de ação; roxo, azul, ciano e rosa são apoio.

## Regras de desempenho (obrigatórias)

A V5 travou por animação contínua e desfoque em excesso. Na V6:

- `backdrop-filter` (classe `bm-vidro`, `<Superficie vidro>`) só em 4 a 6 superfícies fixas: menu, topo, gaveta do
  celular, painel do Manutinho, diálogo e, no máximo, um painel por tela. Nunca em item repetido (linha, cartão de
  lista, ladrilho): esses usam `bm-painel`, sem desfoque.
- Desfoque nunca animado. Animar só `transform` e `opacity`, de 150 a 250 ms (`MOVIMENTO` em `index.ts`).
  `MotionConfig reducedMotion="user"` já está nos providers.
- Motion sempre com `LazyMotion` + `domAnimation` e o componente `m` (`import { m } from 'motion/react'`); `motion.*`
  quebra o modo estrito do `LazyMotion`.
- PROIBIDOS: `requestAnimationFrame` contínuo, `pointermove` lendo layout, inclinação 3D, esferas girando e partículas
  fora do login.
- Lista com mais de 100 linhas usa virtualização (`@tanstack/react-virtual`).
- `React.lazy` por módulo (o roteador já faz); XLSX, PDF e QR só via `import()` na hora do uso.
- Orçamento: JS inicial ≤ 180 KB gzip (conferido no teste `test/dist-sem-inline.test.ts` a cada build).

## Segurança

- Nada de `dangerouslySetInnerHTML`, `innerHTML`, `eval` ou `new Function` (o ESLint recusa).
- Nenhum `<script>` inline nos HTML: a CSP é `script-src 'self'`.
