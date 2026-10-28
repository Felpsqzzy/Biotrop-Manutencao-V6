# Inventário no Power BI

O BIOMANUT gera a base do painel; o Power BI só lê. Nada é lançado no Dynamics.

> **Desde 13/10/2026 a tela do inventário saiu do site** (virou o arquivo offline `/ferramentas/inventario.html`, ver `INVENTARIO.md`). O botão "Exportar para Power BI" descrito abaixo era dessa tela e não está mais disponível; os inventários antigos continuam no banco e a rota `GET /api/inventario/bi` continua respondendo. Os inventários feitos no arquivo offline não entram nesta base do servidor: o próprio arquivo gera uma planilha no **mesmo formato** (abas `Inventarios`, `Posicoes`, `Contagens` e `LEIA-ME`, mesmas colunas; função `powerBi` de `ferramentas/inventario/src/planilhas.js`), que o painel descrito abaixo lê sem mudança. Nela, `CAMM` é o nome da lista de contagem e só entram as posições do escopo do inventário. Para juntar vários inventários offline, empilhe as abas no Power Query (**Acrescentar consultas**).

> **Baixas RM/EM (REG.0715, 15/10/2026).** No arquivo offline o responsável pode aplicar a lista de materiais em RM/EM (já saíram fisicamente, mas a baixa ainda não entrou no Dynamics). Aí a régua deixa de ser o saldo e passa a ser o **esperado = SaldoSistema − ABaixar** (sem baixa, o próprio saldo). Na planilha do Power BI gerada pelo arquivo offline:
>
> - `Posicoes` ganha três colunas **no fim** (a base do site não tem; o painel antigo continua lendo): `ABaixar` (quantidade em RM/EM; em branco sem baixa), `TipoBaixa` (`RM`, `EM`, `RM+EM` ou vazio) e `Esperado` (sempre preenchida; = `SaldoSistema` quando não há baixa). `Diferenca` e `AjusteValor` já são contra o esperado; `SaldoSistema` continua o sistêmico do Dynamics.
> - `Inventarios[ValorSistemico]` é Σ esperado × custo (não Σ saldo × custo) quando há baixa; `DivergenciaPct` usa esse valor.
> - `Contagens[IgualAoSaldo]` (o nome ficou o mesmo) diz "Sim" quando a contagem é igual ao **esperado**; a medida "Acuracidade 1ª contagem %" continua certa sem mudança.
> - Na medida `Valor sistêmico R$` abaixo, troque `Posicoes[SaldoSistema]` por `COALESCE ( Posicoes[Esperado], Posicoes[SaldoSistema] )` para bater com a coluna `ValorSistemico` (o `COALESCE` mantém a base do site, que não tem `Esperado`). Para ver o que está em RM/EM: `A baixar (RM/EM) = SUM ( Posicoes[ABaixar] )`, por `Unidade`.
> - Inventário cuja lista ficou "só para consulta" (contado ou aprovado numa versão anterior do arquivo; ver `INVENTARIO.md`) sai com `ABaixar` vazio e `Esperado` = saldo: lá as baixas não entraram no cálculo.

## 1. Gerar a base (a cada inventário ou quando quiser atualizar)

1. Entre como almoxarifado, gestor ou administrador.
2. **Almoxarifado › Inventário › Exportar para Power BI** (todos os inventários) ou, dentro de um inventário, **Power BI** (só ele).
3. Sai o arquivo `biomanut-inventario-powerbi.xlsx` com quatro abas:

| Aba | Uma linha por | Colunas principais |
|---|---|---|
| `Inventarios` | inventário | Situacao (Em contagem / Aguardando aprovação / Aprovado), Posicoes, Concluidas, Divergentes, ProgressoPct, AcuracidadePct, Acuracidade1aContagemPct, CoberturaCustoPct, Faltas, Sobras, Liquido, Absoluto, ValorSistemico, ValorContado, DivergenciaPct, AprovadoPor |
| `Posicoes` | posição (código + site + depósito + localização) | CAMM, Codigo, Descricao, Unidade, Site, Deposito, Localizacao, SaldoSistema, QuantidadeFinal, Diferenca, CustoUnitario, AjusteValor, Etapa, Situacao, Justificativa |
| `Contagens` | contagem (1ª, 2ª, 3ª) | Etapa, Quantidade, IgualAoSaldo, Contador, ContadoEm |
| `LEIA-ME` | — | quando foi gerado e o recorte |

Regras que já vêm aplicadas na planilha:

- Faltas são negativas e sobras positivas. `Absoluto` soma o módulo de cada ajuste (não se anula).
- Valores em R$ só das posições concluídas **com custo**; `CoberturaCustoPct` diz quanto isso representa. Posição sem custo fica em branco, nunca zero.
- Quantidades de unidades diferentes (UN, MT, L…) não devem ser somadas entre si — use a coluna `Unidade` como filtro ou eixo.
- Inventário aberto em que a pessoa que exportou é contadora fica de fora (contagem cega).

**Guarde sempre com o mesmo nome** numa pasta do SharePoint/OneDrive com acesso restrito (a planilha tem custos), por exemplo `Manutenção › Almoxarifado › Inventário › Power BI`. Para atualizar o painel: exporte de novo, salve por cima e clique em **Atualizar** no Power BI.

## 2. Montar o painel (uma vez só)

No Power BI Desktop:

1. **Obter dados › Pasta do SharePoint** (ou **Excel**, se o arquivo estiver na sua máquina) e escolha `biomanut-inventario-powerbi.xlsx`.
2. Marque as tabelas `Inventarios`, `Posicoes` e `Contagens` › **Transformar dados**.
3. Em cada tabela, confira os tipos (Página Inicial › Editor avançado). Exemplo para `Posicoes`:

```powerquery
let
    Fonte = Excel.Workbook(Web.Contents("https://SEU-SHAREPOINT/.../biomanut-inventario-powerbi.xlsx"), null, true),
    Aba = Fonte{[Item = "Posicoes", Kind = "Sheet"]}[Data],
    Cab = Table.PromoteHeaders(Aba, [PromoteAllScalars = true]),
    Tipos = Table.TransformColumnTypes(Cab, {
        {"SaldoSistema", type number}, {"QuantidadeFinal", type number}, {"Diferenca", type number},
        {"CustoUnitario", Currency.Type}, {"AjusteValor", Currency.Type},
        {"Codigo", type text}, {"Localizacao", type text}, {"Site", type text}, {"Deposito", type text}, {"CAMM", type text}})
in
    Tipos
```

   Em `Inventarios`, deixe `DataReferencia`, `DataExportacao`, `CriadoEm`, `AprovadoEm` como **Data** e os campos `...Pct`, `Faltas`, `Sobras`, `Liquido`, `Absoluto`, `Valor...` como número decimal. Em `Contagens`, `ContadoEm` como **Data/hora**.
4. **Modelo › Relações**: `Inventarios[InventarioId]` 1 → * `Posicoes[InventarioId]` e 1 → * `Contagens[InventarioId]`.
5. **Exibição › Temas › Procurar temas** e escolha `docs/powerbi/biomanut-tema.json` (cores do BIOMANUT, legíveis em preto e branco).

### Medidas (Modelagem › Nova medida, na tabela `Posicoes`)

```dax
Posições = COUNTROWS ( Posicoes )
Posições concluídas = CALCULATE ( [Posições], Posicoes[Situacao] <> "Pendente" )
Posições divergentes = CALCULATE ( [Posições], Posicoes[Situacao] = "Divergente" )
Progresso % = DIVIDE ( [Posições concluídas], [Posições] )
Acuracidade % = DIVIDE ( CALCULATE ( [Posições], Posicoes[Situacao] = "Conferido" ), [Posições concluídas] )
Códigos distintos = DISTINCTCOUNT ( Posicoes[Codigo] )
Faltas R$ = CALCULATE ( SUM ( Posicoes[AjusteValor] ), Posicoes[AjusteValor] < 0 )
Sobras R$ = CALCULATE ( SUM ( Posicoes[AjusteValor] ), Posicoes[AjusteValor] > 0 )
Líquido R$ = SUM ( Posicoes[AjusteValor] )
Absoluto R$ = SUMX ( Posicoes, ABS ( Posicoes[AjusteValor] ) )
Valor sistêmico R$ =
    SUMX ( FILTER ( Posicoes, NOT ISBLANK ( Posicoes[CustoUnitario] ) && Posicoes[Situacao] <> "Pendente" ),
           Posicoes[SaldoSistema] * Posicoes[CustoUnitario] )
Divergência % = DIVIDE ( [Absoluto R$], [Valor sistêmico R$] )
Cobertura de custo % =
    DIVIDE ( CALCULATE ( [Posições concluídas], NOT ISBLANK ( Posicoes[CustoUnitario] ) ), [Posições concluídas] )
Acuracidade 1ª contagem % =
    DIVIDE ( CALCULATE ( COUNTROWS ( Contagens ), Contagens[Etapa] = 1, Contagens[IgualAoSaldo] = "Sim" ),
             CALCULATE ( COUNTROWS ( Contagens ), Contagens[Etapa] = 1 ) )
```

`DIVIDE` devolve vazio quando o denominador é zero: o cartão mostra “(Em branco)”, nunca 0% ou 100% inventado.

### Páginas sugeridas

1. **Visão geral** — segmentação por `Inventarios[Inventario]` e `Situacao`; cartões Progresso %, Acuracidade %, Acuracidade 1ª contagem %, Cobertura de custo %, Faltas R$, Sobras R$, Absoluto R$; barras empilhadas de `Posições` por `Situacao`.
2. **Divergências** — barras agrupadas Faltas R$ × Sobras R$ por `CAMM` (e outra por `Deposito`); tabela das 15 maiores por `Absoluto R$` com Código, Localização, Saldo, Final, Diferença, Justificativa; matriz `Unidade` × `Situacao` com soma de `Diferenca` (cada unidade na sua linha).
3. **Contagens** — colunas de `Contagens` por `Contador` e `Etapa`; linha de contagens por dia (`ContadoEm`); % iguais ao saldo na 1ª contagem por `CAMM`.
4. **Histórico** (quando houver vários inventários) — linha de Acuracidade % e Absoluto R$ por `DataReferencia`.

Deixe uma caixa de texto com: “Valores só das posições com custo validado (ver Cobertura). Ajuste = proposta; o lançamento no Dynamics é feito à parte.”

## 3. Rotina

| Quando | Quem | O quê |
|---|---|---|
| Antes de cada inventário | Almoxarifado | Exporta a Lista disponível do Dynamics e importa em **Inventário › Importar lista do Dynamics** |
| Durante a contagem | Gestão | Exporta para o Power BI e atualiza o painel quantas vezes quiser (o arquivo traz “Em contagem”) |
| Depois da aprovação | Gestão | Exporta de novo e atualiza: o inventário aparece como “Aprovado” |

Atualização automática: com o arquivo no SharePoint e o painel publicado no Power BI Service, dá para agendar a atualização (Configurações do conjunto de dados › Atualização agendada). Ligar o Power BI direto no banco da VM não está previsto: exigiria um usuário de leitura dedicado e liberação da TI.
