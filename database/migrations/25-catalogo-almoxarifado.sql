-- =====================================================================================
-- 25 · Catálogo de itens do almoxarifado (~30 mil itens com código MAN, foto e busca por nome)
--
-- O almoxarifado carrega a lista de itens (planilha do estoque / Dynamics) e as fotos; todo mundo que pede
-- material (SCI/SCM) consulta: busca por nome ou código, abre o item e vê a foto. Os pedidos ligam ao item
-- pelo código MAN que já informam ("Código Sistema" da SCM, "Código do item" da SCI).
--
--   almox.material        um item por código MAN (busca por palavra com índice, sem diferenciar acento)
--   almox.material_foto   fotos do item (imagem + miniatura), guardadas no banco
--   almox.material_carga  registro de cada importação da planilha (quem, quando, quantos)
--
-- Leitura: quem está ativo e usa o almoxarifado (admin, gestor, pcm, almoxarife, líder, técnico).
-- Escrita (importar, editar, fotos): almoxarife, gestor e admin — como os cadastros dos formulários (migration 24).
-- Idempotente.
-- =====================================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS almox.material (
  codigo               text        PRIMARY KEY CHECK (codigo ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  descricao            text        NOT NULL CHECK (length(descricao) BETWEEN 1 AND 500),
  unidade              text        NOT NULL DEFAULT '' CHECK (length(unidade) <= 20),
  grupo                text        NOT NULL DEFAULT '' CHECK (length(grupo) <= 120),
  marca                text        NOT NULL DEFAULT '' CHECK (length(marca) <= 120),
  localizacao          text        NOT NULL DEFAULT '' CHECK (length(localizacao) <= 120),
  observacao           text        NOT NULL DEFAULT '' CHECK (length(observacao) <= 2000),
  ativo                boolean     NOT NULL DEFAULT true,
  -- texto de busca sem acento e em minúsculas (montado pela API); o índice é sobre ele
  busca_texto          text        NOT NULL DEFAULT '',
  busca                tsvector    GENERATED ALWAYS AS (to_tsvector('simple', busca_texto)) STORED,
  fotos                smallint    NOT NULL DEFAULT 0,
  foto_capa            uuid,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_por_nome  text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_material_busca ON almox.material USING gin (busca);
CREATE INDEX IF NOT EXISTS ix_material_grupo ON almox.material (grupo) WHERE ativo;
CREATE INDEX IF NOT EXISTS ix_material_codigo_prefixo ON almox.material (codigo text_pattern_ops);

CREATE TABLE IF NOT EXISTS almox.material_foto (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo            text        NOT NULL REFERENCES almox.material(codigo) ON UPDATE CASCADE ON DELETE CASCADE,
  mime              text        NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp', 'image/png')),
  imagem            bytea       NOT NULL CHECK (octet_length(imagem) BETWEEN 100 AND 1600000),
  miniatura         bytea       NOT NULL CHECK (octet_length(miniatura) BETWEEN 100 AND 80000),
  largura           smallint    NOT NULL DEFAULT 0,
  altura            smallint    NOT NULL DEFAULT 0,
  sha256            text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  posicao           smallint    NOT NULL DEFAULT 0,
  enviado_por       uuid        REFERENCES core.usuario(id) ON DELETE SET NULL,
  enviado_por_nome  text        NOT NULL DEFAULT '',
  criado_em         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (codigo, sha256)
);
CREATE INDEX IF NOT EXISTS ix_material_foto_codigo ON almox.material_foto (codigo, posicao);

CREATE TABLE IF NOT EXISTS almox.material_carga (
  id           bigserial   PRIMARY KEY,
  arquivo      text        NOT NULL DEFAULT '',
  linhas       integer     NOT NULL DEFAULT 0,
  novos        integer     NOT NULL DEFAULT 0,
  atualizados  integer     NOT NULL DEFAULT 0,
  recusados    integer     NOT NULL DEFAULT 0,
  por          uuid        REFERENCES core.usuario(id) ON DELETE SET NULL,
  por_nome     text        NOT NULL DEFAULT '',
  em           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE almox.material IS 'Catálogo de itens do almoxarifado (código MAN). Busca por palavra em busca_texto (sem acento); pedidos SCI/SCM ligam pelo código.';
COMMENT ON TABLE almox.material_foto IS 'Fotos dos itens do catálogo: imagem (até ~1,5 MB, já reduzida no navegador) e miniatura para as listas.';
COMMENT ON TABLE almox.material_carga IS 'Cada importação da planilha de itens: arquivo, quantidades e quem importou.';

CREATE OR REPLACE FUNCTION app.catalogo_leitura() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.usuario_ativo() AND app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife','lider','tecnico'])
$$;
CREATE OR REPLACE FUNCTION app.catalogo_escrita() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.usuario_ativo() AND app.tem_perfil(ARRAY['admin','gestor','almoxarife'])
$$;
REVOKE ALL ON FUNCTION app.catalogo_leitura(), app.catalogo_escrita() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalogo_leitura(), app.catalogo_escrita() TO biotrop_app, biotrop_ro;

GRANT SELECT, INSERT, UPDATE, DELETE ON almox.material, almox.material_foto TO biotrop_app;
GRANT SELECT, INSERT ON almox.material_carga TO biotrop_app;
GRANT USAGE, SELECT ON SEQUENCE almox.material_carga_id_seq TO biotrop_app;
GRANT SELECT ON almox.material, almox.material_carga TO biotrop_ro;

ALTER TABLE almox.material       ENABLE ROW LEVEL SECURITY;
ALTER TABLE almox.material_foto  ENABLE ROW LEVEL SECURITY;
ALTER TABLE almox.material_carga ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE v_tab text;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY['material', 'material_foto'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_sel', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR SELECT TO biotrop_app, biotrop_ro USING (app.catalogo_leitura())', v_tab || '_sel', v_tab);
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_ins', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR INSERT TO biotrop_app WITH CHECK (app.catalogo_escrita())', v_tab || '_ins', v_tab);
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_upd', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR UPDATE TO biotrop_app USING (app.catalogo_escrita()) WITH CHECK (app.catalogo_escrita())', v_tab || '_upd', v_tab);
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_del', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR DELETE TO biotrop_app USING (app.catalogo_escrita())', v_tab || '_del', v_tab);
  END LOOP;
END $$;

DROP POLICY IF EXISTS material_carga_sel ON almox.material_carga;
CREATE POLICY material_carga_sel ON almox.material_carga FOR SELECT TO biotrop_app, biotrop_ro USING (app.catalogo_escrita());
DROP POLICY IF EXISTS material_carga_ins ON almox.material_carga;
CREATE POLICY material_carga_ins ON almox.material_carga FOR INSERT TO biotrop_app
  WITH CHECK (app.catalogo_escrita() AND por = app.usuario_atual());

COMMIT;
