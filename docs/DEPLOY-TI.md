# Implantação BIOTROP na VM Azure

> **AVISO DE IMPLANTAÇÃO (versão de 27/10/2026, 2FA nas ações administrativas)**
>
> **Antes de subir esta versão na VM**, quem é **admin, gestor, almoxarife ou PCM** e faz cadastros (master-data, catálogo do almoxarifado, equipamentos de preventiva, ferramentas e colaboradores do terminal, configuração do empréstimo e dos avisos), **modo de teste (simulação)**, **importações** (catálogo, preventivas, bateladas) ou **justificativa e aprovação de inventário** precisa **ativar o 2FA** em **Minha conta › Segurança**. Lista completa das rotas: `CHANGELOG.md`, entrada de 27/10/2026.
>
> - Quem não ativar antes **não fica trancado**: na primeira dessas ações a tela abre o assistente de ativação na hora (autoatendimento). Ativar exige um **login Microsoft dos últimos 15 min**; se passou disso, o assistente pede para sair e entrar de novo, e o formulário aberto é perdido. Por isso, ative antes, com calma.
> - Depois de ativo, cada uma dessas ações pede o código do autenticador **uma vez a cada 10 min**. Leituras e a rotina (SCI/SCM, contagem, empréstimo, terminal, apontamento de batelada) não mudam.
> - **Perdeu o celular e os códigos de recuperação:** um **admin** zera o 2FA da pessoa pelo banco com `app.twofa_redefinir_de` (migration `11-dois-fatores.sql`). A função só roda com a identidade de um admin ativo na transação (senão: "Somente administração."). Ela apaga segredo, pendente e códigos e desliga o 2FA; a pessoa ativa de novo em Minha conta › Segurança.
>
>   ```bash
>   docker compose exec postgres psql -U postgres -d biotrop
>   ```
>
>   ```sql
>   -- confira a pessoa antes (troque os e-mails pelos reais)
>   SELECT id, nome, perfil_id, totp_ativo FROM core.usuario WHERE email = 'pessoa@biotrop.com.br';
>
>   BEGIN;
>   -- identidade do admin que executa (precisa ser admin ativo e não bloqueado)
>   SELECT set_config('app.usuario_id', (SELECT id::text FROM core.usuario WHERE email = 'admin@biotrop.com.br'), true);
>   SELECT app.twofa_redefinir_de((SELECT id FROM core.usuario WHERE email = 'pessoa@biotrop.com.br'));
>   COMMIT;
>
>   -- deve voltar totp_ativo = false
>   SELECT nome, totp_ativo FROM core.usuario WHERE email = 'pessoa@biotrop.com.br';
>   ```
>
>   E-mail errado não dá erro (a função não acha ninguém e não muda nada): por isso a conferência antes e depois. Confirme a identidade da pessoa por outro canal antes de zerar.

## 1. Pré-requisitos

- Ubuntu Server 24.04 LTS ou distribuição homologada pela TI.
- DNS definido, por exemplo `manutencao.biotrop.com.br`.
- Porta 443 publicada; SSH e PostgreSQL restritos à rede interna/VPN.
- Docker Engine + Compose Plugin, ou Node.js 20 + PostgreSQL 16.
- App Registration no tenant Microsoft da BIOTROP.

## 2. Microsoft Entra ID

Crie uma App Registration de tenant único:

- Tipo: Web.
- Redirect URI: `https://manutencao.biotrop.com.br/auth/microsoft/callback`.
- Front-channel logout: `https://manutencao.biotrop.com.br/`.
- Permissões delegadas: `openid`, `profile`, `email`.
- Não habilitar fluxo implícito.
- Gerar um client secret com validade controlada pela TI.

Para notificações, conceda `Mail.Send` como **Application permission**, dê consentimento administrativo e limite o aplicativo à caixa `manutencao@biotrop.com.br` com uma Application Access Policy do Exchange Online. Sem essa política, um segredo vazado poderia enviar como qualquer caixa do tenant.

Preencha `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` e `ENTRA_CLIENT_SECRET` no `.env`. O secret nunca deve ser enviado por e-mail, salvo no GitHub ou colocado no JavaScript.

## 3. Usuários autorizados

Autenticar na Microsoft não concede acesso automaticamente. Libere o e-mail:

```sql
INSERT INTO core.email_autorizado (email, ativo, perfil_padrao, motivo)
VALUES ('usuario@biotrop.com.br', true, 'tecnico', 'liberado pela TI')
ON CONFLICT (email) DO UPDATE
SET ativo=true, perfil_padrao=excluded.perfil_padrao, revogado_em=null;
```

Perfis disponíveis: `admin`, `gestor`, `pcm`, `almoxarife`, `lider`, `tecnico`, `viewer`. O perfil `terminal` (quem só usa o tablet do almoxarifado) não entra por aqui: o colaborador é cadastrado no painel do empréstimo (seção 9).

## 4. Instalação com Docker Compose

```bash
sudo install -d -o biotrop -g biotrop -m 750 /opt/biotrop
sudo -u biotrop git clone <URL_DO_REPOSITORIO> /opt/biotrop
cd /opt/biotrop
cp .env.example .env
chmod 600 .env
```

Edite `.env`. Gere chaves diferentes para `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` e `SESSION_SECRET`.

O Docker Compose repassa somente as variáveis necessárias a cada serviço. Se a TI optar por systemd, copie `.env.app.example` para `/opt/biotrop/.env.app` e preencha os valores; não inclua `DATABASE_ADMIN_URL`, `POSTGRES_PASSWORD`, `DATABASE_WORKER_URL`, `WORKER_DB_PASSWORD` nem segredos `GRAPH_*`.

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d app
docker compose ps
curl -fsS http://127.0.0.1:3000/health
```

## 5. Nginx e HTTPS

```bash
sudo cp deploy/nginx/biotrop.conf /etc/nginx/sites-available/biotrop
sudo ln -s /etc/nginx/sites-available/biotrop /etc/nginx/sites-enabled/biotrop
sudo nginx -t
sudo systemctl reload nginx
```

Use o método de certificado homologado pela TI. Só depois do HTTPS ajuste `COOKIE_SECURE=true` e valide o callback Microsoft.

## 6. Backup diário

Exemplo de cron, executado por conta de serviço:

```cron
15 2 * * * cd /opt/biotrop && BACKUP_AGE_RECIPIENT=age1SUA_CHAVE_PUBLICA DATABASE_ADMIN_URL=... ./scripts/backup.sh >> /var/log/biotrop-backup.log 2>&1
```

- Reter ao menos 30 cópias diárias.
- Backups saem **cifrados** (`.dump.age`) direto do `pg_dump`: na VM fica só a chave **pública** (`BACKUP_AGE_RECIPIENT`). A chave privada (gerada com `age-keygen` fora da VM) fica com a TI, num cofre; sem ela ninguém abre o backup — guarde duas cópias, sem ela o backup também não volta.
- Copiar os backups para armazenamento fora da VM (`BACKUP_RCLONE_DESTINO`, de preferência com imutabilidade/retenção).
- Restaurar: `BACKUP_AGE_IDENTITY=/caminho/chave.key ./scripts/restore.sh backups/biotrop-AAAA.dump.age` (confere o `.sha256` antes).
- Testar restauração trimestralmente em banco isolado.

## 7. Validação de aceite

1. `/health` retorna `ok: true`, `schema_ok: true` e `realtime_ok: true`.
2. E-mail fora de `core.email_autorizado` autentica na Microsoft, mas recebe acesso negado.
3. E-mail autorizado entra e recebe o perfil correto.
4. Usuário bloqueado perde acesso na próxima requisição.
5. Técnico vê apenas seus fluxos; líder vê seu grupo; PCM e almoxarife veem apenas as filas autorizadas.
6. SCI e SCM mantêm versão e retornam HTTP 409 em edição concorrente.
7. Alteração feita por um usuário aparece para outro sem atualizar a página.
8. Backup é criado e uma restauração de teste termina sem erro.
9. Terminal do almoxarifado: de fora da rede liberada, `/terminal` e `/api/terminal/...` respondem 403; do tablet, a tela de entrada abre (seção 9).
10. Colaborador do terminal entra com matrícula e senha e não abre nenhuma tela do site; 5 senhas erradas seguidas bloqueiam a matrícula por 5 min.
11. Nenhum aviso do empréstimo cancelado por motivo desligado: `SELECT count(*) FROM core.email_fila WHERE motivo LIKE 'emprestimo_%' AND erro = 'Motivo não habilitado para envio';` dá 0 (seção 9).

## 8. Rollback

Código: volte para a tag anterior e reconstrua o contêiner. Dados: restaure em uma instância isolada primeiro, valide e só então faça a troca planejada. Nunca execute `pg_restore --clean` diretamente em produção sem janela aprovada e backup validado.

## 9. Terminal do almoxarifado (tablet) e empréstimo de ferramentas

O tablet na porta do almoxarifado abre `https://manutencao.biotrop.com.br/terminal` (API em `/api/terminal/*`). O colaborador entra com **matrícula e senha própria do terminal**, sem login Microsoft e sem 2FA; essa entrada não abre nenhuma tela do site. O almoxarifado cadastra os colaboradores e gera o convite de primeiro acesso no painel (Almoxarifado › Ferramentas e empréstimos › Colaboradores do terminal). Detalhes do módulo: `docs/FERRAMENTAS-E-EMPRESTIMOS-PLANO.md`.

**Banco.** Migrations `40-emprestimo`, `41-terminal-acesso`, `42-emprestimo-avisos` e `43-ferramenta-foto`, aplicadas pelo `npm run db:migrate` (ou `docker compose run --rm migrate`) como as demais. Nada a fazer à mão.

**Variáveis.** `TERMINAL_SCRYPT_LOG2N` no `.env` do site (`.env.app` no systemd): custo do hash da senha do terminal, N = 2^valor. Opcional, padrão `17`; a produção recusa menos que 17 ao iniciar. Cada login usa cerca de 128 MiB de RAM por alguns instantes (no máximo 2 ao mesmo tempo, cerca de 256 MiB: o servidor limita a 2 cálculos simultâneos e põe o resto numa fila curta; a unit `biotrop.service` sobe o pool de threads do Node para 8 com `UV_THREADPOOL_SIZE=8`, para o scrypt não travar o resto do site): confira a memória da VM. Subir o valor não invalida senhas, mas, enquanto houver senha gravada no custo antigo, cada login calcula os dois custos (para matrícula inexistente levar o mesmo tempo): o login fica mais lento e usa mais memória. A senha passa ao custo novo no primeiro login certo; para encurtar a transição, gere no painel um convite de redefinição para quem não entrou depois da troca.

**Antes de publicar numa VM com dados do empréstimo.** A matrícula passou a ser única sem diferenciar maiúsculas (índice `upper(matricula)` da migration 40). Se já houver duas que só diferem na caixa (`T1001` e `t1001`), a migration para o deploy. Confira antes (deve voltar vazio):

```sql
SELECT upper(matricula), count(*) FROM emprestimo.colaborador GROUP BY 1 HAVING count(*) > 1;
```

**E-mails do empréstimo (VM que já está em uso).** Os avisos vêm **ligados** (migration 42), mas o worker só envia motivo que está em `EMAIL_MOTIVOS_ATIVOS`; motivo fora da lista é cancelado ("Motivo não habilitado para envio"). O `.env.example` já traz os cinco, mas numa VM em uso o `cp .env.example .env` não roda de novo: acrescente à mão, no `.env` do worker (`.env.worker` no systemd), e reinicie o `biotrop-email`:

```bash
EMAIL_MOTIVOS_ATIVOS=sci_revisao_solicitante,lms_cobranca_gestor,lms_certificado,copiloto_cobranca,emprestimo_lembrete,emprestimo_vencimento,emprestimo_atraso,emprestimo_escalonamento,emprestimo_devolucao
```

`emprestimo_lembrete` (antes do prazo), `emprestimo_vencimento` (no vencimento), `emprestimo_atraso` (recorrente), `emprestimo_escalonamento` (atraso longo: almoxarifado, com os gestores em cópia) e `emprestimo_devolucao` (devolução conferida; desligada por padrão no painel). Ensaie antes com `EMAIL_DRY_RUN=1` (lê a fila sem enviar). Prazos e liga/desliga ficam no painel (Configuração).

**Rede (nginx).** O `deploy/nginx/biotrop.conf` só deixa `/terminal` e `/api/terminal` para as faixas do bloco `geo $biotrop_terminal_rede` (no topo do arquivo); de fora, 403 antes de chegar ao Node. Sem isso, qualquer pessoa na internet poderia testar senhas em matrículas sequenciais e travar de propósito a matrícula de outra pessoa (5 erros = bloqueio). O padrão são as faixas privadas (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) e `127.0.0.1`:

- troque pela faixa da rede do almoxarifado ou pelo IP fixo do tablet (reserva de DHCP);
- se o tablet chega à VM pela internet (sem VPN), libere só o IP público fixo da fábrica;
- com balanceador ou Application Gateway na frente do nginx, o IP que o nginx vê é o do balanceador: configure `set_real_ip_from`/`real_ip_header` antes, senão todo mundo parece da rede interna.

```bash
sudo nginx -t && sudo systemctl reload nginx
# de fora da rede liberada: 403 {"ok":false,"erro":"O terminal só funciona na rede do almoxarifado."}
curl -s -o /dev/null -w '%{http_code}\n' https://manutencao.biotrop.com.br/api/terminal/eu
# da rede do almoxarifado: 401 (a API respondeu; sem sessão do terminal)
```

**Preparar o tablet.**

- Navegador em modo quiosque abrindo `/terminal` (Android Enterprise em "dispositivo dedicado" ou app fixado na tela). O botão Voltar não tira ninguém do terminal, mas a trava de verdade é o modo quiosque do aparelho.
- O tablet é compartilhado. Política do Chrome gerenciado (console de MDM ou Google Admin): `PasswordManagerEnabled=false`, `AutofillAddressEnabled=false`, `AutofillCreditCardEnabled=false`, `BrowserSignin=0`, `SyncDisabled=true`. Sem a primeira, o Chrome oferece "Salvar senha?" a cada login (o `autocomplete="off"` do formulário não impede) e, se alguém tocar em Salvar, o próximo colaborador entra com a matrícula e a senha da pessoa anterior.
- Confira no aparelho: depois de entrar e sair, o navegador não pede para salvar a senha nem preenche matrícula e senha na entrada seguinte. Como segunda trava, a tela do terminal recusa matrícula e senha preenchidas pelo navegador: limpa os campos e pede para digitar.
- Saída administrativa do modo tablet: segurar o logotipo por 3 s (ou Ctrl+Alt+Shift+S num teclado), matrícula e senha do terminal **e** o código do autenticador (2FA do site) de um admin, gestor ou almoxarife. Quem vai usar precisa ter o 2FA ativo no site.
- Atualizações: o `web/terminal.html` carrega os arquivos com `?v=N`. Quem muda `terminal.js`, `terminal.css`, `emprestimo-demo.js` ou `bm-tokens.css` sobe o número ali (o estático fica 1 h no cache do navegador). Parado na tela inicial, o tablet relê `/terminal` a cada 5 min e recarrega sozinho quando o `?v=` muda: depois do deploy, em até uns 6 min ele está na versão nova, sem ninguém mexer. Quem estiver no meio de uma retirada não é interrompido.

**Pacote.** `node scripts/build-vm.js` não leva o demo do empréstimo (`web/src/almox/emprestimo-demo.js`, com as senhas fictícias da prévia) nem a tag dele no `index.html` e no `terminal.html`.
