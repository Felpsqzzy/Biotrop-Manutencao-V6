-- Foto opcional da ferramenta (pedido do Felipe, seção 4: "Foto opcional"). Mesmo padrão das fotos do catálogo do
-- almoxarifado (25): a tela reduz a foto no navegador (até 1600 px, JPEG, sem GPS nem dados do aparelho) e manda também a
-- miniatura das listas; a API confere o tipo pelos primeiros bytes (server/src/lib/imagem.js); o banco guarda imagem e
-- miniatura (bytea) e confere de novo aqui.
--   · Uma foto por ferramenta: enviar, trocar e remover só pela gestão (admin, gestor, almoxarife) no painel, pelas
--     funções emprestimo.ferramenta_foto_salvar/remover (SECURITY DEFINER). A role da API não tem DML na tabela, como no
--     resto do schema (40); as policies de escrita repetem a regra (gestão, nunca no canal do terminal).
--   · Cada envio ganha um id novo: ele vai na URL da imagem (?v=), e o navegador nunca mostra a foto antiga do cache.
--   · Leitura: a gestão vê todas; no terminal (canal 'terminal') o colaborador só vê a foto de ferramenta ATIVA.
--   · Auditoria em emprestimo.auditoria (foto_enviada, foto_trocada, foto_removida): dimensões e tamanho, nunca a imagem.
-- Idempotente: o migrate.js reaplica esta migration a cada deploy; não apaga nada da 40 nem de outra migration.
BEGIN;

CREATE TABLE IF NOT EXISTS emprestimo.ferramenta_foto (
 ferramenta_id uuid PRIMARY KEY REFERENCES emprestimo.ferramenta(id) ON DELETE CASCADE,
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),                                     -- muda a cada envio: versão na URL da imagem
 mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
 imagem bytea NOT NULL CHECK (octet_length(imagem) BETWEEN 100 AND 1200000),             -- já reduzida no navegador
 miniatura bytea NOT NULL CHECK (octet_length(miniatura) BETWEEN 100 AND 80000),         -- JPEG das listas e dos cartões do tablet
 largura integer NOT NULL DEFAULT 0 CHECK (largura BETWEEN 0 AND 10000),
 altura integer NOT NULL DEFAULT 0 CHECK (altura BETWEEN 0 AND 10000),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),                                 -- calculado aqui; vira o ETag
 enviada_por uuid NOT NULL REFERENCES core.usuario(id), enviada_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE emprestimo.ferramenta_foto IS 'Foto opcional da ferramenta (uma por ferramenta): imagem já reduzida no navegador e miniatura JPEG. Escrita só por emprestimo.ferramenta_foto_salvar/remover.';

/* ---------------------------------------------------------------- RLS */
ALTER TABLE emprestimo.ferramenta_foto ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ferramenta_foto_sel ON emprestimo.ferramenta_foto;
CREATE POLICY ferramenta_foto_sel ON emprestimo.ferramenta_foto FOR SELECT
  USING (emprestimo.gestao() OR (emprestimo.operador() AND EXISTS (SELECT 1 FROM emprestimo.ferramenta f WHERE f.id = ferramenta_foto.ferramenta_id AND f.ativo)));
-- Escrita: a role da API não tem INSERT/UPDATE/DELETE (só as funções abaixo gravam, com auditoria). As policies dizem a
-- mesma regra das funções, para o banco continuar recusando terminal e perfis de fora da gestão mesmo se um GRANT mudar.
DROP POLICY IF EXISTS ferramenta_foto_ins ON emprestimo.ferramenta_foto;
CREATE POLICY ferramenta_foto_ins ON emprestimo.ferramenta_foto FOR INSERT WITH CHECK (emprestimo.gestao());
DROP POLICY IF EXISTS ferramenta_foto_upd ON emprestimo.ferramenta_foto;
CREATE POLICY ferramenta_foto_upd ON emprestimo.ferramenta_foto FOR UPDATE USING (emprestimo.gestao()) WITH CHECK (emprestimo.gestao());
DROP POLICY IF EXISTS ferramenta_foto_del ON emprestimo.ferramenta_foto;
CREATE POLICY ferramenta_foto_del ON emprestimo.ferramenta_foto FOR DELETE USING (emprestimo.gestao());
-- a 40, reaplicada antes desta, dá SELECT em todas as tabelas do schema (também à biotrop_ro): aqui fica só a leitura da API
REVOKE ALL ON emprestimo.ferramenta_foto FROM PUBLIC, biotrop_app, biotrop_ro;
GRANT SELECT ON emprestimo.ferramenta_foto TO biotrop_app;

/* ---------------------------------------------------------------- conferência do arquivo (a mesma da API) */
-- Os primeiros bytes dizem o tipo: SVG, HTML ou qualquer outro arquivo com rótulo de JPEG não entra.
CREATE OR REPLACE FUNCTION emprestimo.imagem_valida(p_mime text, p_b bytea) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(CASE p_mime
    WHEN 'image/jpeg' THEN substring(p_b FROM 1 FOR 3) = decode('ffd8ff', 'hex')
    WHEN 'image/png'  THEN substring(p_b FROM 1 FOR 8) = decode('89504e470d0a1a0a', 'hex')
    WHEN 'image/webp' THEN substring(p_b FROM 1 FOR 4) = decode('52494646', 'hex') AND substring(p_b FROM 9 FOR 4) = decode('57454250', 'hex')
    ELSE false END, false)
$$;
REVOKE ALL ON FUNCTION emprestimo.imagem_valida(text, bytea) FROM PUBLIC;

/* ---------------------------------------------------------------- enviar / trocar e remover (só a gestão, no painel) */
CREATE OR REPLACE FUNCTION emprestimo.ferramenta_foto_salvar(p_ferramenta uuid, p_mime text, p_imagem bytea, p_miniatura bytea, p_largura integer, p_altura integer)
RETURNS TABLE(foto_id uuid, foto_largura integer, foto_altura integer, foto_tamanho integer, foto_em timestamptz, trocada boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, app, public, pg_temp AS $$
DECLARE uid uuid; f emprestimo.ferramenta%ROWTYPE; antes emprestimo.ferramenta_foto%ROWTYPE; novo emprestimo.ferramenta_foto%ROWTYPE;
BEGIN
 IF NOT app.usuario_ativo() THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501'; END IF;
 IF NOT emprestimo.gestao() THEN RAISE EXCEPTION 'Somente almoxarifado, gestão e administração.' USING ERRCODE = '42501'; END IF;
 uid := app.usuario_atual();
 IF p_imagem IS NULL OR p_miniatura IS NULL OR NOT emprestimo.imagem_valida(p_mime, p_imagem) OR NOT emprestimo.imagem_valida('image/jpeg', p_miniatura) THEN
   RAISE EXCEPTION 'A foto precisa ser uma imagem JPG, PNG ou WEBP (miniatura em JPG).' USING ERRCODE = '22023'; END IF;
 IF octet_length(p_imagem) NOT BETWEEN 100 AND 1200000 OR octet_length(p_miniatura) NOT BETWEEN 100 AND 80000 THEN
   RAISE EXCEPTION 'Foto ou miniatura fora do tamanho permitido.' USING ERRCODE = '22023'; END IF;
 -- trava a ferramenta sem travar a chave: duas trocas ao mesmo tempo entram em fila, e a retirada (que só referencia a
 -- linha) não espera
 SELECT * INTO f FROM emprestimo.ferramenta WHERE id = p_ferramenta FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ferramenta inexistente.' USING ERRCODE = 'P0002'; END IF;
 SELECT * INTO antes FROM emprestimo.ferramenta_foto WHERE ferramenta_id = f.id;
 INSERT INTO emprestimo.ferramenta_foto AS x (ferramenta_id, mime, imagem, miniatura, largura, altura, sha256, enviada_por)
 VALUES (f.id, p_mime, p_imagem, p_miniatura, least(greatest(coalesce(p_largura, 0), 0), 10000), least(greatest(coalesce(p_altura, 0), 0), 10000),
         encode(sha256(p_imagem), 'hex'), uid)
 ON CONFLICT (ferramenta_id) DO UPDATE SET id = gen_random_uuid(), mime = EXCLUDED.mime, imagem = EXCLUDED.imagem, miniatura = EXCLUDED.miniatura,
   largura = EXCLUDED.largura, altura = EXCLUDED.altura, sha256 = EXCLUDED.sha256, enviada_por = EXCLUDED.enviada_por, enviada_em = now()
 RETURNING x.* INTO novo;
 INSERT INTO emprestimo.auditoria (tipo, ferramenta_id, detalhe, por)
 VALUES (CASE WHEN antes.ferramenta_id IS NULL THEN 'foto_enviada' ELSE 'foto_trocada' END, f.id,
         jsonb_build_object('largura', novo.largura, 'altura', novo.altura, 'tamanho', octet_length(novo.imagem)), uid);
 RETURN QUERY SELECT novo.id, novo.largura, novo.altura, octet_length(novo.imagem), novo.enviada_em, antes.ferramenta_id IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION emprestimo.ferramenta_foto_remover(p_ferramenta uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, app, public, pg_temp AS $$
DECLARE uid uuid; f emprestimo.ferramenta%ROWTYPE; antes emprestimo.ferramenta_foto%ROWTYPE;
BEGIN
 IF NOT app.usuario_ativo() THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501'; END IF;
 IF NOT emprestimo.gestao() THEN RAISE EXCEPTION 'Somente almoxarifado, gestão e administração.' USING ERRCODE = '42501'; END IF;
 uid := app.usuario_atual();
 SELECT * INTO f FROM emprestimo.ferramenta WHERE id = p_ferramenta FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ferramenta inexistente.' USING ERRCODE = 'P0002'; END IF;
 DELETE FROM emprestimo.ferramenta_foto WHERE ferramenta_id = f.id RETURNING * INTO antes;
 IF NOT FOUND THEN RAISE EXCEPTION 'Esta ferramenta não tem foto.' USING ERRCODE = 'P0002'; END IF;
 INSERT INTO emprestimo.auditoria (tipo, ferramenta_id, detalhe, por)
 VALUES ('foto_removida', f.id, jsonb_build_object('largura', antes.largura, 'altura', antes.altura, 'tamanho', octet_length(antes.imagem)), uid);
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION emprestimo.ferramenta_foto_salvar(uuid, text, bytea, bytea, integer, integer), emprestimo.ferramenta_foto_remover(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emprestimo.ferramenta_foto_salvar(uuid, text, bytea, bytea, integer, integer), emprestimo.ferramenta_foto_remover(uuid) TO biotrop_app;
COMMIT;
