-- Fluxo de aprovação da SCI/SCM por hierarquia.
--   1) app.aprovador_de(): o APROVADOR da SCM é decidido pelo banco (responsável do
--      grupo do solicitante; exceção cadastrada; nunca o próprio solicitante). A API
--      grava esse resultado na criação, então ninguém escolhe o próprio aprovador.
--   2) sync_registro_update: a SCM também pode ser gravada pelo almoxarifado (etapa
--      de compra) e pelo responsável do grupo do solicitante. QUAL mudança de status
--      cada um pode fazer é conferido na API (server/src/routes/workflow.js); a
--      policy só decide quem alcança a linha. As demais regras repetem a migration 09.
BEGIN;

CREATE OR REPLACE FUNCTION app.aprovador_de(p_usuario uuid) RETURNS TABLE(id uuid, email text, origem text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT a.id, a.email, a.origem FROM (
    SELECT r.id, r.email::text AS email, 'grupo'::text AS origem, 1 AS prio
      FROM core.usuario u
      JOIN core.grupo g ON g.id = u.grupo_id AND g.ativo
      JOIN core.usuario r ON r.id = g.responsavel_id AND r.ativo AND NOT r.bloqueado
     WHERE u.id = p_usuario AND r.id <> p_usuario
    UNION ALL
    SELECT x.id, coalesce(x.email, u.email_lider_excecao)::text, 'excecao', 2
      FROM core.usuario u
      LEFT JOIN core.usuario x ON x.email = u.email_lider_excecao AND x.ativo AND NOT x.bloqueado
     WHERE u.id = p_usuario AND u.email_lider_excecao IS NOT NULL AND u.email_lider_excecao <> u.email
  ) a ORDER BY a.prio LIMIT 1;
$$;
COMMENT ON FUNCTION app.aprovador_de(uuid) IS 'Aprovador da SCM de uma pessoa: responsável ativo do grupo dela; senão o e-mail de exceção; nunca ela mesma. Sem resultado, a aprovação fica com gestor/admin.';
REVOKE ALL ON FUNCTION app.aprovador_de(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aprovador_de(uuid) TO biotrop_app;

DROP POLICY IF EXISTS sync_registro_update ON app.sync_registro;
CREATE POLICY sync_registro_update ON app.sync_registro FOR UPDATE
USING (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife'])
       OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()
       OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual()
       OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR (namespace='lms_courses' AND app.tem_perfil(ARRAY['admin','gestor']))
  OR (namespace='lms_progress' AND (app.tem_perfil(ARRAY['admin','gestor']) OR payload->>'usuarioId' = app.usuario_atual()::text))
 )
)
WITH CHECK (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife'])
       OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()
       OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual()
       OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR (namespace='lms_courses' AND app.tem_perfil(ARRAY['admin','gestor']))
  OR (namespace='lms_progress' AND (app.tem_perfil(ARRAY['admin','gestor']) OR payload->>'usuarioId' = app.usuario_atual()::text))
 )
);

COMMIT;
