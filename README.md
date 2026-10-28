# BIOMANUT V6 · Biotrop Manutenção

Plataforma de manutenção da Biotrop. A V6 reaproveita o servidor, o banco, a autenticação (Microsoft Entra ID), o 2FA e
os testes da V5 e refaz o front em React (Vite + TypeScript), com visual Liquid Glass. Todas as funcionalidades da V5
voltam em fases; o Copiloto vira o "Manutinho" (regras e relatórios, sem IA).

## Estrutura

```
apps/web/          front (Vite + React 18 + TS), páginas index.html e terminal.html
packages/shared/   regras compartilhadas (perfis e telas por perfil, tipos dos contratos), CJS + ESM
server/            API Express + PostgreSQL com RLS (serve apps/web/dist)
database/          migrations (reaplicadas a cada deploy: todas idempotentes)
deploy/ scripts/   VM (nginx, systemd, backup, restore, deploy)
docs/              guias de operação, implantação e regras por perfil
```

## Comandos (Node 22)

```bash
npm ci                     # front e pacote compartilhado
npm run install:server     # dependências do servidor (lockfile próprio)
npm run dev                # front em modo dev (proxy de /api e /auth para o servidor na porta 3000)
npm run build              # apps/web/dist (o servidor serve esta pasta)
npm run build:demo         # mesmo dist, com dados fictícios e sem servidor
npm test                   # testes dos workspaces + unitários do servidor
npm run test:integracao    # servidor com PostgreSQL em memória (PGlite), todas as migrations
npm run lint
```

Configuração do servidor: `.env.example` (nunca grave o `.env` no repositório). Implantação: `docs/DEPLOY-TI.md`.
Regras de trabalho e de desempenho do visual: `CLAUDE.md` e `apps/web/src/ui/README.md`.
