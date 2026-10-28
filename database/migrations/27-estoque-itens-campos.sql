-- =====================================================================================
-- 27 · Itens do estoque: mais campos por item + campos do Dynamics
--
-- A planilha do Dynamics (≈29 mil itens) traz: número do item, nome, nome de pesquisa, tipo (item/serviço), subtipo,
-- status ME (integrado / não integrar / erro), SPED fiscal, grupo de dimensões de armazenamento (SWL, WH, WMS, DEP),
-- unidade e fornecedor. O almoxarifado completa no site o que o Dynamics não tem: família (a mesma da SCI) com os
-- campos técnicos da família, preço de referência, estoque mínimo/máximo, ponto de pedido, prazo de entrega,
-- criticidade, fabricante, referência do fabricante, aplicação (onde é usado) e NCM.
-- Reimportar a planilha do Dynamics atualiza só as colunas que vieram nela: o que foi preenchido no site fica.
-- Idempotente.
-- =====================================================================================
BEGIN;

-- código do Dynamics pode ter aspas (ex.: BUCHA ALUM 1" ROSC → BUCHAALUM1"ROSC)
ALTER TABLE almox.material DROP CONSTRAINT IF EXISTS material_codigo_check;
ALTER TABLE almox.material ADD CONSTRAINT material_codigo_check CHECK (codigo ~ '^[A-Z0-9][A-Z0-9._/"-]{0,39}$');

ALTER TABLE almox.material
  ADD COLUMN IF NOT EXISTS nome_pesquisa       text          NOT NULL DEFAULT '' CHECK (length(nome_pesquisa) <= 120),
  ADD COLUMN IF NOT EXISTS tipo                text          NOT NULL DEFAULT '' CHECK (length(tipo) <= 40),
  ADD COLUMN IF NOT EXISTS subtipo             text          NOT NULL DEFAULT '' CHECK (length(subtipo) <= 40),
  ADD COLUMN IF NOT EXISTS status_me           text          NOT NULL DEFAULT '' CHECK (length(status_me) <= 40),
  ADD COLUMN IF NOT EXISTS sped                text          NOT NULL DEFAULT '' CHECK (length(sped) <= 40),
  ADD COLUMN IF NOT EXISTS armazenagem         text          NOT NULL DEFAULT '' CHECK (length(armazenagem) <= 40),
  ADD COLUMN IF NOT EXISTS fornecedor          text          NOT NULL DEFAULT '' CHECK (length(fornecedor) <= 120),
  ADD COLUMN IF NOT EXISTS familia_id          text          NOT NULL DEFAULT '' CHECK (length(familia_id) <= 80),
  ADD COLUMN IF NOT EXISTS atributos           jsonb         NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(atributos) = 'object' AND octet_length(atributos::text) <= 8000),
  ADD COLUMN IF NOT EXISTS preco               numeric(14,4) CHECK (preco IS NULL OR preco >= 0),
  ADD COLUMN IF NOT EXISTS preco_data          date,
  ADD COLUMN IF NOT EXISTS estoque_minimo      numeric(14,3) CHECK (estoque_minimo IS NULL OR estoque_minimo >= 0),
  ADD COLUMN IF NOT EXISTS estoque_maximo      numeric(14,3) CHECK (estoque_maximo IS NULL OR estoque_maximo >= 0),
  ADD COLUMN IF NOT EXISTS ponto_pedido        numeric(14,3) CHECK (ponto_pedido IS NULL OR ponto_pedido >= 0),
  ADD COLUMN IF NOT EXISTS prazo_dias          smallint      CHECK (prazo_dias IS NULL OR prazo_dias BETWEEN 0 AND 3650),
  ADD COLUMN IF NOT EXISTS criticidade         text          NOT NULL DEFAULT '' CHECK (criticidade IN ('', 'A', 'B', 'C')),
  ADD COLUMN IF NOT EXISTS fabricante          text          NOT NULL DEFAULT '' CHECK (length(fabricante) <= 120),
  ADD COLUMN IF NOT EXISTS referencia          text          NOT NULL DEFAULT '' CHECK (length(referencia) <= 120),
  ADD COLUMN IF NOT EXISTS aplicacao           text          NOT NULL DEFAULT '' CHECK (length(aplicacao) <= 500),
  ADD COLUMN IF NOT EXISTS ncm                 text          NOT NULL DEFAULT '' CHECK (ncm ~ '^[0-9.]{0,12}$');

-- prefixo do código (MAN, UCG, EPI, EMB…): é a "categoria" que o próprio código já carrega
ALTER TABLE almox.material ADD COLUMN IF NOT EXISTS prefixo text GENERATED ALWAYS AS (coalesce(substring(codigo from '^[A-Z]+'), '#')) STORED;

CREATE INDEX IF NOT EXISTS ix_material_prefixo ON almox.material (prefixo, descricao);
CREATE INDEX IF NOT EXISTS ix_material_familia ON almox.material (familia_id) WHERE familia_id <> '';
CREATE INDEX IF NOT EXISTS ix_material_descricao ON almox.material (descricao);

COMMENT ON COLUMN almox.material.prefixo IS 'Letras iniciais do código (MAN, UCG, EPI…): filtro rápido por categoria do item.';
COMMENT ON COLUMN almox.material.atributos IS 'Campos técnicos da família (os mesmos que a SCI pede), por id do campo.';
COMMENT ON COLUMN almox.material.preco IS 'Preço de referência (R$) informado pelo almoxarifado; preco_data = quando foi conferido.';

COMMIT;
