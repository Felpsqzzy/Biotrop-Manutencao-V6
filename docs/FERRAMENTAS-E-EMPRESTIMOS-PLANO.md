# Ferramentas, empréstimos e terminal do Almoxarifado — diagnóstico, plano e relatório das fases

Data: 09/10/2026 (fases 1 a 3), 16/10/2026 (fases 4 a 7) e 29/10/2026 (V6). Diagnóstico (Fase 1), plano técnico (Fase 2), decisões (seção 5), relatório da Fase 3 (seção 6), das fases 4 a 7, com a implantação (seção 7), e o terminal React da V6 com Empréstimo × Retirada (seção 8).

Repositório real: `Felpsqzzy/Biotrop-Manutencao-VM` (o texto do pedido cita `V3-Base`, que é uma versão antiga e não é a base deste trabalho). Última migration existente: `39`; as novas começam em `40` (na V6 vão até a `44`, seção 8).

## 1. O que os dois formulários dizem de verdade

| | REG.0306 EM — Empréstimo | REG.0305 RM — Retirada |
|---|---|---|
| Objeto | **Material** do almoxarifado (COD + descrição) | **Material** do almoxarifado (COD + descrição) |
| Colunas da lista | Nº, COD, DESCRIÇÃO, QTD, **QTD DEVOLUÇÃO**, **QTD P/ BAIXA** | Nº, COD, DESCRIÇÃO, QTD, **LOCALIZAÇÃO** |
| Linhas por folha | 14 | 17 |
| Requisitante | Data/hora, setor/empresa, nome/assinatura, retirado por, resp. almox. | igual |
| Finalidade | CAPEX (nº), SM / OM / TPM (nº), manutenção em equipamentos, insumos e consumíveis, **CC** | igual |
| Almoxarifado | **Aprovação melhoria (gerência)** com data/hora, nome, assinatura; **baixa sistêmica** com **nº da baixa**; segunda conferência com data/hora, nome, assinatura | igual |
| Controle documental | "Data 03/04/2026, Versão 02" no cabeçalho (arquivo diz Rev04) | "Data 04/03/2026, Versão 03" (arquivo diz Rev04) |

Leitura: o fluxo oficial é **empréstimo de material com devolução parcial e baixa do que não voltou** (QTD − QTD DEVOLUÇÃO = QTD P/ BAIXA), fechado com uma **baixa sistêmica no Dynamics**. Isso é diferente do plano colado no pedido, que trata de **ferramentas** com código próprio (FER-0001), número de série e patrimônio. As duas coisas podem coexistir, mas são modelos de dados diferentes (decisão 1).

Pontos de atenção: a versão/data no cabeçalho não bate com o "Rev04" do nome dos arquivos (conferir qual é a vigente); o CAPEX, a OM/SM/TPM e o CC são campos obrigatórios do formulário e hoje só existem na SCM (`almox.centro_custo` já traz a lista de CC); a "aprovação melhoria" é uma etapa humana da gerência que o plano não previa.

## 2. O que já existe no sistema (e deve ser reaproveitado)

| Tema | Hoje | Consequência para o módulo |
|---|---|---|
| Login | Só Microsoft Entra ID. O site **não guarda senha** (`core.usuario.senha_hash` existe, está nula e é só "saída de emergência"). Cookie assinado (HMAC, chave HKDF por finalidade), versão de sessão `sv`, sessão encerrada no servidor, inatividade e validade absoluta. | A credencial matrícula+senha será a **primeira senha guardada** no sistema: é superfície nova de ataque e exige cuidado próprio. |
| Identidade no banco | `transaction(user)` define `app.usuario_id` e as policies RLS usam `app.tem_perfil(...)`. Quem não está em `core.usuario` não passa em nada. | O terminal precisa de uma identidade que o RLS reconheça, sem herdar nenhuma permissão existente. |
| Perfis | `admin, gestor, pcm, almoxarife, lider, tecnico, viewer`. `viewer` **já enxerga toda SCI e toda SCM** (`sci_sel`/`scm_sel`). | **Não reutilizar `viewer` como "Visualizador do tablet".** Criar um perfil novo e mínimo (`terminal`) que não aparece em nenhuma policy existente. |
| Permissões | Tabela `core.permissao` + `core.perfil_permissao`: acrescentar permissão é um INSERT. Regra do projeto: permissão nova = tela + API + policy de RLS (inclusive UPDATE). | As permissões do módulo entram por aí, uma por ação (consultar, cadastrar, retirar, confirmar devolução, ajustar, baixar, administrar terminal, configurar). |
| 2FA | TOTP já existe, com "confirmação recente" ligada à sessão (`twofa.js`). | Serve de base para a **saída administrativa** do terminal. |
| Rate limit | Durável no banco (`app.consumir_limite`), mas **por IP**. | Login do terminal precisa de contagem **por matrícula + IP** e bloqueio temporário próprios (tablet compartilhado = um IP só). |
| Auditoria | `seguranca.evento` (sem texto sensível) e `core.auditoria`. | Reutilizar para login/logout do terminal e ações administrativas; movimentos de empréstimo terão histórico próprio imutável. |
| E-mail | Fila `core.email_fila` + worker (`worker-email.js`) com Microsoft Graph, lista de motivos permitidos (`EMAIL_MOTIVOS_ATIVOS`), reenvio e trava. O worker já chama a cada ciclo `lms.enfileirar_cobrancas_treinamento()`. | Os lembretes de vencimento/atraso seguem o **mesmo padrão**: uma função SQL `…enfileirar_cobrancas()` chamada pelo worker, sem duplicar (referência + motivo + dia). O TI precisa incluir os novos motivos em `EMAIL_MOTIVOS_ATIVOS`. |
| Dados pessoais | Camada de criptografia de campos (`crypto/pessoais.js`). | Decidir se matrícula/CC são cifrados (nome e e-mail já existem em `core.usuario`). |
| Menu e telas | `ui/menu.js` registra as áreas (`almox_catalogo`, `almox_inventario`…); telas em JS puro por módulo; modo demo `?demo=1`. | O painel do Almoxarifado entra no menu atual. O **terminal não** entra no site principal: é uma entrada própria (`/terminal`) com um pacote mínimo de telas. |
| Estoque de material | `almox.material` (catálogo MAN, import do Dynamics) e `inventario.*` (contagem). `pcm.item_estoque` é o estoque do PCM. | Se o empréstimo for de material, ele **referencia** `almox.material.codigo`; nada do inventário é alterado. |

Riscos encontrados: (a) mexer no `requireAuth` por engano afrouxaria o site inteiro: o terminal terá cookie, chave HKDF e middleware **próprios**; (b) tablet compartilhado exige sessão curta, sem "lembrar de mim" e sem cookie administrativo; (c) concorrência na última unidade: o saldo precisa ser decidido **no banco**.

## 3. Arquitetura proposta

### 3.1 Dois acessos separados
- **Site principal**: nada muda (Microsoft, perfis atuais).
- **Terminal** (`/terminal`, API `/api/terminal/*`): cookie próprio (`__Host-biotrop_terminal`, validade curta, ex.: 5 min de inatividade, configurável), chave HKDF de outra finalidade. O `requireAuth` principal **recusa** esse cookie e o middleware do terminal recusa o cookie do site. O login do terminal nunca cria sessão do site.
- **Identidade**: o colaborador do terminal é uma linha em `core.usuario` com perfil `terminal` (sem permissão em nenhuma tabela existente) + credencial em tabela própria. Assim existe uma pessoa só, o RLS funciona, e quem já tem conta Microsoft **não é duplicado** (a matrícula é vinculada à linha existente). Alternativa descartada: banco de identidades separado.

### 3.2 Credencial do terminal (nova tabela, fora de `core.usuario`)
`matricula` única, `usuario_id` → `core.usuario`, `senha_hash` (**Argon2id**; se o servidor da VM não oferecer a biblioteca, bcrypt com custo ≥ 12), `precisa_trocar`, `tentativas`, `bloqueado_ate`, `ultimo_acesso`. Regras:
- Primeiro acesso por **convite de uso único** com validade (token guardado só como hash), em que o próprio colaborador define a senha; o administrador nunca vê senha.
- Mensagem de erro **igual** para matrícula inexistente, senha errada e usuário bloqueado; tempo de resposta equalizado (anti-enumeração).
- Bloqueio temporário progressivo por matrícula e por IP, além do limite durável já existente.
- Sessão encerra por inatividade, volta à tela inicial, e todas as chamadas posteriores recebem 401.
- Troca de senha, bloqueio ou desligamento do colaborador derrubam a sessão na hora (mesmo mecanismo de versão `sv`).

### 3.3 Saída administrativa do modo tablet
Combinação de teclas discreta → pede **credenciais de um administrador** (matrícula+senha do terminal **e** código do autenticador que o site já usa) → o **servidor** valida e registra auditoria → emite um token de uso único que libera a saída → a sessão do terminal é encerrada. Nada de sessão administrativa permanecendo no tablet. Esconder o botão é só conforto; a autorização é do backend.

### 3.4 Modelo de dados (schema novo `ferramentas`, migrations 40+)
Pensado para os dois cenários; só entram as tabelas do que for decidido.

| Tabela | Finalidade |
|---|---|
| `terminal_credencial`, `terminal_convite`, `terminal_tentativa` | acesso do terminal (3.2) |
| `ferramenta` | cadastro (código único, nome, categoria, marca/modelo, localização, foto, ativo) e `controle` = `individual` ou `quantidade` |
| `ferramenta_unidade` | uma linha por patrimônio/série (estado: disponível, emprestada, manutenção, baixada) |
| `ferramenta_saldo` | para controle por quantidade: total, disponível, emprestada, manutenção, baixada, com `CHECK` ≥ 0 e soma consistente |
| `emprestimo` | número sequencial, colaborador, setor, centro de custo, prazo, finalidade (CAPEX/OM/SM/TPM + nº), atendente, status |
| `emprestimo_item` | item, quantidade, devolvida, para baixa, condição |
| `emprestimo_evento` | **imutável** (só INSERT): retirada, devolução parcial/total, avaria, extravio, baixa, estorno, ajuste, com autor e hora |
| `emprestimo_conferencia` | confirmação do almoxarife (e aprovação da gerência, se exigida) |
| `emprestimo_config` | prazos e regras de lembrete (alterável por quem tem permissão, sem mexer em código) |
| `emprestimo_aviso` | cada lembrete enviado (chave única por empréstimo+tipo+dia = sem duplicidade) |

Concorrência: retirada em **uma transação** com `UPDATE … SET disponivel = disponivel − :q WHERE id = :id AND disponivel >= :q` (ou `SELECT … FOR UPDATE` na unidade); se nenhuma linha for afetada, a retirada é recusada. Cliques repetidos: **chave de idempotência** enviada pelo tablet. Correção de erro: **estorno** como novo evento, nunca `UPDATE`/`DELETE` (triggers e privilégios impedem). RLS em todas as tabelas, inclusive UPDATE; migrations idempotentes e sem apagar o que outra mais nova recria (regra do `migrate.js`).

### 3.5 Permissões (por ação, no servidor e no RLS)
`ferramentas.consultar`, `.cadastrar`, `.editar`, `emprestimo.atender` (retirada em nome de alguém), `emprestimo.conferir_devolucao`, `emprestimo.ajustar`, `emprestimo.baixar`, `terminal.administrar_usuarios`, `emprestimo.configurar`. Nenhum perfil existente ganha permissão automaticamente além de `almoxarife`/`gestor`/`admin` no que já fazem hoje; o perfil `terminal` só opera **sobre os próprios empréstimos**.

### 3.6 E-mails e atraso
Função SQL chamada pelo worker já existente: lembrete D−1, no vencimento, e atraso recorrente (intervalo configurável), escalando ao almoxarife/gestor. Só considera a **quantidade pendente**; devolução encerra o lembrete correspondente. Sem senhas e sem dados desnecessários no texto. Depende do TI: novos motivos em `EMAIL_MOTIVOS_ATIVOS` e a conta de envio já usada hoje.

### 3.7 Telas
- **Terminal (tablet, toque)**: entrar → retirar (busca por código/nome, quantidade, resumo e confirmação) → devolver (escolhe empréstimo, quantidades, condição) → meus empréstimos → consultar disponibilidade. Botões grandes, sem rolagem horizontal, retorno automático à tela inicial.
- **Painel (menu Almoxarifado)**: ferramentas/itens, empréstimos ativos e atrasados, conferência de devoluções, avarias/extravios, ajustes auditados, histórico por item e por pessoa, usuários do terminal, configuração, relatórios (Excel). Segue o design atual (`--bm-*`, claro/escuro).
- **Excel no padrão REG.0306**: exportação do empréstimo preenchendo o modelo (COD, descrição, QTD, QTD DEVOLUÇÃO, QTD P/ BAIXA, requisitante, finalidade, CC). As assinaturas em papel continuam existindo até a política interna aceitar a conferência eletrônica (decisão 4).

## 4. Fases

| Fase | Entrega | Verificação |
|---|---|---|
| 1 | Este diagnóstico | feito |
| 2 | Este plano e as decisões (seção 5) | feito |
| 3 | Migration 40 e API de itens, saldos, empréstimos, eventos (sem tela), com RLS | feito (seção 6) |
| 4 | Credencial e sessão do terminal, convite, bloqueio, saída administrativa | feito (seção 7) |
| 5 | Telas do tablet e do painel (demo `?demo=1` com dados fictícios) | feito (seção 7) |
| 6 | Lembretes por e-mail e relatórios/Excel | feito (seção 7) |
| 7 | Regressão completa, revisão de segurança, documentação (`.env`, migrations, TI) | feito (seção 7) |

Cada fase termina com: arquivos alterados, migrations, o que foi executado e validado, riscos, próxima etapa. Nada é publicado sem pedido do Felipe.

## 5. Decisões do Felipe (09/10/2026)

1. **O que é emprestado: os dois.** Ferramentas com cadastro próprio (por quantidade ou por unidade) e material do catálogo MAN seguindo o REG.0306 (QTD, QTD DEVOLUÇÃO, QTD P/ BAIXA).
2. **Identidade:** perfil `terminal` em `core.usuario` + credencial própria em tabela separada.
3. **Matrículas:** cadastro no painel (um a um).
4. **Aprovações:** conferência eletrônica do almoxarife + nº da baixa do Dynamics registrado. A aprovação da gerência fica para uma regra configurável depois.
5. **Ainda com o TI:** novos motivos de e-mail e a rede do tablet no proxy (`/terminal` só da rede do almoxarifado). A biblioteca Argon2id deixou de ser pendência: o hash da senha do terminal usa o `scrypt` do próprio Node (seção 7).

## 6. Fase 3 — banco e API (executada em 09/10/2026)

**Arquivos**
- `database/migrations/40-emprestimo.sql` (novo): schema `emprestimo`, perfil `terminal`, tabelas, RLS, travas de histórico e a função `emprestimo.executar()`.
- `server/src/routes/emprestimo.js` (novo) e `server/src/app.js` (rota `/api/emprestimo` com limite de requisições).
- `server/src/routes/read-scope.js`: o perfil `terminal` não lê nada do site.
- Testes: `server/test-integracao/emprestimo.test.js` (13 cenários) e `server/test/emprestimo-escopo.test.js`.

**Como ficou**
- A API não tem INSERT/UPDATE/DELETE nas tabelas: toda escrita passa por `emprestimo.executar()`, igual ao inventário.
- **Canal:** a API define `app.canal` na transação. No canal `terminal` a gestão e a gerência ficam desligadas **no banco** (funções `gestao()`/`gerencia()` e RLS). Um administrador logado no tablet é só um colaborador: pega e devolve para si, não confere, não estorna, não ajusta e só vê os empréstimos dele.
- **Quem faz o quê:**
  - colaborador (tablet): retirar para si e devolver o que é seu;
  - almoxarife, gestor e admin (painel): cadastro, colaboradores, retirada para outra pessoa, conferência, baixa e prazo;
  - só gestor e admin: ajuste de saldo, estorno e configuração.
  - Desde 27/10/2026, cadastro de ferramenta, colaboradores (criar, convite, liberar acesso), ajuste de saldo e configuração pedem **2FA ativo e confirmado nos últimos 10 min** (step-up, `requireStepUpAdmin` em `routes/twofa.js`). Sem 2FA, a tela abre o assistente de ativação (Minha conta › Segurança), que exige login Microsoft dos últimos 15 min. Retirada, conferência, baixa, prazo e estorno seguem sem step-up.
- **Saldo:** `CHECK` impede negativo e garante total = disponível + emprestada + em conferência + manutenção + baixada. A retirada trava a linha do saldo (e a unidade) e só desconta se ainda houver disponível. Clique duplo usa uma chave de operação: o mesmo pedido devolve o mesmo empréstimo, inclusive quando chega duas vezes ao mesmo tempo.
- **Status gravados:** em andamento, parcialmente devolvido, aguardando conferência, devolvido, encerrado (com baixa) e estornado. "Atrasado" é calculado na consulta (prazo vencido com pendência).
- **Fluxo da devolução:** quem devolve informa a quantidade e a condição. O almoxarife confere cada item como `boa` (volta ao disponível), `avaria` (vai para manutenção, com explicação) ou `recusada` (não voltou de fato). O que não volta vira baixa por `extravio` ou `consumo` (só material), com justificativa e nº da baixa opcional.
- **Histórico:** `emprestimo_evento` e `auditoria` só aceitam INSERT (trigger, vale até para o dono do banco); empréstimo não se apaga, corrige-se por estorno, e só sem devolução.

**Testes executados**
- `npm --prefix server test`: 197/197.
- `npm --prefix server run test:integracao`: 107/107. Os 13 novos cobrem cadastro e código único, permissões, saldo insuficiente, última unidade disputada, unidade individual, canal terminal, devolução parcial, conferência, avaria, baixa no formato do REG.0306, extravio, estorno, ajuste nunca negativo, configuração, atraso e prazo, histórico imutável, perfil terminal sem acesso ao site e reaplicação da migration.

**Achado de segurança, corrigido:** o filtro de leitura da API (`read-scope.js`) liberava sem filtro qualquer perfil fora da lista conhecida. Só o RLS do banco segurava. O perfil `terminal` agora é fechado explicitamente.

**Limites e riscos**
- O banco dos testes (PGlite) tem uma conexão só: a disputa pela última unidade é testada em sequência. Em PostgreSQL real a garantia vem do `FOR UPDATE` + `UPDATE … WHERE disponivel >= n`; vale repetir o teste na homologação com duas sessões.
- **Fase 4:** quem pode gerar convite ou redefinir a senha do terminal de uma conta admin ou gestor tem de ser só a gerência. Sem isso, um almoxarife poderia definir a senha e entrar como outra pessoa no tablet; mesmo assim, lá ela teria só os poderes de colaborador.
- Ainda não há tela; foto da ferramenta e importação em lote ficam para as fases 5 e 6.

**Próxima etapa (09/10):** Fase 4, credencial e sessão do terminal. Feita: seção 7.

## 7. Fases 4 a 7 — terminal, telas, avisos, regressão e implantação (16/10/2026)

**Migrations** (idempotentes; o `migrate.js` reaplica todas a cada deploy e nenhuma apaga o que outra recria)
- `41-terminal-acesso.sql`: credencial do terminal (`emprestimo.terminal_credencial`), convite de primeiro acesso e de redefinição (`terminal_convite`, só o HMAC do código), tentativas com bloqueio temporário por matrícula e por aparelho (`terminal_tentativa`, IP só como HMAC) e sessões do tablet (`terminal_sessao`). RLS restritiva: a API só mexe por funções `SECURITY DEFINER`.
- `42-emprestimo-avisos.sql`: avisos por e-mail (`emprestimo.aviso`, colunas novas em `emprestimo.config`) e `emprestimo.enfileirar_avisos()`, chamada pelo `worker-email.js` a cada ciclo.
- `43-ferramenta-foto.sql`: foto opcional da ferramenta (`emprestimo.ferramenta_foto`), gravada só pela gestão no painel.
- `29` e `34` (ajuste): quem só usa o terminal (perfil `terminal`) fica fora da equipe de Treinamentos (`lms.equipe_visivel()`) e dos contadores do Inventário (`inventario.usuarios()`).

**API**
- `/api/terminal/*` (`server/src/routes/terminal.js`, `auth/terminal-sessao.js`, `middleware/terminal.js`, `lib/senha-terminal.js`): entrar, primeiro acesso, sair, eu, ferramentas (com foto), empréstimos do próprio colaborador, retirada, devolução e saída administrativa. Cookie, chave HKDF e middleware próprios: o cookie do site não vale aqui e vice-versa.
- `/api/emprestimo/*` (`routes/emprestimo.js`): colaboradores com a situação do acesso, convite, bloqueio e desbloqueio, foto da ferramenta. `/api/emprestimo/avisos/*` (`routes/emprestimo-avisos.js`): configuração e lista dos avisos.
  - **Pedem step-up 2FA (desde 27/10/2026; 403 `precisa2fa`, e `configurar2fa` para quem não tem 2FA):** `POST /ferramentas`, `PUT /ferramentas/:id`, `POST /ferramentas/:id/ajustes`, `PUT /config`, `POST /colaboradores`, `POST /colaboradores/:id/convite`, `POST /colaboradores/:id/acesso` **só ao liberar** (`bloqueado: false`) e `PUT /avisos/config`. Bloquear o acesso continua imediato, sem step-up. Leituras (GET), retirada, devolução, conferência, baixa, prazo, estorno, unidades individuais (`POST /ferramentas/:id/unidades`) e a foto não pedem. Na V6 a importação (`POST /ferramentas/importar`) também pede (seção 8).
- `server/src/app.js`: limites próprios do terminal e do painel, `GET /terminal` antes do coringa do `index.html`, 413 para corpo acima de 2 MB e 400 para JSON malformado.

**Como ficou (decisões)**
- Hash da senha: `scrypt` do `node:crypto` (N = 2^17, r = 8, p = 1), formato versionado para trocar por Argon2id no futuro (regrava no próximo login). O servidor não tem `argon2`/`bcrypt` instalados e o scrypt é aceito pela OWASP.
- Mesma resposta para matrícula inexistente, senha errada, bloqueado, inativo e sem senha. Bloqueio por matrícula (5 erros: 5 min, depois 15 min, depois 1 h) e por aparelho (30 erros em 15 min). Inatividade da configuração e validade absoluta de 30 min.
- O terminal só empresta ferramenta; material do catálogo MAN segue no balcão (painel).
- Saída administrativa escondida (segurar o logotipo 3 s ou Ctrl+Alt+Shift+S): senha do terminal **e** código do autenticador (2FA do site) de admin, gestor ou almoxarife.
- Demonstração sem servidor (`?demo=1` e prévia da Vercel): `web/src/almox/emprestimo-demo.js`, com pessoas e senhas fictícias. Não vai para o pacote da VM (`scripts/build-vm.js`). Na V6: `apps/web/src/terminal/demo.ts` (seção 8).

**Regras acertadas na revisão (rodada 1, 16-17/10/2026)** — valem na API, no banco e no demo (a paridade compara os dois)
- Senha do terminal: o mínimo de 8 caracteres conta a senha como ela é gravada (NFKC). Na V6 virou PIN de 6 dígitos (seção 8). Todo login calcula um scrypt de cada custo de hash em uso, para matrícula inexistente e hash de custo antigo levarem o mesmo tempo; o limite do aparelho (30 erros em 15 min) é reservado antes do scrypt, então pedidos simultâneos também param em 30.
- Matrícula única **sem diferenciar maiúsculas** (`T1001` = `t1001`), gravada como foi digitada; login, primeiro acesso e o filtro `?matricula=` também.
- Cadastro de colaborador com conta de admin ou gestor (editar inclusive) só pela gerência: o banco recusa com 403 e o painel nem mostra "Editar" na linha. Editar sem mandar `ativo` mantém a situação; `ativo` aceita só true/false.
- Auditoria da edição de ferramenta e de colaborador grava o antes e o depois de cada campo (`detalhe.alteracoes`); a ficha da ferramenta mostra "campo: de → para".
- Chave de operação opcional também no ajuste de saldo, na baixa e na conferência (o painel gera uma por formulário aberto): o reenvio depois de uma resposta perdida devolve `repetido: true` e não aplica de novo. No tablet, a chave da retirada e a da devolução só trocam depois que o servidor confirma.
- `GET /api/emprestimo/emprestimos`: "só atrasados" exige pendência; período pelo dia de Brasília; abertos por prazo e fechados do mais novo para o mais antigo; `?limite=` (1 a 500, padrão 200) e `?pagina=`; `?ferramenta=<id>` traz só os empréstimos daquela ferramenta (o `q` é busca por trecho). Os Relatórios pedem página a página e marcam "RECORTE" se a lista vier cortada.
- Estornado não deixa nada pendente: `pendente` 0 na lista, na ficha e em "Meus empréstimos" do tablet (o estorno devolve o saldo sem mexer nas quantidades do item).
- Ajuste de saldo acima do que há: 400 "O ajuste deixaria o saldo negativo: confira o disponível e a manutenção na ficha." (a tela confere antes; a mensagem cobre duas pessoas mexendo no mesmo saldo).
- Avisos por e-mail: colaborador com o cadastro do terminal desligado no painel **ou** usuário do site inativo fica "pulado" ("Colaborador inativo"); o escalonamento continua indo ao almoxarifado. A janela do atraso é o número de ordem do atraso naquele prazo: mudar o intervalo no meio do caminho não cala o aviso (o próximo sai um intervalo depois do último).
- `entrar`, `primeiro-acesso` e `GET /eu` do terminal devolvem `prazoPadraoHoras` (o da configuração).

**Telas**: `web/terminal.html` + `web/src/terminal/terminal.js|css` (tablet); `web/src/almox/emprestimo.js|css` (painel, menu Almoxarifado › Ferramentas e empréstimos, `web/src/ui/menu.js`). Na V6 o tablet é `apps/web/terminal.html` + `apps/web/src/terminal/*.tsx` (seção 8).

**Testes**: unidade `server/test/emprestimo-*.test.js` e `terminal-*.test.js`; integração (PGlite, RLS ligado) `server/test-integracao/emprestimo.test.js`, `terminal.test.js`, `emprestimo-avisos.test.js`, `emprestimo-foto.test.js`, `emprestimo-paridade.test.js` (a mesma sequência na API e no demo) e `emprestimo-cobertura.test.js`. Na V6 não há `emprestimo-paridade.test.js`; entra `emprestimo-retirada.test.js` (seção 8).

**Implantação** (passo a passo em `docs/DEPLOY-TI.md`, seção 9)
- Variável nova `TERMINAL_SCRYPT_LOG2N` (opcional, padrão 17; a produção recusa menos). Cerca de 128 MiB de RAM por login simultâneo. Depois de subir o valor, enquanto houver senha gravada no custo antigo, cada login calcula os dois custos (mais lento e mais memória): gere convite de redefinição para quem não entrou depois da troca.
- Índice único de matrícula sem diferenciar maiúsculas (`upper(matricula)`, migration 40): se o banco já tiver duas matrículas que só diferem na caixa, o deploy para. Antes de publicar numa VM com dados: `SELECT upper(matricula), count(*) FROM emprestimo.colaborador GROUP BY 1 HAVING count(*) > 1;` deve voltar vazio.
- `EMAIL_MOTIVOS_ATIVOS` do worker com `emprestimo_lembrete`, `emprestimo_vencimento`, `emprestimo_atraso`, `emprestimo_escalonamento` e `emprestimo_devolucao`. Os avisos vêm ligados: sem os motivos, o worker cancela todos.
- nginx: `/terminal` e `/api/terminal` só da rede do almoxarifado (`geo $biotrop_terminal_rede` em `deploy/nginx/biotrop.conf`); de fora, 403.
- Tablet em modo quiosque, com o gerenciador de senhas e o preenchimento automático do navegador desligados (`PasswordManagerEnabled=false`).
- `web/terminal.html` carrega os arquivos com `?v=N`: subir o número quando o arquivo mudar (o estático fica 1 h em cache na VM). Parado na tela inicial, o tablet relê `/terminal` a cada 5 min e recarrega sozinho quando o `?v=` muda (em até uns 6 min depois do deploy). Na V6 não há `?v=`: `versao.ts` compara os `/assets/` com hash (seção 8).
- O tablet recusa matrícula e senha preenchidas pelo navegador (`:autofill`): limpa os campos e pede para digitar.

**Pendências**
- Conferir no tablet físico: modo quiosque, política do navegador (sem "Salvar senha?") e a saída administrativa.
- Repetir em PostgreSQL real, com duas sessões, a disputa pela última unidade (o PGlite dos testes tem uma conexão só).
- Conferir com o almoxarifado qual revisão do REG.0306/REG.0305 vale (cabeçalho × nome do arquivo).

## 8. V6 — terminal React, Empréstimo × Retirada (29/10/2026)

Branch `feat/terminal-emprestimo-retirada` (commit de 30/10/2026), com o kit visual `apps/web/src/ui`, de que o terminal depende.

**Migrations**: `40` a `44`. A nova é `44-emprestimo-retirada.sql`:
- `emprestimo.modalidade` (`emprestimo` | `retirada`), status `aguardando_baixa` (só retirada), `prazo` nulo só na retirada; tudo por `CHECK`, refeito a cada deploy (DROP IF EXISTS + ADD).
- Ferramenta com `retiravel`, `codigo_compra` (≤ 60) e `patrimonio` (≤ 80).
- Regras em `emprestimo.executar()` da 40: ações `retirada_confirmar`, `retirada_recusar` e `ferramentas_importar`; `emprestar` aceita `modalidade`.

**Retirada (RM)**
- Só ferramenta `retiravel`, nunca material. Nasce `aguardando_baixa` (disponível → emprestada), sem prazo.
- `POST /api/emprestimo/emprestimos/:id/retirada {acao, numeroBaixa?, justificativa?, chave?}`: confirmar → baixada, `encerrado` (nº da baixa opcional); recusar → volta ao disponível, `estornado` (justificativa de 5+ caracteres).
- Devolução, conferência, baixa avulsa, novo prazo e estorno recusam retirada.
- Sem prazo: nunca "atrasada" e sem avisos por e-mail (a 42 só olha os status do empréstimo).
- `GET /api/emprestimo/emprestimos?modalidade=emprestimo|retirada`.

**Importação**: `POST /api/emprestimo/ferramentas/importar {linhas}`, de 1 a 1000 linhas, com step-up 2FA da gestão. Linha inválida = 400 "Linha N: …" e nada gravado; código que já existe ou se repete é ignorado (`ignoradas`).

**PIN do terminal** (`server/src/lib/senha-terminal.js`, `validarSenha`): exatamente 6 dígitos, nem todos iguais, sem sequência (123456, 654321), diferente dos 6 últimos dígitos da matrícula. Vale ao definir (primeiro acesso e redefinição); o login ainda aceita a senha antiga até a redefinição. O PIN entra só pelo teclado numérico da tela (`teclado.tsx`: campo readonly, `inputMode="none"`).

**Telas**: `apps/web/terminal.html` + `apps/web/src/terminal/*.tsx` (React; Motion com `LazyMotion` + `domAnimation` e o componente `m`).
- Após o login, dois cartões: Empréstimo × Retirada (`Modulos.tsx`); troca pelo topo sem sair.
- Catálogo único (`Catalogo.tsx`), alternável cartões ↔ lista (lembrado no navegador). Botão "Separar": por quantidade vira contador (− n +); item por unidade abre a folha da etiqueta. Não há divisão visível quantidade × patrimônio.
- Bandeja fixa "N itens separados · Revisar" (sem "carrinho"). Durante o envio, nada de Voltar, "Separar mais" ou troca de módulo.
- `GET /api/terminal/ferramentas?modalidade=retirada` filtra as retiráveis no servidor; até 1000, com `cortado: true` acima disso. `codigoCompra` e `patrimonio` não vão ao tablet.
- Listas com mais de 100 linhas virtualizadas (`@tanstack/react-virtual`, catálogo e Meus).
- Vidro só nas superfícies fixas; no login, sem blur sobre o fundo animado.

**Atualização do tablet**: `apps/web/src/terminal/versao.ts`. Parado na tela inicial, relê o HTML, compara os `/assets/` com hash; mudou, espera e recarrega uma vez por versão (sem laço). Substitui o `?v=N`.

**Demo**: `apps/web/src/terminal/demo.ts`, carregado por `import()` só no build demo (fora dele não entra no pacote).

**Testes** (30/10/2026, só os arquivos deste commit, numa cópia limpa): web 55 (51 + 4 que só rodam depois do build), shared 27, server 167, integração 256. Integração nova: `server/test-integracao/emprestimo-retirada.test.js`.

**Pendências**
- O teste de orçamento (`apps/web/test/dist-sem-inline.test.ts`) só mede o `index.html`. O terminal foi medido à mão: 119,5 KB gzip.
- Conferir no tablet físico.
