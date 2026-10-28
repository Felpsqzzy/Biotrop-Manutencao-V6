# Operação e responsabilidades

> **AVISO DE IMPLANTAÇÃO (versão de 27/10/2026):** admin, gestor, almoxarife e PCM que fazem cadastros, simulação, importações ou aprovação de inventário precisam **ativar o 2FA em Minha conta › Segurança antes de a versão subir na VM**; senão essas ações pedem a ativação na hora (autoatendimento, sem lockout; exige login Microsoft dos últimos 15 min). Quem perdeu o celular e os códigos de recuperação: um admin zera pelo banco com `app.twofa_redefinir_de` (comando em `DEPLOY-TI.md`, aviso no topo).

## TI

- VM, DNS, HTTPS, firewall e atualização do sistema operacional.
- App Registration, rotação do client secret e disponibilidade do Entra ID.
- PostgreSQL, backups externos e monitoramento.
- Segredos do `.env`.
- Terminal do almoxarifado: rede liberada para `/terminal` e `/api/terminal` no nginx (`geo $biotrop_terminal_rede`), tablet em modo quiosque com o gerenciador de senhas do navegador desligado e os motivos `emprestimo_*` em `EMAIL_MOTIVOS_ATIVOS` do worker (`DEPLOY-TI.md`, seção 9).

## Administração da plataforma

- Liberar/revogar e-mails, perfis, grupos e responsáveis diretos.
- Manter pelo PCM as listas dos formulários SCM, famílias e campos da SCI, centros de custo e medidores.
- Conferir auditoria, tentativas de login e pendências.
- 2FA: ações administrativas (cadastros, simulação, importações, configuração do empréstimo e dos avisos, justificativa e aprovação de inventário) pedem o código do autenticador a cada 10 min. Zerar o 2FA de quem perdeu o celular e os códigos é ato de admin, só pelo banco (`app.twofa_redefinir_de`, ver `DEPLOY-TI.md`).
- Almoxarifado (Ferramentas e empréstimos): cadastrar os colaboradores do terminal, gerar o convite de primeiro acesso ou de senha nova (código de uso único, 72 h, mostrado uma vez), bloquear e desbloquear o acesso, conferir as devoluções. Conta de admin ou gestor no terminal: convite só pela gerência.

## Fluxo de acesso

```text
Microsoft Entra ID
       ↓ identidade válida no tenant
core.email_autorizado
       ↓ e-mail ativo + perfil/grupo
core.usuario
       ↓ sessão assinada HttpOnly
API → SET LOCAL app.usuario_id → RLS PostgreSQL
```

Bloquear o usuário ou revogar o e-mail corta o acesso na requisição seguinte, mesmo que o cookie ainda não tenha expirado.

## Fluxo de acesso do terminal do almoxarifado (tablet)

```text
Tablet na rede do almoxarifado
       ↓ nginx: /terminal e /api/terminal só da rede liberada (de fora, 403)
Matrícula + senha própria do terminal (scrypt), sem Microsoft
       ↓ emprestimo.terminal_credencial: 5 erros = bloqueio temporário (5 min, 15 min, 1 h)
Cookie próprio do terminal (não vale no site; o do site não vale aqui)
       ↓ inatividade da configuração + validade de 30 min
API /api/terminal → canal 'terminal' → RLS: só retirar, devolver e ver os próprios empréstimos
```

Bloquear o colaborador no painel, gerar senha nova ou desligá-lo derruba a sessão do tablet na chamada seguinte.
