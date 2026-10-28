-- =====================================================================================
-- 30 · Itens do estoque: ficha completa do item (pedido de 05/10/2026)
--
-- A ficha do almoxarifado passa a ter, além do que já existia (código, descrição, unidade, família, status,
-- fotos): descrição longa, marcas homologadas e pontos de atenção no recebimento. São campos do site: a
-- importação do Dynamics não os sobrescreve (só grava as colunas que vierem na planilha).
-- Edição continua só com almoxarifado, gestão e administração (app.catalogo_escrita, migration 25).
-- Idempotente.
-- =====================================================================================
BEGIN;

ALTER TABLE almox.material
  ADD COLUMN IF NOT EXISTS descricao_longa     text NOT NULL DEFAULT '' CHECK (length(descricao_longa) <= 4000),
  ADD COLUMN IF NOT EXISTS marcas_homologadas  text NOT NULL DEFAULT '' CHECK (length(marcas_homologadas) <= 500),
  ADD COLUMN IF NOT EXISTS pontos_recebimento  text NOT NULL DEFAULT '' CHECK (length(pontos_recebimento) <= 2000),
  ADD COLUMN IF NOT EXISTS ciclo_vida          text NOT NULL DEFAULT '' CHECK (length(ciclo_vida) <= 60);

COMMENT ON COLUMN almox.material.descricao_longa IS 'Descrição técnica completa do item (a "descricao" é a curta, a que aparece nas listas).';
COMMENT ON COLUMN almox.material.marcas_homologadas IS 'Marcas aceitas na compra, separadas por vírgula. Vazio = qualquer marca.';
COMMENT ON COLUMN almox.material.ciclo_vida IS 'Estado do ciclo de vida do produto no Dynamics (Produto Ativo, Produto Inativo, Phase Out, em Cadastro…).';
COMMENT ON COLUMN almox.material.pontos_recebimento IS 'O que o almoxarifado confere ao receber o item (certificado, lote, validade, medida, embalagem...).';

COMMIT;
