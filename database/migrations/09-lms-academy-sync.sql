-- Treinamentos (academia) passam a sincronizar pelo app.sync_registro.
--   lms_courses  : um registro por curso (conteúdo, avaliação e público).
--                  Todos leem; só admin e gestor gravam.
--   lms_progress : um registro por pessoa e curso (aulas vistas, tentativas,
--                  comprovante). A pessoa grava o próprio; admin e gestor
--                  gravam qualquer um (liberar tentativa); responsável de grupo
--                  e PCM só leem.
-- O dono do progresso vem de payload->>'usuarioId'. A comparação é textual
-- de propósito: um id que não seja uuid não pode derrubar a policy com erro
-- de conversão.
-- As policies abaixo repetem integralmente as regras de 07 e acrescentam os
-- dois namespaces novos.
BEGIN;

DROP POLICY IF EXISTS sync_registro_select ON app.sync_registro;
CREATE POLICY sync_registro_select ON app.sync_registro FOR SELECT USING (
 app.usuario_ativo() AND (
  namespace='utility_meters'
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife','viewer']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual() OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife','viewer']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual() OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual() OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR namespace='lms_courses'
  OR (namespace='lms_progress' AND (
       app.tem_perfil(ARRAY['admin','gestor','pcm'])
       OR payload->>'usuarioId' = app.usuario_atual()::text
       OR app.lidero_usuario(CASE WHEN payload->>'usuarioId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                  THEN (payload->>'usuarioId')::uuid END)))
 )
);

DROP POLICY IF EXISTS sync_registro_insert ON app.sync_registro;
CREATE POLICY sync_registro_insert ON app.sync_registro FOR INSERT WITH CHECK (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='lms_courses' AND app.tem_perfil(ARRAY['admin','gestor']))
  OR (namespace='lms_progress' AND (app.tem_perfil(ARRAY['admin','gestor']) OR payload->>'usuarioId' = app.usuario_atual()::text))
 )
);

DROP POLICY IF EXISTS sync_registro_update ON app.sync_registro;
CREATE POLICY sync_registro_update ON app.sync_registro FOR UPDATE
USING (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual() OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual()))
  OR (namespace='lms_courses' AND app.tem_perfil(ARRAY['admin','gestor']))
  OR (namespace='lms_progress' AND (app.tem_perfil(ARRAY['admin','gestor']) OR payload->>'usuarioId' = app.usuario_atual()::text))
 )
)
WITH CHECK (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual() OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual()))
  OR (namespace='lms_courses' AND app.tem_perfil(ARRAY['admin','gestor']))
  OR (namespace='lms_progress' AND (app.tem_perfil(ARRAY['admin','gestor']) OR payload->>'usuarioId' = app.usuario_atual()::text))
 )
);

DROP POLICY IF EXISTS sync_registro_delete ON app.sync_registro;
CREATE POLICY sync_registro_delete ON app.sync_registro FOR DELETE USING (
 app.usuario_ativo() AND (
  app.tem_perfil(ARRAY['admin','gestor'])
  OR (namespace='utility_readings' AND NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual())
  OR (namespace IN ('sci','scm') AND NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual())
 )
);

COMMIT;
