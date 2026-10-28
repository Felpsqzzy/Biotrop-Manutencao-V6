-- =====================================================================================
-- 28 · Perfil PCM na SCM/SCI e trava da leitura de utilidades
--
-- 1. PCM (decisão de 02/10/2026): tem Gestão de SCM (abre a RC dos serviços — "Contratação de Serviço (PCM)"),
--    não tem Gestão de SCI e não aprova SCM. As regras de quem age em cada etapa ficam em workflow.js.
-- 2. Utilidades: o técnico não aponta leitura menor que a anterior do mesmo medidor (medidor acumulativo).
--    O técnico não enxerga as leituras dos outros (RLS), então a conferência usa uma função que devolve só o
--    número da última leitura até a data informada. PCM, gestor e admin corrigem livremente.
-- Idempotente.
-- =====================================================================================
BEGIN;

INSERT INTO core.perfil_permissao (perfil_id, permissao_chave)
SELECT 'pcm', 'almoxarifado.scm_gestao'
WHERE EXISTS (SELECT 1 FROM core.perfil WHERE id = 'pcm') AND EXISTS (SELECT 1 FROM core.permissao WHERE chave = 'almoxarifado.scm_gestao')
ON CONFLICT DO NOTHING;
DELETE FROM core.perfil_permissao WHERE perfil_id = 'pcm' AND permissao_chave IN ('almoxarifado.solicitacoes', 'almoxarifado.scm_aprovacao');

CREATE OR REPLACE FUNCTION app.ultima_leitura(p_medidor text, p_ate timestamptz, p_excluir text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  -- CASE: o cast só acontece em valor no formato certo (um registro torto não derruba a conferência)
  SELECT max(CASE WHEN r.payload->>'reading' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (r.payload->>'reading')::numeric END)
    FROM app.sync_registro r
   WHERE r.namespace = 'utility_readings' AND NOT r.deleted
     AND r.record_id <> coalesce(p_excluir, '')
     AND r.payload->>'meterId' = p_medidor
     AND CASE WHEN r.payload->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (r.payload->>'at')::timestamptz END <= p_ate
     AND app.usuario_ativo()
$$;
COMMENT ON FUNCTION app.ultima_leitura(text, timestamptz, text) IS 'Maior leitura do medidor até a data (excluindo o próprio registro): base da trava "leitura não pode ser menor que a anterior". Devolve só o número.';
REVOKE ALL ON FUNCTION app.ultima_leitura(text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ultima_leitura(text, timestamptz, text) TO biotrop_app;

COMMIT;
