-- Restringe medidores e leituras por função e proprietário.
BEGIN;

DROP POLICY IF EXISTS sync_registro_select ON app.sync_registro;
CREATE POLICY sync_registro_select ON app.sync_registro FOR SELECT USING (
 app.usuario_ativo() AND (
  namespace='utility_meters'
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife','viewer']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual() OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor','pcm','almoxarife','viewer']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual() OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual() OR app.eh_do_meu_grupo(NULLIF(payload->>'solicitanteId','')::uuid)))
 )
);

DROP POLICY IF EXISTS sync_registro_insert ON app.sync_registro;
CREATE POLICY sync_registro_insert ON app.sync_registro FOR INSERT WITH CHECK (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
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
 )
)
WITH CHECK (
 app.usuario_ativo() AND (
  (namespace='utility_meters' AND app.tem_perfil(ARRAY['admin','gestor','pcm']))
  OR (namespace='utility_readings' AND (app.tem_perfil(ARRAY['admin','gestor','pcm']) OR NULLIF(payload->>'usuarioId','')::uuid=app.usuario_atual()))
  OR (namespace='sci' AND (app.tem_perfil(ARRAY['admin','gestor','almoxarife','pcm']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual()))
  OR (namespace='scm' AND (app.tem_perfil(ARRAY['admin','gestor']) OR NULLIF(payload->>'solicitanteId','')::uuid=app.usuario_atual() OR NULLIF(payload->>'aprovadorId','')::uuid=app.usuario_atual()))
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
