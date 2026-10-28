-- Copiloto BIOMANUT · cobrança de treinamento pedida pelo gestor (09/10/2026). Idempotente; não grava dado nenhum.
--
-- O copiloto só PREPARA a cobrança. Quem decide é a pessoa, no botão "Enviar cobrança". O botão chama POST /api/copiloto/cobrar,
-- que chama esta função. A regra fica no banco (como as demais permissões do site):
--   · só admin, gestor e líder (responsável de grupo) cobram;
--   · só quem está na equipe visível da sessão (lms.equipe_visivel(): líder = o próprio grupo; admin/gestor = todos) e nunca a si mesmo;
--   · a mesma pessoa não recebe mais de uma cobrança do copiloto a cada 24 h;
--   · no máximo 40 cobranças por dia por quem cobra;
--   · o e-mail vai para a pessoa, com quem cobra em cópia, pela fila de sempre (core.email_fila → worker → Microsoft Graph).
-- Motivo da fila: copiloto_cobranca. Precisa estar em EMAIL_MOTIVOS_ATIVOS do worker de e-mail (ver .env.example).
CREATE OR REPLACE FUNCTION lms.copiloto_cobrar(p_alvo uuid, p_assunto text, p_html text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, core, app, public, pg_temp AS $$
DECLARE
  v_eu core.usuario%ROWTYPE;
  v_alvo core.usuario%ROWTYPE;
BEGIN
  IF NOT app.usuario_ativo() THEN RETURN 'sem_sessao'; END IF;
  SELECT * INTO v_eu FROM core.usuario WHERE id = app.usuario_atual();
  IF NOT FOUND OR NOT v_eu.ativo OR v_eu.bloqueado THEN RETURN 'sem_sessao'; END IF;
  IF NOT app.tem_perfil(ARRAY['admin', 'gestor', 'lider']) THEN RETURN 'sem_permissao'; END IF;
  IF p_alvo IS NULL OR p_alvo = v_eu.id THEN RETURN 'proprio'; END IF;
  IF NOT EXISTS (SELECT 1 FROM lms.equipe_visivel() e WHERE e.id = p_alvo) THEN RETURN 'fora_da_equipe'; END IF;
  SELECT * INTO v_alvo FROM core.usuario WHERE id = p_alvo AND ativo AND NOT bloqueado;
  IF NOT FOUND THEN RETURN 'fora_da_equipe'; END IF;
  IF coalesce(length(trim(p_assunto)), 0) = 0 OR length(p_assunto) > 200 OR coalesce(length(p_html), 0) = 0 OR length(p_html) > 20000 THEN RETURN 'texto_invalido'; END IF;
  -- Namespaces distintos e ordem fixa: cobrador primeiro, destinatário depois.
  -- A transação mantém os locks até confirmar o INSERT, inclusive entre gestores diferentes.
  PERFORM pg_advisory_xact_lock(3901, hashtext(v_eu.id::text));
  PERFORM pg_advisory_xact_lock(3902, hashtext(p_alvo::text));
  IF EXISTS (SELECT 1 FROM core.email_fila f WHERE f.motivo = 'copiloto_cobranca' AND f.referencia_tabela = 'copiloto.cobranca'
              AND f.referencia_id = p_alvo::text AND f.criado_em >= now() - interval '24 hours' AND f.status <> 'cancelado') THEN
    RETURN 'repetida';
  END IF;
  IF (SELECT count(*) FROM core.email_fila f WHERE f.motivo = 'copiloto_cobranca' AND f.copia @> ARRAY[v_eu.email]::citext[]
       AND f.criado_em >= now() - interval '24 hours') >= 40 THEN
    RETURN 'limite_do_dia';
  END IF;
  INSERT INTO core.email_fila (destinatario, copia, assunto, corpo_html, referencia_tabela, referencia_id, motivo)
  VALUES (v_alvo.email, ARRAY[v_eu.email]::citext[], left(trim(p_assunto), 200), p_html, 'copiloto.cobranca', p_alvo::text, 'copiloto_cobranca');
  RETURN 'ok';
END;
$$;
COMMENT ON FUNCTION lms.copiloto_cobrar(uuid, text, text) IS 'Cobrança de treinamento enfileirada por um gestor/líder a partir do copiloto: valida perfil, equipe, repetição (24 h) e limite diário.';
REVOKE ALL ON FUNCTION lms.copiloto_cobrar(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.copiloto_cobrar(uuid, text, text) TO biotrop_app;
