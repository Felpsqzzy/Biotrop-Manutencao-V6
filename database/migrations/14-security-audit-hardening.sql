-- Auditoria 2026-09-28: rascunhos LMS ficam restritos à gestão e o worker
-- recebe somente a função necessária para criar cobranças automáticas.
BEGIN;

DROP POLICY IF EXISTS sync_registro_select ON app.sync_registro;
CREATE POLICY sync_registro_select ON app.sync_registro FOR SELECT USING (
 app.usuario_ativo() AND (
  namespace='utility_meters'
  OR (namespace='utility_readings' AND (
       app.tem_perfil(ARRAY['admin','gestor','pcm'])
       OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (
       app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife'])
       OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()
       OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR (namespace='scm' AND (
       app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife'])
       OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()
       OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual()
       OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR (namespace='lms_courses' AND (
       app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife'])
       OR payload->>'status'='publicado'))
  OR (namespace='lms_progress' AND (
       app.tem_perfil(ARRAY['admin','gestor','pcm'])
       OR payload->>'usuarioId' = app.usuario_atual()::text
       OR app.lidero_usuario(CASE
            WHEN payload->>'usuarioId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (payload->>'usuarioId')::uuid END)))
 )
);

COMMENT ON POLICY sync_registro_select ON app.sync_registro IS
  'Escopo por pessoa/equipe; cursos em rascunho ficam restritos à gestão.';

GRANT USAGE ON SCHEMA lms TO biotrop_worker;
GRANT EXECUTE ON FUNCTION lms.enfileirar_cobrancas_treinamento(timestamptz) TO biotrop_worker;

COMMIT;
