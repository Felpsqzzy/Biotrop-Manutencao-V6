# BIOMANUT V6 — instruções para agentes

## Segundo cérebro (Obsidian)
O contexto do projeto fica no cofre Obsidian **"03 - Felipe vieira - Biotrop"**:
`C:\Projetos - Felipe Vieira\03 - Felipe vieira - Biotrop\Jarvis\Projetos\`

- Ao começar, leia `Biotrop V5 - Plataforma de Manutencao.md` (nota central, vale para a V6 até ganhar nota própria) e `Biotrop V5/Pendencias e decisoes em aberto.md`.
- Mexeu num módulo? Leia a nota dele e atualize-a no fim (regras, arquivos, testes).
- Bug real com causa confirmada → nota em `Jarvis/04_Logs_Debug/`, no modelo de RCA. Decisão que muda o rumo → ADR em `Jarvis/Projetos/ADRs/`.
- O cofre guarda contexto, não código. Confira sempre no repositório antes de alterar algo. Nunca grave segredo, token ou senha numa nota.

## Regras de trabalho (Felipe, 2026-10-21)
- **Karpathy:** pense antes de codar (diga o que está assumindo; pergunte se for ambíguo); o mínimo de código que resolve, sem nada especulativo; mudança cirúrgica (cada linha alterada liga ao pedido; não "melhore" o vizinho); meta verificável (teste que reproduz → passa).
- **EconomyX (economia de tokens):** grep antes de read; resposta curta, sem enrolação; sem relatório ou `.md` que não foi pedido (as notas do cofre acima são pedidas); sem raciocínio estendido em tarefa simples; trabalho pesado em subagente; uma conversa por tarefa.

## Subagentes: nunca faça a tarefa sozinho
Regra do Felipe (2026-10-07): o agente principal **coordena e delega**; não implementa, não testa e não valida por conta própria. Toda tarefa vai para um subagente (ferramenta `Agent`), e o principal só lê os relatórios, decide e conversa com o Felipe. Os subagentes ficam em `.claude/agents/`:

| Subagente | Quando |
|---|---|
| `implementador` | construir ou corrigir (tela, API, migration, testes da mudança) |
| `testador` | rodar e ampliar os testes, casos de borda e de permissão |
| `cacador-de-bugs` | revisão adversarial do diff (segurança, dados, regressão); só lê |
| `verificador-ui` | conferir a tela no navegador (build de demonstração), perfis, claro/escuro, celular |
| `validador-final` | portão antes do commit: testes, builds, diff, migrations, docs; dá APROVADO ou REPROVADO |

Fluxo de toda tarefa:
1. Se for grande, divida em partes independentes e dispare vários `implementador` em paralelo, cada um com os arquivos e os critérios de aceite dele (na V6, um módulo por pasta em `apps/web/src/modules/<id>/` evita conflito).
2. Depois de implementar: `testador` + `cacador-de-bugs` (+ `verificador-ui` se a mudança aparece na tela), em paralelo.
3. Achado real volta para um `implementador` corrigir; repita o passo 2 até limpar.
4. `validador-final` por último. **Só `APROVADO` libera o commit e o push.**
5. O principal faz o commit/push (regra abaixo) e relata ao Felipe como executado / falhou / pendente, com a evidência que os subagentes trouxeram.

Ao delegar: passe o pedido completo, os arquivos, as regras deste arquivo e o critério de pronto; peça relato com evidência real. Não aceite "deve funcionar": confira o que cada relatório de fato executou. Exceção: perguntas rápidas do Felipe e ajuste de uma linha pedido por ele podem ser respondidos direto.

## Regras do projeto
- **Commit e push** em `origin` (https://github.com/Felpsqzzy/Biotrop-Manutencao-V6.git) só depois do `APROVADO` do `validador-final`.
  - **Até a primeira entrega aprovada, nada vai direto para a `main`:** trabalhe num branch (`feat/...`) e envie o branch; a `main` só recebe a primeira entrega depois de aprovada pelo Felipe. Depois disso vale commit + push em `main` ao fim de cada tarefa.
  - Antes do commit: `git status`/`git diff`, adicionar só os arquivos da tarefa (nunca `.env`, segredos, `node_modules`, `dist/`, backups ou dados reais) e rodar os testes e os builds abaixo. Se algo falhar, não envia: relata.
  - Numa worktree, enviar com `git push origin HEAD:<branch>` (só fast-forward, nunca force).
- Nenhum dado real (pessoas, planilhas, contadores, itens do Dynamics) em migration, teste ou demonstração. Dado real entra pelas telas de importação. Teste e demo usam dados fictícios identificados (`[TESTE]`, `[DEMO]`, domínio `.invalid`).
- O `migrate.js` reaplica **todas** as migrations a cada deploy: toda migration precisa ser idempotente e nunca pode apagar o que outra mais nova recria.
- Regra de permissão nova = tela (`packages/shared/src/perfis.ts` e a página) + API (`server/src/routes/workflow.js` e as rotas) + policy de RLS (inclusive a de UPDATE).
- Depois de mexer em `server/src/routes/bateladas-calculo.js`: o cálculo do navegador ainda não existe na V6 (vai para `packages/shared`); quando existir, os dois precisam continuar iguais e testados.
- Front: nada de `dangerouslySetInnerHTML`, `innerHTML`, `eval` ou `new Function` (o lint recusa); nenhum `<script>` inline nos HTML (CSP `script-src 'self'`). Classe CSS própria com prefixo (`bm-` no sistema, o do módulo nos módulos); nunca nome genérico.
- Antes de entregar:

  ```bash
  npm run lint
  npm test
  npm run test:integracao
  npm run build:demo && npm run build
  ```

  Depois confira no navegador (build de demonstração) e só então faça o commit.
- Relatar o resultado como executado / falhou / pendente, com evidência.

## Liquid Glass: regras de desempenho (a causa do travamento da V5)
- `backdrop-filter` só em 4 a 6 superfícies fixas: menu, topo, gaveta do celular, painel do Manutinho, diálogo e, no máximo, um painel por tela. **Nunca em item repetido.**
- Desfoque nunca animado. Animar só `transform` e `opacity`, de 150 a 250 ms. `MotionConfig reducedMotion="user"` (já nos providers); Motion sempre com `LazyMotion` + `domAnimation` e o componente `m`.
- **PROIBIDOS:** `requestAnimationFrame` contínuo, `pointermove` lendo layout, inclinação 3D, esferas girando e partículas fora do login.
- Lista com mais de 100 linhas usa virtualização (`@tanstack/react-virtual`). `React.lazy` por módulo; XLSX, PDF e QR via `import()`.
- Orçamento: JS inicial ≤ 180 KB gzip (o teste `apps/web/test/dist-sem-inline.test.ts` confere a cada build).

Detalhes e exemplos: `apps/web/src/ui/README.md`.
