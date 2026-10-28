-- "Minha conta": cada pessoa altera o PRÓPRIO cadastro sem depender do admin.
--   Só colunas de preferência pessoal: foto, telefone, tema, notificações e
--   preferências de acessibilidade. Perfil de acesso, grupo, e-mail e bloqueio
--   continuam sendo da administração (pol_usuario_update segue só para admin).
--   A escrita passa por uma função SECURITY DEFINER que só alcança a linha de
--   app.usuario_atual(): não existe parâmetro de "qual usuário".
BEGIN;

ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS foto text;
ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS preferencias jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_usuario_foto') THEN
    ALTER TABLE core.usuario ADD CONSTRAINT ck_usuario_foto
      CHECK (foto IS NULL OR (length(foto) <= 400000 AND foto ~ '^data:image/(jpeg|png|webp);base64,'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_usuario_preferencias') THEN
    ALTER TABLE core.usuario ADD CONSTRAINT ck_usuario_preferencias
      CHECK (jsonb_typeof(preferencias) = 'object' AND length(preferencias::text) <= 4000);
  END IF;
END $$;

COMMENT ON COLUMN core.usuario.foto IS 'Foto do perfil (data URI JPEG/PNG/WebP, até ~300 KB). Alterada pela própria pessoa em Minha conta.';
COMMENT ON COLUMN core.usuario.preferencias IS 'Preferências pessoais: nome de exibição, acessibilidade (tamanho do texto, contraste, movimento etc.). Não participa de autorização.';

CREATE OR REPLACE FUNCTION app.meu_perfil() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT jsonb_build_object('foto', u.foto, 'telefone', coalesce(u.telefone, ''), 'tema', u.tema::text,
         'notificacoes', u.notificacoes, 'preferencias', u.preferencias)
    FROM core.usuario u
   WHERE u.id = app.usuario_atual() AND app.usuario_ativo();
$$;

CREATE OR REPLACE FUNCTION app.atualizar_meu_perfil(p_foto text, p_limpar_foto boolean, p_telefone text,
  p_tema text, p_notificacoes boolean, p_preferencias jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
BEGIN
  IF app.usuario_atual() IS NULL OR NOT app.usuario_ativo() THEN
    RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501';
  END IF;
  UPDATE core.usuario u SET
    foto = CASE WHEN p_limpar_foto THEN NULL WHEN p_foto IS NOT NULL THEN p_foto ELSE u.foto END,
    telefone = CASE WHEN p_telefone IS NOT NULL THEN nullif(p_telefone, '') ELSE u.telefone END,
    tema = CASE WHEN p_tema IN ('claro', 'escuro', 'sistema') THEN p_tema::core.tema ELSE u.tema END,
    notificacoes = coalesce(p_notificacoes, u.notificacoes),
    preferencias = CASE WHEN p_preferencias IS NOT NULL THEN p_preferencias ELSE u.preferencias END
  WHERE u.id = app.usuario_atual();
  RETURN app.meu_perfil();
END $$;

REVOKE ALL ON FUNCTION app.meu_perfil(), app.atualizar_meu_perfil(text, boolean, text, text, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meu_perfil(), app.atualizar_meu_perfil(text, boolean, text, text, boolean, jsonb) TO biotrop_app;

COMMIT;
