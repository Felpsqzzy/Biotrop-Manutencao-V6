-- =====================================================================================
-- 31 · PCM abre a RC das SCMs de serviço (correção encontrada no teste de estresse dos fluxos, 05/10/2026)
--
-- A migration 28 deu ao PCM a Gestão de SCM das "Contratação de Serviço (PCM)", e o workflow.js libera o passo,
-- mas a policy de UPDATE de app.sync_registro (migration 12) não incluía o PCM: o banco recusava a gravação e o
-- PCM não conseguia abrir a RC. Agora o PCM altera só as SCMs de serviço — as de material continuam fechadas
-- para ele no banco, mesmo que alguém contorne a API.
-- Idempotente.
-- =====================================================================================
BEGIN;

CREATE OR REPLACE FUNCTION app.scm_de_servico_pcm(p_tipo text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_tipo, '') = 'contratacao_servico_pcm' OR coalesce(p_tipo, '') ~* 'servi[cç]o.*pcm'
$$;
COMMENT ON FUNCTION app.scm_de_servico_pcm(text) IS 'Mesma regra de ehServicoPcm (workflow.js): a lista é editável, então vale o código ou o nome.';
GRANT EXECUTE ON FUNCTION app.scm_de_servico_pcm(text) TO biotrop_app, biotrop_ro;

DROP POLICY IF EXISTS sync_registro_update ON app.sync_registro;
CREATE POLICY sync_registro_update ON app.sync_registro FOR UPDATE
USING (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife'])
       OR (app.tem_perfil(ARRAY['pcm']) AND app.scm_de_servico_pcm(payload->>'tipoPedido'))
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
       OR (app.tem_perfil(ARRAY['pcm']) AND app.scm_de_servico_pcm(payload->>'tipoPedido'))
       OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()
       OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual()
       OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR (namespace='lms_courses' AND app.tem_perfil(ARRAY['admin','gestor']))
  OR (namespace='lms_progress' AND (app.tem_perfil(ARRAY['admin','gestor']) OR payload->>'usuarioId' = app.usuario_atual()::text))
 )
);

COMMIT;
