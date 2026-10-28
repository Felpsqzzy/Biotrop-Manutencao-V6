# Roteiro de teste dos fluxos (SCM, SCI e Treinamentos)

Atualizado em 05/10/2026. Use antes de liberar o uso. A parte automática já roda a cada mudança
(`npm --prefix server run test:integracao`, arquivo `server/test-integracao/fluxos.test.js`). Este roteiro é a
conferência manual, com pessoas de verdade em cada perfil, no ambiente de homologação.

## Preparação

1. Migrations 21 a 31 aplicadas no banco de homologação.
2. Em **Administração › Grupos**, cada grupo com o responsável certo:
   - Manutenção e Predial: Rodrigo Lara.
   - Automação: Gilmar.
   - Pelo menos um grupo sem responsável, para testar a aprovação pela gestão.
3. Contas de teste (não use pedidos reais):

   | Papel | Perfil | Grupo |
   |---|---|---|
   | Solicitante A | técnico | Manutenção |
   | Solicitante B | técnico | Automação |
   | Responsável de Manutenção | líder | Manutenção |
   | Responsável de Automação | líder | Automação |
   | Almoxarife | almoxarife | — |
   | PCM | pcm | — |
   | Gestor | gestor | — |

4. Para testar e-mail: `EMAIL_MOTIVOS_ATIVOS` com `lms_certificado` e `lms_cobranca_gestor`.

Marque cada linha: ✅ deu certo · ❌ não deu (anote o que apareceu).

## SCM — caminho principal

| # | Quem | Faz | Esperado | ✅/❌ |
|---|---|---|---|---|
| 1 | Solicitante A | Nova solicitação de compra, CAPEX sem nº do projeto | Não deixa enviar: pede o nº do projeto | |
| 2 | Solicitante A | OM "48601" | Completa para OM00048601 | |
| 3 | Solicitante A | Fornecedor "Exclusivo" sem nome | Pede o nome do fornecedor | |
| 4 | Solicitante A | Envia a SCM com 2 itens | Status "Aguardando aprovação". O sino do Responsável de Manutenção mostra "aguarda sua aprovação" | |
| 5 | Responsável de Automação | Procura a SCM | Não aparece para ele | |
| 6 | Responsável de Manutenção | Pedir revisão sem escrever nada | Não deixa | |
| 7 | Responsável de Manutenção | Pedir revisão com o motivo | Volta para o Solicitante A, com aviso no sino | |
| 8 | Solicitante A | Corrige o item e reenvia | Volta para aprovação | |
| 9 | Responsável de Manutenção | Aprova | "Aprovada". O sino do almoxarife mostra "abrir a RC" | |
| 10 | Solicitante A | Tenta editar a SCM aprovada | Não consegue | |
| 11 | Almoxarife | Pede revisão ao solicitante | Status "Revisão solicitada pelo almoxarifado" | |
| 12 | Solicitante A | Corrige e reenvia | Volta direto ao almoxarifado, sem passar pela aprovação de novo | |
| 13 | Almoxarife | Abrir RC sem nº do ME | Não deixa | |
| 14 | Almoxarife | Abrir RC parcial marcando só o item 1 | "RC aberta parcial"; item 2 "Fora da RC" | |
| 15 | Almoxarife | Item 2 recebe o código cadastrado e entra na RC | "RC aberta"; o código original do item fica guardado | |
| 16 | Almoxarife | Concluir | "Concluída" | |

## SCM — serviço e casos de borda

| # | Quem | Faz | Esperado | ✅/❌ |
|---|---|---|---|---|
| 17 | Solicitante do grupo sem responsável | Abre SCM | O sino do Gestor mostra a aprovação | |
| 18 | Solicitante B | SCM "Contratação de Serviço (PCM)" aprovada pelo responsável de Automação | Aparece na Gestão de SCM do PCM | |
| 19 | PCM | Abre a RC dessa SCM com o nº do ME | Funciona. Antes desta correção o banco recusava | |
| 20 | PCM | Procura uma SCM de material | Não aparece na Gestão de SCM dele | |
| 21 | Responsável | Reprova sem motivo, depois de já ter pedido revisão | Não deixa: o motivo antigo não vale | |
| 22 | Duas pessoas | Abrem a mesma SCM e salvam ao mesmo tempo | A segunda recebe "alterado por outro usuário", sem apagar a primeira | |

## SCI

| # | Quem | Faz | Esperado | ✅/❌ |
|---|---|---|---|---|
| 23 | Solicitante A | Nova SCI sem preencher um campo obrigatório da família | Não deixa enviar | |
| 24 | PCM | Procura Gestão de SCI | Não existe no menu | |
| 25 | Almoxarife | Encaminha para cadastro sem o nº da solicitação | Não deixa | |
| 26 | Almoxarife | Pede correção com o motivo | Solicitante edita e reenvia | |
| 27 | Almoxarife | Marca "Cadastrado" com o código | O código novo entra nas SCMs que usavam o nº da SCI | |

## Treinamentos

| # | Quem | Faz | Esperado | ✅/❌ |
|---|---|---|---|---|
| 28 | Gestor | Cria um curso escolhendo Área e Tipo, depois publica | Aparece no catálogo, no filtro da área | |
| 29 | Técnico | Conclui o curso | "Meus certificados" mostra o certificado com a revisão. Chega e-mail para ele, com o responsável do grupo em cópia | |
| 30 | Gestor | Acompanhamento › Por curso › clica no curso | Lista de quem fez, com nota, data e certificado | |
| 31 | Gestor | Filtra por Gestor e depois "Limpar filtros" | Filtra e volta | |
| 32 | Gestor | Muda uma aula e salva | Pede o que mudou (nova revisão) | |
| 33 | Gestor | Revisão marcando "quem já concluiu precisa refazer" | O técnico vê "Nova revisão: refazer" e consegue refazer. O certificado antigo fica no histórico | |
| 34 | Gestor | Tenta excluir um curso | Só há "Desativar"; o histórico continua | |

## Notificações

| # | Quem | Esperado | ✅/❌ |
|---|---|---|---|
| 35 | PCM, de manhã | Sino com "Ontem N medidores ficaram sem apontamento"; clicar abre Pendências | |
| 36 | Qualquer pessoa | "Marcar todas como lidas" zera o número do sino | |
