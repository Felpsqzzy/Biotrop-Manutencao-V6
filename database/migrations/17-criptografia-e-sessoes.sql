-- =====================================================================================
-- 17 · Criptografia de dados armazenados, sessões revogáveis e correções de identidade
--
--  1. seguranca.chave_dados — DEKs (chaves de dados) SEMPRE embrulhadas pela KEK do Key Vault.
--     O app só reserva uso (contador que só cresce) e aposenta; revogar/destruir/reembrulhar é
--     operação administrativa (dono do schema), separada de quem lê dados.
--  2. seguranca.evento — trilha append-only de eventos de segurança (sem dados sensíveis).
--  3. app.sessao_usuario() — CORREÇÃO: o middleware de sessão consultava core.usuario JOIN
--     core.email_autorizado sem identidade definida; sob RLS isso não devolve linha nenhuma
--     (testado em PostgreSQL real). Agora a validação da sessão passa por esta função, com
--     checagem de ativo/bloqueado/autorização e da versão da sessão.
--  4. core.usuario.sessao_versao — revogação de sessões: logout em todos os aparelhos, bloqueio,
--     troca de perfil ou de grupo invalidam na hora todo cookie emitido antes.
--  5. core.provisionar_acesso — o login passa a exigir o oid da conta Microsoft e a conferir o
--     oid já vinculado (antes, outra conta do mesmo e-mail/UPN entrava no lugar da pessoa).
--  6. core.fn_auditar — a trilha deixa de copiar foto, segredos de 2FA, hash de senha e telefone.
--  7. Foto do perfil pode ser guardada cifrada (formato bm1.).
--  8. mig.dump / mig.ocorrencia — remove senhas em texto claro que vieram da exportação do navegador.
-- Idempotente: pode ser reaplicada.
-- =====================================================================================
BEGIN;

CREATE SCHEMA IF NOT EXISTS seguranca;
REVOKE ALL ON SCHEMA seguranca FROM PUBLIC;
GRANT USAGE ON SCHEMA seguranca TO biotrop_app;

-- 1. chaves de dados ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguranca.chave_dados (
  id              uuid PRIMARY KEY,
  finalidade      text NOT NULL CHECK (finalidade ~ '^[a-z0-9-]{3,40}$'),
  kek_id          text NOT NULL CHECK (length(kek_id) BETWEEN 3 AND 300),
  dek_envelopada  bytea CHECK (dek_envelopada IS NULL OR octet_length(dek_envelopada) BETWEEN 32 AND 1024),
  estado          text NOT NULL DEFAULT 'ativa' CHECK (estado IN ('ativa', 'aposentada', 'revogada', 'destruida')),
  usos_reservados bigint NOT NULL DEFAULT 0 CHECK (usos_reservados >= 0),
  limite_usos     bigint NOT NULL CHECK (limite_usos > 0 AND limite_usos <= 4294967296),
  criada_em       timestamptz NOT NULL DEFAULT now(),
  expira_em       timestamptz NOT NULL,
  aposentada_em   timestamptz,
  revogada_em     timestamptz,
  destruida_em    timestamptz,
  CONSTRAINT ck_chave_limite CHECK (usos_reservados <= limite_usos),
  CONSTRAINT ck_chave_destruida CHECK (estado <> 'destruida' OR dek_envelopada IS NULL)
);
CREATE INDEX IF NOT EXISTS ix_chave_dados_ativa ON seguranca.chave_dados (finalidade, criada_em DESC) WHERE estado = 'ativa';
COMMENT ON TABLE seguranca.chave_dados IS 'DEKs AES-256 embrulhadas pela KEK do Azure Key Vault (nunca em claro). usos_reservados só cresce: garante o limite de cifragens por chave mesmo com várias instâncias, reinícios e restauração de backup.';

CREATE OR REPLACE FUNCTION seguranca.fn_guarda_chave() RETURNS trigger
LANGUAGE plpgsql SET search_path = seguranca, pg_temp AS $$
BEGIN
  IF current_user = 'biotrop_app' THEN
    IF NEW.id <> OLD.id OR NEW.finalidade <> OLD.finalidade OR NEW.kek_id <> OLD.kek_id
       OR NEW.dek_envelopada IS DISTINCT FROM OLD.dek_envelopada OR NEW.limite_usos <> OLD.limite_usos
       OR NEW.expira_em <> OLD.expira_em THEN
      RAISE EXCEPTION 'O aplicativo não altera material de chave.' USING ERRCODE = '42501';
    END IF;
    IF NEW.usos_reservados < OLD.usos_reservados THEN
      RAISE EXCEPTION 'Contador de uso de chave não pode diminuir.' USING ERRCODE = '42501';
    END IF;
    IF NEW.estado <> OLD.estado AND NOT (OLD.estado = 'ativa' AND NEW.estado = 'aposentada') THEN
      RAISE EXCEPTION 'O aplicativo só pode aposentar chaves.' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.usos_reservados < OLD.usos_reservados THEN
    RAISE EXCEPTION 'Contador de uso de chave não pode diminuir.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_guarda_chave ON seguranca.chave_dados;
CREATE TRIGGER tg_guarda_chave BEFORE UPDATE ON seguranca.chave_dados FOR EACH ROW EXECUTE FUNCTION seguranca.fn_guarda_chave();

ALTER TABLE seguranca.chave_dados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_chave_app_select ON seguranca.chave_dados;
DROP POLICY IF EXISTS pol_chave_app_insert ON seguranca.chave_dados;
DROP POLICY IF EXISTS pol_chave_app_update ON seguranca.chave_dados;
CREATE POLICY pol_chave_app_select ON seguranca.chave_dados FOR SELECT TO biotrop_app USING (true);
CREATE POLICY pol_chave_app_insert ON seguranca.chave_dados FOR INSERT TO biotrop_app
  WITH CHECK (estado = 'ativa' AND usos_reservados = 0 AND dek_envelopada IS NOT NULL);
CREATE POLICY pol_chave_app_update ON seguranca.chave_dados FOR UPDATE TO biotrop_app USING (estado = 'ativa') WITH CHECK (true);
REVOKE ALL ON seguranca.chave_dados FROM PUBLIC;
GRANT SELECT, INSERT ON seguranca.chave_dados TO biotrop_app;
GRANT UPDATE (usos_reservados, estado, aposentada_em) ON seguranca.chave_dados TO biotrop_app;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'biotrop_ro') THEN EXECUTE 'REVOKE ALL ON seguranca.chave_dados FROM biotrop_ro'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'biotrop_worker') THEN EXECUTE 'REVOKE ALL ON seguranca.chave_dados FROM biotrop_worker'; END IF;
END $$;

-- 2. eventos de segurança -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seguranca.evento (
  id         bigserial PRIMARY KEY,
  tipo       text NOT NULL CHECK (tipo ~ '^[a-z0-9_.-]{3,60}$'),
  usuario_id uuid,
  detalhe    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detalhe) = 'object' AND length(detalhe::text) <= 2000),
  em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_evento_em ON seguranca.evento (em DESC);
CREATE INDEX IF NOT EXISTS ix_evento_tipo ON seguranca.evento (tipo, em DESC);
COMMENT ON TABLE seguranca.evento IS 'Eventos de segurança (sessão encerrada, dado cifrado recusado, operação de chave, step-up). Append-only; nunca guarda texto claro sensível, tokens ou chaves.';
ALTER TABLE seguranca.evento ENABLE ROW LEVEL SECURITY;
ALTER TABLE seguranca.evento FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_evento_insert ON seguranca.evento;
DROP POLICY IF EXISTS pol_evento_select ON seguranca.evento;
DROP POLICY IF EXISTS pol_evento_dono ON seguranca.evento;
CREATE POLICY pol_evento_insert ON seguranca.evento FOR INSERT TO biotrop_app
  WITH CHECK (usuario_id IS NULL OR usuario_id = app.usuario_atual());
CREATE POLICY pol_evento_select ON seguranca.evento FOR SELECT TO biotrop_app USING (app.eh_admin());
CREATE POLICY pol_evento_dono ON seguranca.evento FOR ALL
  USING (current_user = (SELECT tableowner FROM pg_tables WHERE schemaname = 'seguranca' AND tablename = 'evento'))
  WITH CHECK (current_user = (SELECT tableowner FROM pg_tables WHERE schemaname = 'seguranca' AND tablename = 'evento'));
REVOKE ALL ON seguranca.evento FROM PUBLIC;
GRANT SELECT, INSERT ON seguranca.evento TO biotrop_app;
GRANT USAGE ON SEQUENCE seguranca.evento_id_seq TO biotrop_app;

-- 4. versão da sessão -----------------------------------------------------------------
ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS sessao_versao integer NOT NULL DEFAULT 1;
COMMENT ON COLUMN core.usuario.sessao_versao IS 'Todo cookie de sessão carrega esta versão. Incrementar invalida na hora as sessões anteriores (sair de todos os aparelhos, bloqueio, troca de perfil/grupo).';

CREATE OR REPLACE FUNCTION core.fn_usuario_sessao() RETURNS trigger
LANGUAGE plpgsql SET search_path = core, pg_temp AS $$
BEGIN
  IF (NEW.bloqueado AND NOT OLD.bloqueado) OR NEW.ativo IS DISTINCT FROM OLD.ativo
     OR NEW.perfil_id IS DISTINCT FROM OLD.perfil_id OR NEW.grupo_id IS DISTINCT FROM OLD.grupo_id
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.entra_object_id IS DISTINCT FROM OLD.entra_object_id AND OLD.entra_object_id IS NOT NULL THEN
    NEW.sessao_versao := OLD.sessao_versao + 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_usuario_sessao ON core.usuario;
CREATE TRIGGER tg_usuario_sessao BEFORE UPDATE ON core.usuario FOR EACH ROW EXECUTE FUNCTION core.fn_usuario_sessao();

-- 3. validação da sessão (substitui o SELECT direto do middleware) ---------------------
CREATE OR REPLACE FUNCTION app.sessao_usuario(p_id uuid)
RETURNS TABLE (id uuid, nome text, email text, perfil_id text, grupo_id uuid, "time" text, telefone text, sessao_versao integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT u.id, u.nome::text, u.email::text, u.perfil_id::text, u.grupo_id, u.time::text, u.telefone::text, u.sessao_versao
    FROM core.usuario u
    JOIN core.email_autorizado a ON a.email = u.email
   WHERE u.id = p_id AND u.ativo AND NOT u.bloqueado AND a.ativo
   LIMIT 1;
$$;
COMMENT ON FUNCTION app.sessao_usuario(uuid) IS 'Valida a sessão a cada requisição: usuário ativo, não bloqueado e com e-mail autorizado. Devolve a versão da sessão para o app comparar com a do cookie. Roda antes de existir identidade na transação (por isso SECURITY DEFINER).';
REVOKE ALL ON FUNCTION app.sessao_usuario(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sessao_usuario(uuid) TO biotrop_app;

CREATE OR REPLACE FUNCTION app.encerrar_minhas_sessoes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE v integer;
BEGIN
  IF app.usuario_atual() IS NULL THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501'; END IF;
  UPDATE core.usuario SET sessao_versao = sessao_versao + 1 WHERE id = app.usuario_atual() RETURNING sessao_versao INTO v;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION app.encerrar_sessoes_de(p_usuario uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE v integer;
BEGIN
  IF NOT app.eh_admin() THEN RAISE EXCEPTION 'Somente administradores.' USING ERRCODE = '42501'; END IF;
  UPDATE core.usuario SET sessao_versao = sessao_versao + 1 WHERE id = p_usuario RETURNING sessao_versao INTO v;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION app.encerrar_minhas_sessoes(), app.encerrar_sessoes_de(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.encerrar_minhas_sessoes(), app.encerrar_sessoes_de(uuid) TO biotrop_app;

-- 5. login amarrado ao oid da conta Microsoft -----------------------------------------
CREATE OR REPLACE FUNCTION core.provisionar_acesso(
  p_email citext, p_nome text DEFAULT NULL, p_entra_oid uuid DEFAULT NULL, p_ip inet DEFAULT NULL, p_user_agent text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE
  v_pode record; v_aut core.email_autorizado; v_usu core.usuario; v_perfil text; v_novo boolean := false;
BEGIN
  IF p_email IS NULL OR position('@' in p_email::text) < 2 THEN
    RAISE EXCEPTION 'E-mail invalido para provisionamento de acesso' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Sem oid não há como saber QUAL conta Microsoft entrou: recusado.
  IF p_entra_oid IS NULL THEN
    INSERT INTO core.login_evento (email, usuario_id, sucesso, motivo, ip, user_agent)
    VALUES (p_email, NULL, false, 'token sem oid da conta Microsoft', p_ip, p_user_agent);
    RETURN NULL;
  END IF;

  SELECT * INTO v_pode FROM core.pode_autenticar(p_email);
  IF NOT coalesce(v_pode.permitido, false) THEN
    INSERT INTO core.login_evento (email, usuario_id, sucesso, motivo, ip, user_agent)
    VALUES (p_email, v_pode.usuario_id, false, coalesce(v_pode.motivo, 'acesso recusado'), p_ip, p_user_agent);
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM core.usuario u WHERE u.entra_object_id = p_entra_oid AND u.email <> p_email) THEN
    INSERT INTO core.login_evento (email, usuario_id, sucesso, motivo, ip, user_agent)
    VALUES (p_email, NULL, false, 'entra_object_id do token ja pertence a outro usuario', p_ip, p_user_agent);
    RETURN NULL;
  END IF;

  SELECT * INTO v_usu FROM core.usuario WHERE email = p_email;

  -- Conta já vinculada a OUTRO oid: outra conta Microsoft com o mesmo e-mail/UPN (convidado,
  -- caixa reatribuída) não assume a identidade da pessoa. A TI desvincula se for troca legítima.
  IF v_usu.id IS NOT NULL AND v_usu.entra_object_id IS NOT NULL AND v_usu.entra_object_id <> p_entra_oid THEN
    INSERT INTO core.login_evento (email, usuario_id, sucesso, motivo, ip, user_agent)
    VALUES (p_email, v_usu.id, false, 'conta Microsoft diferente da vinculada a este usuario', p_ip, p_user_agent);
    RETURN NULL;
  END IF;

  IF v_usu.id IS NULL THEN
    SELECT * INTO v_aut FROM core.email_autorizado WHERE email = p_email AND ativo;
    IF v_aut.email IS NULL THEN
      INSERT INTO core.login_evento (email, usuario_id, sucesso, motivo, ip, user_agent)
      VALUES (p_email, NULL, false, 'autorizacao ausente ou revogada no momento do provisionamento', p_ip, p_user_agent);
      RETURN NULL;
    END IF;
    SELECT p.id INTO v_perfil FROM core.perfil p WHERE p.id = v_aut.perfil_padrao AND p.ativo;
    v_perfil := coalesce(v_perfil, 'viewer');
    INSERT INTO core.usuario (nome, email, entra_object_id, perfil_id, grupo_id, ultimo_login_em)
    VALUES (coalesce(nullif(btrim(p_nome), ''), split_part(p_email::text, '@', 1)), p_email, p_entra_oid, v_perfil, v_aut.grupo_padrao, now())
    ON CONFLICT (email) DO UPDATE
      SET ultimo_login_em = now(),
          entra_object_id = coalesce(usuario.entra_object_id, EXCLUDED.entra_object_id)
    RETURNING * INTO v_usu;
    IF v_usu.entra_object_id <> p_entra_oid THEN   -- corrida com outra conta: não entra
      INSERT INTO core.login_evento (email, usuario_id, sucesso, motivo, ip, user_agent)
      VALUES (p_email, v_usu.id, false, 'conta Microsoft diferente da vinculada a este usuario', p_ip, p_user_agent);
      RETURN NULL;
    END IF;
    v_novo := (v_usu.criado_em = v_usu.ultimo_login_em);
  ELSE
    UPDATE core.usuario SET ultimo_login_em = now(), entra_object_id = coalesce(entra_object_id, p_entra_oid)
     WHERE id = v_usu.id RETURNING * INTO v_usu;
  END IF;

  INSERT INTO core.login_evento (email, usuario_id, sucesso, motivo, ip, user_agent)
  VALUES (p_email, v_usu.id, true,
          CASE WHEN v_novo THEN 'primeiro acesso: usuario provisionado com perfil ' || v_usu.perfil_id ELSE 'ok' END,
          p_ip, p_user_agent);
  RETURN v_usu.id;
END $$;
REVOKE ALL ON FUNCTION core.provisionar_acesso(citext, text, uuid, inet, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.provisionar_acesso(citext, text, uuid, inet, text) TO biotrop_app;

-- 6. auditoria sem foto, segredos e telefone -------------------------------------------
-- search_path fixo e sem depender do tipo citext por nome: a trigger roda também dentro de funções
-- SECURITY DEFINER com search_path = core, pg_temp (ex.: app.atualizar_meu_perfil), onde "citext" não
-- é encontrado — antes isso derrubava o salvamento de "Minha conta" numa conexão nova.
CREATE OR REPLACE FUNCTION core.fn_auditar() RETURNS trigger
LANGUAGE plpgsql SET search_path = core, pg_temp AS $$
DECLARE
  v_id text; v_email text; v_antes jsonb; v_depois jsonb;
  -- Campos que nunca entram na trilha (bytes de foto, material de 2FA, hash de senha, telefone cifrado).
  v_omitir text[] := ARRAY['foto', 'totp_segredo', 'totp_pendente', 'totp_recuperacao', 'senha_hash', 'telefone'];
BEGIN
  BEGIN v_email := nullif(current_setting('app.usuario_email', true), '');
  EXCEPTION WHEN others THEN v_email := NULL; END;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_antes := to_jsonb(OLD) - v_omitir; END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN v_depois := to_jsonb(NEW) - v_omitir; END IF;
  IF TG_OP = 'DELETE' THEN
    v_id := coalesce(to_jsonb(OLD) ->> 'id', v_antes::text);
    INSERT INTO core.auditoria (tabela, registro_id, operacao, antes, ator_email)
    VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_id, 'D', v_antes, v_email);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NEW; END IF;
    v_id := coalesce(to_jsonb(NEW) ->> 'id', v_depois::text);
    INSERT INTO core.auditoria (tabela, registro_id, operacao, antes, depois, ator_email)
    VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_id, 'U', v_antes, v_depois, v_email);
    RETURN NEW;
  ELSE
    v_id := coalesce(to_jsonb(NEW) ->> 'id', v_depois::text);
    INSERT INTO core.auditoria (tabela, registro_id, operacao, depois, ator_email)
    VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_id, 'I', v_depois, v_email);
    RETURN NEW;
  END IF;
END $$;
COMMENT ON FUNCTION core.fn_auditar() IS 'Trigger AFTER I/U/D: grava a linha em core.auditoria SEM foto, material de 2FA, hash de senha e telefone (esses dados não devem se multiplicar na trilha).';

-- Linhas antigas da trilha que já carregam esses campos.
UPDATE core.auditoria
   SET antes = CASE WHEN antes IS NULL THEN NULL ELSE antes - ARRAY['foto', 'totp_segredo', 'totp_pendente', 'totp_recuperacao', 'senha_hash', 'telefone'] END,
       depois = CASE WHEN depois IS NULL THEN NULL ELSE depois - ARRAY['foto', 'totp_segredo', 'totp_pendente', 'totp_recuperacao', 'senha_hash', 'telefone'] END
 WHERE tabela = 'core.usuario'
   AND ((antes ?| ARRAY['foto', 'totp_segredo', 'totp_pendente', 'totp_recuperacao', 'senha_hash', 'telefone'])
     OR (depois ?| ARRAY['foto', 'totp_segredo', 'totp_pendente', 'totp_recuperacao', 'senha_hash', 'telefone']));

-- 7. foto do perfil cifrada -------------------------------------------------------------
ALTER TABLE core.usuario DROP CONSTRAINT IF EXISTS ck_usuario_foto;
ALTER TABLE core.usuario ADD CONSTRAINT ck_usuario_foto CHECK (
  foto IS NULL OR (length(foto) <= 560000 AND (foto ~ '^data:image/(jpeg|png|webp);base64,' OR foto ~ '^bm1\.[A-Za-z0-9_-]+$')));

-- 8. senhas em claro na importação antiga ------------------------------------------------
CREATE OR REPLACE FUNCTION seguranca.remover_chaves(j jsonb, chaves text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = seguranca, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(j) = 'object' THEN
    SELECT coalesce(jsonb_object_agg(k, seguranca.remover_chaves(v, chaves)), '{}'::jsonb) INTO r
      FROM jsonb_each(j) AS e(k, v) WHERE NOT (lower(k) = ANY (chaves));
    RETURN r;
  ELSIF jsonb_typeof(j) = 'array' THEN
    SELECT coalesce(jsonb_agg(seguranca.remover_chaves(v, chaves) ORDER BY i), '[]'::jsonb) INTO r
      FROM jsonb_array_elements(j) WITH ORDINALITY AS a(v, i);
    RETURN r;
  END IF;
  RETURN j;
END $$;
REVOKE ALL ON FUNCTION seguranca.remover_chaves(jsonb, text[]) FROM PUBLIC;
DO $$ BEGIN
  IF to_regclass('mig.dump') IS NOT NULL THEN
    EXECUTE $q$UPDATE mig.dump SET conteudo = seguranca.remover_chaves(conteudo, ARRAY['senha', 'password', 'senha_hash'])
             WHERE conteudo::text ~* '"(senha|password|senha_hash)"'$q$;
  END IF;
  IF to_regclass('mig.ocorrencia') IS NOT NULL THEN
    EXECUTE $q$UPDATE mig.ocorrencia SET dado = seguranca.remover_chaves(dado, ARRAY['senha', 'password', 'senha_hash'])
             WHERE dado::text ~* '"(senha|password|senha_hash)"'$q$;
  END IF;
END $$;

-- 9. regravação do segredo 2FA do formato antigo para o novo (só a própria linha, só se não mudou) --------
CREATE OR REPLACE FUNCTION app.twofa_regravar_segredo(p_antigo text, p_novo text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF p_novo IS NULL OR p_novo !~ '^bm1\.[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Formato de segredo inválido.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE core.usuario SET totp_segredo = p_novo
   WHERE id = app.usuario_atual() AND app.usuario_ativo() AND totp_ativo AND totp_segredo = p_antigo;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;
REVOKE ALL ON FUNCTION app.twofa_regravar_segredo(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.twofa_regravar_segredo(text, text) TO biotrop_app;

COMMIT;
