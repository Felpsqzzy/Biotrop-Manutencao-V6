-- Verificação em duas etapas do próprio sistema (aplicativo autenticador).
--   O login continua pela Microsoft; este segundo fator é pedido antes de ações
--   sensíveis (dados de contato, desativar a própria verificação, novos códigos).
--   O segredo fica CIFRADO pela aplicação (AES-256-GCM) e os códigos de
--   recuperação só como hash. Todas as funções alcançam apenas a linha da sessão.
BEGIN;

ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS totp_segredo text;
ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS totp_pendente text;
ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS totp_ativo boolean NOT NULL DEFAULT false;
ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS totp_ultimo_passo bigint NOT NULL DEFAULT 0;
ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS totp_recuperacao text[] NOT NULL DEFAULT '{}';
ALTER TABLE core.usuario ADD COLUMN IF NOT EXISTS totp_ativado_em timestamptz;

COMMENT ON COLUMN core.usuario.totp_segredo IS 'Segredo TOTP cifrado pela aplicação. Nunca vai para o navegador depois de ativado.';
COMMENT ON COLUMN core.usuario.totp_recuperacao IS 'Hashes (HMAC-SHA256) dos códigos de recuperação ainda não usados.';

-- Proteção destas colunas: o segredo é cifrado com chave que só existe no .env da VM
-- e os códigos de recuperação são hashes. Um REVOKE de coluna aqui não teria efeito,
-- porque a role da aplicação tem SELECT de tabela (privilégio de tabela vence o de coluna).

CREATE OR REPLACE FUNCTION app.twofa_estado() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT jsonb_build_object('ativo', u.totp_ativo, 'pendente', u.totp_pendente IS NOT NULL,
         'segredo', u.totp_segredo, 'pendente_segredo', u.totp_pendente, 'ultimo_passo', u.totp_ultimo_passo,
         'recuperacao', to_jsonb(u.totp_recuperacao), 'ativado_em', u.totp_ativado_em)
    FROM core.usuario u WHERE u.id = app.usuario_atual() AND app.usuario_ativo();
$$;

CREATE OR REPLACE FUNCTION app.twofa_iniciar(p_segredo text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_temp AS $$
  UPDATE core.usuario SET totp_pendente = p_segredo WHERE id = app.usuario_atual() AND app.usuario_ativo();
$$;

CREATE OR REPLACE FUNCTION app.twofa_ativar(p_passo bigint, p_recuperacao text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_temp AS $$
  UPDATE core.usuario SET totp_segredo = totp_pendente, totp_pendente = NULL, totp_ativo = true,
         totp_ultimo_passo = p_passo, totp_recuperacao = p_recuperacao, totp_ativado_em = now()
   WHERE id = app.usuario_atual() AND app.usuario_ativo() AND totp_pendente IS NOT NULL;
$$;

-- DROP é necessário porque PostgreSQL não permite trocar RETURNS void por boolean
-- com CREATE OR REPLACE em uma VM onde uma versão anterior da migration foi testada.
DROP FUNCTION IF EXISTS app.twofa_registrar_passo(bigint);
CREATE FUNCTION app.twofa_registrar_passo(p_passo bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  UPDATE core.usuario SET totp_ultimo_passo = p_passo
   WHERE id = app.usuario_atual() AND app.usuario_ativo()
     AND totp_ativo AND totp_ultimo_passo < p_passo;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION app.twofa_usar_recuperacao(p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  UPDATE core.usuario SET totp_recuperacao = array_remove(totp_recuperacao, p_hash)
   WHERE id = app.usuario_atual() AND app.usuario_ativo() AND p_hash = ANY(totp_recuperacao);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

CREATE OR REPLACE FUNCTION app.twofa_trocar_recuperacao(p_recuperacao text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_temp AS $$
  UPDATE core.usuario SET totp_recuperacao = p_recuperacao WHERE id = app.usuario_atual() AND app.usuario_ativo() AND totp_ativo;
$$;

CREATE OR REPLACE FUNCTION app.twofa_desativar() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_temp AS $$
  UPDATE core.usuario SET totp_segredo = NULL, totp_pendente = NULL, totp_ativo = false, totp_recuperacao = '{}', totp_ativado_em = NULL
   WHERE id = app.usuario_atual() AND app.usuario_ativo();
$$;

-- Administração pode zerar a verificação de quem perdeu o celular E os códigos.
CREATE OR REPLACE FUNCTION app.twofa_redefinir_de(p_usuario uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $$
BEGIN
  IF NOT app.eh_admin() THEN RAISE EXCEPTION 'Somente administração.' USING ERRCODE = '42501'; END IF;
  UPDATE core.usuario SET totp_segredo = NULL, totp_pendente = NULL, totp_ativo = false, totp_recuperacao = '{}', totp_ativado_em = NULL
   WHERE id = p_usuario;
END $$;

REVOKE ALL ON FUNCTION app.twofa_estado(), app.twofa_iniciar(text), app.twofa_ativar(bigint, text[]), app.twofa_registrar_passo(bigint),
  app.twofa_usar_recuperacao(text), app.twofa_trocar_recuperacao(text[]), app.twofa_desativar(), app.twofa_redefinir_de(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.twofa_estado(), app.twofa_iniciar(text), app.twofa_ativar(bigint, text[]), app.twofa_registrar_passo(bigint),
  app.twofa_usar_recuperacao(text), app.twofa_trocar_recuperacao(text[]), app.twofa_desativar(), app.twofa_redefinir_de(uuid) TO biotrop_app;

COMMIT;
