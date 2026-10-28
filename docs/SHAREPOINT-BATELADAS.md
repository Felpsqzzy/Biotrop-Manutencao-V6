# Bateladas → lista do SharePoint (Inteligência de Dados)

Atualizado em 05/10/2026.

## O que muda

| Antes | Agora |
|---|---|
| O técnico preenche o Forms com o contador do supervisório de cada tanque | O técnico aponta na Plataforma de Manutenção (PCM › Apontar bateladas) |
| O Forms grava na lista **Bateladas** do site *InteligenciaDados* | O site grava na mesma lista, linha por dia, pelo worker `worker-sharepoint.js` |
| A planilha "CONTROLE DE BATELADAS" só mostra os dados novos depois de **Atualizar dados** | O painel do site mostra na hora, e a lista continua alimentada para quem usa os gráficos de lá |

As colunas da lista não mudam: `Data` e uma por tanque (`PGD 01`…`PGD 15`, `FTD 01`…`FTD 15`, `BLR 02`…`BLR 05`).
Cada linha continua sendo o **contador acumulado** em vigor naquele dia.

## Pedido para a TI

O aplicativo do Entra que já envia os e-mails (o mesmo `GRAPH_CLIENT_ID`) precisa de acesso só a este site:

1. No aplicativo, adicionar a permissão de **aplicativo** `Sites.Selected` (Microsoft Graph) e dar o consentimento do administrador.
   Com `Sites.Selected`, o aplicativo **não** enxerga nenhum outro site do tenant.
2. Conceder escrita no site `https://bioaqua.sharepoint.com/sites/InteligenciaDados` para o aplicativo:

   ```http
   POST https://graph.microsoft.com/v1.0/sites/bioaqua.sharepoint.com:/sites/InteligenciaDados:/permissions
   Content-Type: application/json

   { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<GRAPH_CLIENT_ID>", "displayName": "BIOTROP Manutenção" } }] }
   ```

   Essa chamada exige uma conta de administrador com `Sites.FullControl.All`, por exemplo pelo Graph Explorer ou pelo PnP PowerShell (`Grant-PnPAzureADAppSitePermission -Permissions Write`).
3. Nenhum segredo novo: o worker usa o mesmo `GRAPH_CLIENT_SECRET` do `.env.worker`.

## Ligar na VM

1. Em `/opt/biotrop/.env.worker`, acrescentar as variáveis `SHAREPOINT_*` (veja `.env.example`). Comece com `SHAREPOINT_DRY_RUN=1`.
2. Instalar e iniciar o serviço:

   ```bash
   sudo cp /opt/biotrop/deploy/systemd/biotrop-sharepoint.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now biotrop-sharepoint
   journalctl -u biotrop-sharepoint -f
   ```

3. Em modo de ensaio, o log mostra os dias que seriam enviados. Confira e troque para `SHAREPOINT_DRY_RUN=0`.
4. Na tela **PCM › Bateladas**, o PCM vê a situação da fila: dias pendentes, último envio e último erro.

## Como o worker grava

- **Fila:** cada dia em que um contador mudou entra em `pcm.batelada_sharepoint`. Corrigir um dia antigo reenvia aquele dia e os seguintes, porque a lista guarda o contador em vigor em cada data.
- **Gravação:** para cada dia, o worker procura a linha da lista pela coluna `Data`. Se existe, atualiza só os contadores; se não, cria a linha.
- **Histórico:** o histórico importado da planilha **não** é reenviado, porque já está na lista.
- **Erros:** sem permissão (401/403), o worker para o lote e guarda o erro. As outras falhas são tentadas de novo a cada ciclo, até `SHAREPOINT_TENTATIVAS_MAX`.

## Depois que estiver rodando

- Desativar o Forms antigo, para ninguém apontar em dois lugares.
- A consulta da planilha (`.iqy`) continua funcionando. Para ela se atualizar sozinha: **Dados › Consultas e Conexões › Propriedades** e marcar "Atualizar a cada 30 minutos" e "Atualizar ao abrir o arquivo".

## 2026-10-09 — Bateladas: abas da planilha e extras de manutenção

- Bateladas incorpora Dados de coleta, Consulta (SharePoint), Diária, Mensal, Semanal, Pós-preventiva, Gás e diafragma, Calendário, Preventivas do ano atual/anterior, EBAs e Status; Auxiliar vira o bloco Hoje. Painel permanece disponível.
- Migration 38 cria `pcm.batelada_tarefa` e `pcm.eba_preventiva`, vazias e idempotentes. API: GET /extras, PUT /tarefas, PUT /eba, DELETE /eba/:id; POST /importar recebe tarefas, EBAs e preventivas não exatas.
- Equipe lê; PCM/gestão/admin gravam na tela, API e RLS (incluindo UPDATE). Importação lê preenchimento azul, guarda semana sem data exata e preserva marcações feitas no site; reimportar não duplica preventivas/EBAs.
- Desde 27/10/2026, `POST /importar`, `POST /preventivas`, `DELETE /preventivas/:id` e `DELETE /eba/:id` pedem step-up 2FA (ativo e confirmado nos últimos 10 min); `PUT /programacao/:ativoId`, `/tarefas`, `/eba` e o apontamento seguem sem.
- Corrigidas barras do minigráfico que excediam o cartão e limites de semana na virada do ano: semana 1/2026 é 01–04/jan; semana 2 é 05–11/jan; última semana termina em 31/dez. Render e deduplicação usam `semanaExcel`.
- Exportação Excel mantém resumo/situação/taxa/mensal/histórico; reproduzir todas as abas da planilha original na exportação segue pendente.
- Testes focados executados: planilha sintética 4/4 e integração Bateladas 10/10, incluindo RLS direto (UPDATE/DELETE/INSERT) e preservação dos extras ao reaplicar migration 38 e todas as migrations.

As rotas acima são relativas a `/api/pcm/bateladas`. As novas abas usam `web/src/pcm/bateladas-abas.js` e `.css`; leitura e importação estão em `bateladas.js`. Semanas parciais não se sobrepõem: uma preventiva exata na semana 2 não elimina uma marca azul da semana 1. Os extras não entram no worker de contadores do SharePoint. Testes: `server/test/bateladas-planilha.test.js` e `server/test-integracao/bateladas.test.js`.
