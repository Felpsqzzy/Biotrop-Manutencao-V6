-- =====================================================================================
-- 29 · Treinamentos no módulo atual (app.sync_registro): equipe, certificado por e-mail e cobrança de prazo
--
-- 1. Equipe: a tela de Acompanhamento precisava da lista de pessoas e grupos do BANCO. Até aqui ela usava o
--    cache local do navegador, que no servidor só tem a própria pessoa. lms.equipe_visivel() devolve quem a
--    sessão acompanha: gestão, admin, PCM e almoxarife veem todos; o responsável de grupo vê o próprio grupo;
--    os demais veem só a si mesmos. lms.grupos_visiveis() devolve os grupos ativos com o responsável (gestor).
-- 2. Certificado por e-mail (decisão de 05/10/2026): ao concluir um curso, o colaborador recebe o certificado
--    e o responsável do grupo vai em cópia. Um gatilho em app.sync_registro enfileira o e-mail na mesma
--    transação da conclusão (vale para curso com e sem prova). Uma vez por código de certificado.
--    O worker só envia se "lms_certificado" estiver em EMAIL_MOTIVOS_ATIVOS.
-- 3. Cobrança de prazo: lms.enfileirar_cobrancas_treinamento() lia as tabelas lms.matricula/lms.treinamento,
--    que o módulo atual não grava, e por isso nunca cobrava nada. Agora lê cursos e progresso sincronizados.
--    Cobra o responsável do grupo (aluno em cópia) quando o prazo vence em até 7 dias, o certificado vence em
--    até 7 dias, ou uma revisão do curso pediu que todos refaçam. No máximo uma cobrança a cada 7 dias.
-- Registros do modo de teste (_simulacao) nunca geram e-mail. Idempotente.
-- =====================================================================================
BEGIN;

-- 1. equipe ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.equipe_visivel()
RETURNS TABLE (id uuid, nome text, email text, perfil_id text, grupo_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT u.id, u.nome, u.email::text, u.perfil_id, u.grupo_id
    FROM core.usuario u
   WHERE app.usuario_ativo()
     AND u.ativo AND NOT u.bloqueado
     -- quem só usa o terminal do almoxarifado (perfil 'terminal', migration 40) nunca entra no site: não é equipe de
     -- treinamento (ficaria pendente para sempre na conformidade e poderia ser cobrado pelo copiloto, migration 39)
     AND u.perfil_id <> 'terminal'
     AND (
       app.tem_perfil(ARRAY['admin', 'gestor', 'pcm', 'almoxarife'])
       OR u.id = app.usuario_atual()
       OR u.grupo_id IN (SELECT app.grupos_que_lidero())
     )
   ORDER BY u.nome
$$;
COMMENT ON FUNCTION lms.equipe_visivel() IS 'Pessoas que a sessão acompanha nos treinamentos: gestão/admin/PCM/almoxarife veem todos; responsável de grupo vê o próprio grupo; os demais, só a si mesmos. Quem só usa o terminal do almoxarifado (perfil terminal) fica de fora.';

CREATE OR REPLACE FUNCTION lms.grupos_visiveis()
RETURNS TABLE (id uuid, codigo text, nome text, responsavel_id uuid, responsavel_nome text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT g.id, g.codigo, g.nome, g.responsavel_id, r.nome
    FROM core.grupo g
    LEFT JOIN core.usuario r ON r.id = g.responsavel_id AND r.ativo
   WHERE app.usuario_ativo() AND g.ativo
   ORDER BY g.nome
$$;
COMMENT ON FUNCTION lms.grupos_visiveis() IS 'Grupos ativos com o responsável (o gestor do time nos treinamentos e o aprovador da SCM).';

REVOKE ALL ON FUNCTION lms.equipe_visivel(), lms.grupos_visiveis() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lms.equipe_visivel(), lms.grupos_visiveis() TO biotrop_app;

-- 2. certificado por e-mail -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.data_br(p_iso text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_iso ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
    THEN to_char((p_iso::timestamptz) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') ELSE '' END
$$;

CREATE OR REPLACE FUNCTION lms.enfileirar_certificado(p_record_id text, p jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, core, app, public, pg_temp AS $$
DECLARE
  v_curso jsonb;
  v_aluno record;
  v_gestor citext;
  v_ref text;
  v_rev text;
BEGIN
  IF p IS NULL OR coalesce(p->>'completed_at', '') = '' OR coalesce(p->>'certificate_code', '') = '' THEN RETURN false; END IF;
  IF coalesce(p->>'_simulacao', '') = 'true' THEN RETURN false; END IF;
  IF coalesce(p->>'usuarioId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  v_ref := p_record_id || '#' || (p->>'certificate_code');
  IF EXISTS (SELECT 1 FROM core.email_fila f WHERE f.motivo = 'lms_certificado'
              AND f.referencia_tabela = 'app.sync_registro' AND f.referencia_id = v_ref) THEN RETURN false; END IF;
  SELECT r.payload INTO v_curso FROM app.sync_registro r
   WHERE r.namespace = 'lms_courses' AND r.record_id = p->>'course_id' AND NOT r.deleted;
  IF v_curso IS NULL THEN RETURN false; END IF;
  SELECT u.nome, u.email, u.grupo_id INTO v_aluno FROM core.usuario u
   WHERE u.id = (p->>'usuarioId')::uuid AND u.ativo AND NOT u.bloqueado;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT r.email INTO v_gestor FROM core.grupo g
    JOIN core.usuario r ON r.id = g.responsavel_id AND r.ativo AND NOT r.bloqueado
   WHERE g.id = v_aluno.grupo_id AND g.ativo AND r.email <> v_aluno.email;
  v_rev := lpad(coalesce(nullif(p->>'version', ''), v_curso->>'version', '1'), 2, '0');
  INSERT INTO core.email_fila (destinatario, copia, assunto, corpo_html, referencia_tabela, referencia_id, motivo)
  VALUES (
    v_aluno.email,
    CASE WHEN v_gestor IS NULL THEN NULL ELSE ARRAY[v_gestor]::citext[] END,
    left('Certificado de treinamento: ' || coalesce(v_curso->>'title', 'curso'), 255),
    '<div style="font-family:Arial,sans-serif;color:#173431;max-width:640px;border:1px solid #d9e6e1;border-radius:14px;overflow:hidden">' ||
      '<div style="background:#00634e;color:#fff;padding:18px 22px"><div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.85">Biotrop · Treinamentos Manutenção</div>' ||
      '<div style="font-size:22px;font-weight:bold;margin-top:4px">Certificado de conclusão</div></div>' ||
      '<div style="padding:20px 22px"><p>Certificamos que <b>' || lms.escape_html(v_aluno.nome) || '</b> concluiu o curso <b>' ||
      lms.escape_html(v_curso->>'title') || '</b> (' || lms.escape_html(coalesce(v_curso->>'code', '')) || ' · Rev. ' || v_rev || ').</p>' ||
      '<table style="border-collapse:collapse;font-size:14px">' ||
      '<tr><td style="padding:4px 14px 4px 0;color:#55706d">Concluído em</td><td><b>' || lms.data_br(p->>'completed_at') || '</b></td></tr>' ||
      CASE WHEN coalesce(p->>'score', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN '<tr><td style="padding:4px 14px 4px 0;color:#55706d">Nota</td><td><b>' || (p->>'score') || '%</b></td></tr>' ELSE '' END ||
      '<tr><td style="padding:4px 14px 4px 0;color:#55706d">Validade</td><td><b>' ||
        CASE WHEN coalesce(p->>'expires_at', '') <> '' THEN 'até ' || lms.data_br(p->>'expires_at') ELSE 'sem vencimento' END || '</b></td></tr>' ||
      '<tr><td style="padding:4px 14px 4px 0;color:#55706d">Código</td><td><b>' || lms.escape_html(p->>'certificate_code') || '</b></td></tr></table>' ||
      '<p style="color:#55706d;font-size:13px;margin-top:18px">O certificado para imprimir ou salvar em PDF fica na Plataforma de Manutenção, em Treinamentos › Meus certificados.</p></div></div>',
    'app.sync_registro', v_ref, 'lms_certificado'
  );
  RETURN true;
END;
$$;
COMMENT ON FUNCTION lms.enfileirar_certificado(text, jsonb) IS 'Enfileira o certificado de um progresso concluído para o colaborador, com o responsável do grupo em cópia. Uma vez por código de certificado.';
REVOKE ALL ON FUNCTION lms.enfileirar_certificado(text, jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION lms.tg_certificado_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lms, core, app, public, pg_temp AS $$
BEGIN
  IF NEW.namespace <> 'lms_progress' OR NEW.deleted THEN RETURN NEW; END IF;
  IF coalesce(NEW.payload->>'certificate_code', '') = '' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND coalesce(OLD.payload->>'certificate_code', '') = NEW.payload->>'certificate_code' THEN RETURN NEW; END IF;
  BEGIN
    PERFORM lms.enfileirar_certificado(NEW.record_id, NEW.payload);
  EXCEPTION WHEN OTHERS THEN
    -- O e-mail nunca derruba a conclusão do curso.
    RAISE WARNING 'certificado por e-mail não enfileirado (%): %', NEW.record_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tg_lms_certificado_email ON app.sync_registro;
CREATE TRIGGER tg_lms_certificado_email AFTER INSERT OR UPDATE OF payload ON app.sync_registro
  FOR EACH ROW WHEN (NEW.namespace = 'lms_progress') EXECUTE FUNCTION lms.tg_certificado_email();

-- 3. cobrança de prazo ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lms.enfileirar_cobrancas_treinamento(p_agora timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = lms, core, app, public, pg_temp AS $$
DECLARE
  v_total integer;
BEGIN
  WITH cursos AS (
    SELECT r.record_id AS curso_id, r.payload AS c,
           coalesce(nullif(r.payload->>'deadline_days', '')::int, 30) AS dias,
           CASE WHEN r.payload->>'published_at' ~ '^[0-9]{4}-' THEN (r.payload->>'published_at')::timestamptz END AS publicado_em
      FROM app.sync_registro r
     WHERE r.namespace = 'lms_courses' AND NOT r.deleted
       AND r.payload->>'status' = 'publicado' AND r.payload->>'mandatory' = 'true'
       AND coalesce(r.payload->>'_simulacao', '') <> 'true'
  ), publico AS (
    SELECT cu.*, a.id AS aluno_id, a.nome AS aluno_nome, a.email AS aluno_email, a.grupo_id
      FROM cursos cu
      JOIN core.usuario a ON a.ativo AND NOT a.bloqueado
     WHERE (jsonb_array_length(coalesce(cu.c->'audience'->'groups', '[]')) = 0
            AND jsonb_array_length(coalesce(cu.c->'audience'->'users', '[]')) = 0)
        OR (cu.c->'audience'->'groups') ? a.grupo_id::text
        OR (cu.c->'audience'->'users') ? a.id::text
  ), situacao AS (
    SELECT pu.*, pr.payload AS p,
      CASE
        WHEN pr.payload->>'completed_at' ~ '^[0-9]{4}-' THEN
          CASE
            WHEN coalesce(nullif(pu.c->>'retrain_version', '')::int, 0) > coalesce(nullif(pr.payload->>'version', '')::int, 1)
              THEN coalesce(CASE WHEN pu.c->>'retrain_at' ~ '^[0-9]{4}-' THEN (pu.c->>'retrain_at')::timestamptz END, pu.publicado_em) + make_interval(days => pu.dias)
            WHEN pr.payload->>'expires_at' ~ '^[0-9]{4}-' THEN (pr.payload->>'expires_at')::timestamptz
          END
        ELSE greatest(
          coalesce(CASE WHEN pr.payload->>'enrolled_at' ~ '^[0-9]{4}-' THEN (pr.payload->>'enrolled_at')::timestamptz END, pu.publicado_em),
          pu.publicado_em) + make_interval(days => pu.dias)
      END AS prazo
      FROM publico pu
      LEFT JOIN app.sync_registro pr ON pr.namespace = 'lms_progress' AND NOT pr.deleted
       AND pr.record_id = pu.aluno_id::text || '__' || pu.curso_id
  )
  INSERT INTO core.email_fila (destinatario, copia, assunto, corpo_html, referencia_tabela, referencia_id, motivo)
  SELECT
    gestor.email,
    ARRAY[s.aluno_email]::citext[],
    CASE WHEN s.prazo < p_agora THEN '[Ação necessária] Treinamento atrasado' ELSE '[Lembrete] Prazo de treinamento próximo' END,
    '<div style="font-family:Arial,sans-serif;color:#173431;max-width:640px">' ||
    '<h2 style="color:#087b66">Treinamento da equipe</h2><p><b>' || lms.escape_html(s.aluno_nome) ||
    '</b> precisa ' || CASE WHEN s.p->>'completed_at' ~ '^[0-9]{4}-' THEN 'refazer' ELSE 'concluir' END || ' <b>' || lms.escape_html(s.c->>'title') || '</b>.</p><p>Prazo: <b>' ||
    to_char(s.prazo AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') ||
    '</b></p><p style="color:#55706d">Acesse a Plataforma de Manutenção, em Treinamentos › Acompanhamento da equipe.</p></div>',
    'lms.cobranca', s.aluno_id::text || '__' || s.curso_id, 'lms_cobranca_gestor'
  FROM situacao s
  JOIN core.grupo g ON g.id = s.grupo_id AND g.ativo
  JOIN core.usuario gestor ON gestor.id = g.responsavel_id AND gestor.ativo AND NOT gestor.bloqueado
  WHERE s.prazo IS NOT NULL
    AND s.prazo <= p_agora + interval '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM core.email_fila f
       WHERE f.motivo = 'lms_cobranca_gestor'
         AND f.referencia_tabela = 'lms.cobranca'
         AND f.referencia_id = s.aluno_id::text || '__' || s.curso_id
         AND f.criado_em >= p_agora - interval '7 days'
         AND f.status <> 'cancelado'
    );
  GET DIAGNOSTICS v_total = ROW_COUNT;
  RETURN v_total;
END;
$$;
COMMENT ON FUNCTION lms.enfileirar_cobrancas_treinamento(timestamptz) IS
  'Cobrança semanal ao responsável do grupo, com cópia ao colaborador: curso obrigatório com prazo vencendo em até 7 dias, certificado vencendo, ou revisão que pediu para refazer. Lê o módulo atual (app.sync_registro).';
REVOKE ALL ON FUNCTION lms.enfileirar_cobrancas_treinamento(timestamptz) FROM PUBLIC;

COMMIT;
