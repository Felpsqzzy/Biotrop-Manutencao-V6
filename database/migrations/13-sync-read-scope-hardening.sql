-- Defesa em profundidade da sincronização.
-- A API já filtra estes registros, mas a policy do PostgreSQL também precisa
-- impedir que o perfil viewer leia solicitações de outras pessoas.
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
  OR namespace='lms_courses'
  OR (namespace='lms_progress' AND (
       app.tem_perfil(ARRAY['admin','gestor','pcm'])
       OR payload->>'usuarioId' = app.usuario_atual()::text
       OR app.lidero_usuario(CASE
            WHEN payload->>'usuarioId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (payload->>'usuarioId')::uuid END)))
 )
);

COMMENT ON POLICY sync_registro_select ON app.sync_registro IS
  'Escopo de leitura por pessoa/equipe. Viewer não recebe SCI ou SCM de terceiros; a API repete o filtro como defesa adicional.';

COMMIT;
