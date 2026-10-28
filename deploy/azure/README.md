# Banco PostgreSQL no Azure

O site usa um **Azure Database for PostgreSQL – Flexible Server** (PostgreSQL 16). O script
`criar-banco-postgresql.sh` cria tudo e devolve as linhas prontas do `.env`.

## 1. Criar o servidor (uma vez)

1. Abra <https://portal.azure.com> e clique no ícone **Cloud Shell** (`>_`), no topo. Escolha **Bash**.
2. No Cloud Shell, clique em **Gerenciar arquivos → Carregar** e envie `criar-banco-postgresql.sh`.
3. Rode:

   ```bash
   IP_DA_VM=<ip-publico-da-vm> bash criar-banco-postgresql.sh
   ```

   Se o nome `psql-biotrop-manutencao` já existir no Azure, escolha outro:
   `NOME_SERVIDOR=psql-biotrop-prod IP_DA_VM=... bash criar-banco-postgresql.sh`.

O script, em uns 10 minutos:

| O que faz | Valor padrão |
|---|---|
| Grupo de recursos | `rg-biotrop-manutencao` em `brazilsouth` |
| Servidor | PostgreSQL 16, `Standard_B1ms` (Burstable, 1 vCPU / 2 GB), 32 GB, backup de 14 dias |
| Rede | sem acesso público; libera só o IP da VM no firewall |
| Segurança | SSL obrigatório, TLS 1.2 no mínimo |
| Extensões liberadas | `pgcrypto`, `citext`, `pg_trgm`, `unaccent` (as migrations criam) |
| Banco | `biotrop` |
| Senhas | geradas na hora: admin, `biotrop_app` (site) e `biotrop_worker` (e-mails) |
| Certificado | baixa as raízes oficiais (DigiCert G2, DigiCert Global Root, Microsoft RSA 2017) |

No fim ele grava **`biotrop-banco.env`**. Baixe esse arquivo (Gerenciar arquivos → Baixar) e
apague do Cloud Shell: ele tem as senhas.

## 2. Ligar o site ao banco (na VM)

1. Cole as linhas de `biotrop-banco.env` no `.env` da VM, no lugar das linhas de banco do
   `.env.example`. No `.env.app`, cole só `DATABASE_URL`, `DATABASE_SSL` e `DATABASE_SSL_CA`.
2. Crie o schema, as roles e as permissões (seguro rodar de novo a qualquer momento):

   ```bash
   docker compose run --rm migrate
   ```

   Sem Docker: `npm --prefix server ci && npm run db:migrate`.
3. Confira: `npm run db:check` deve responder `"ok": true`.
4. Suba: `docker compose up -d app worker` e acesse o site.

O primeiro login liberado é `felipe.vieira@biotrop.com.br` (admin, na migration 01). Os demais
e-mails são liberados pela tela de Administração ou pelo SQL de `docs/DEPLOY-TI.md`.

## 3. Como o banco fica organizado

As migrations (`database/migrations`, aplicadas em ordem) criam três roles de conexão, todas sem
superusuário e sem `BYPASSRLS`, para que o RLS valha sempre:

- `biotrop_app` — usada pelo site (`DATABASE_URL`);
- `biotrop_worker` — só a fila de e-mails (`DATABASE_WORKER_URL`);
- `biotrop_ro` — leitura para relatórios, se a TI precisar.

O usuário admin do Azure (`biotropadmin`) só é usado pelas migrations (`DATABASE_ADMIN_URL`).
Nunca coloque ele no `DATABASE_URL` do site.

## 4. Custos e manutenção

- `Standard_B1ms` é o menor tamanho. Se o site ficar lento com muita gente, suba em
  Portal → servidor → **Computação + armazenamento** (sem perder dados).
- Os backups automáticos ficam 14 dias; o restauro é feito no Portal → **Restaurar**.
  O `scripts/backup.sh` continua valendo como cópia extra.
- Para liberar outro IP (ex.: sua máquina, para consultar pelo pgAdmin):
  `az postgres flexible-server firewall-rule create -g rg-biotrop-manutencao -n <servidor> --rule-name meu-pc --start-ip-address <ip> --end-ip-address <ip>`.
