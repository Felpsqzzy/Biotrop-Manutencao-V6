-- =====================================================================================
-- 24 · Cadastros dos formulários (SCI e SCM) passam a ser do ALMOXARIFADO
--
-- Decisão do Plinio (01/10/2026): famílias e campos da SCI, listas da SCM e vínculos CAMM × centro de custo
-- são editados pelo almoxarifado (com a gestão e a administração). O PCM não vê nem edita esses cadastros, e o
-- almoxarifado não vê nem edita o que é do PCM (preventivas). A migration 21 tinha dado escrita ao PCM; aqui ela
-- volta para almoxarife, gestor e admin. Leitura continua aberta a quem está ativo (os formulários precisam).
-- Idempotente.
-- =====================================================================================
BEGIN;

DO $$
DECLARE v_tab text;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY['familia', 'familia_campo', 'centro_custo'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_ins', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR INSERT
                      WITH CHECK (app.tem_perfil(ARRAY[''almoxarife'', ''admin'', ''gestor'']))',
                   v_tab || '_ins', v_tab);
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_upd', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR UPDATE
                      USING      (app.tem_perfil(ARRAY[''almoxarife'', ''admin'', ''gestor'']))
                      WITH CHECK (app.tem_perfil(ARRAY[''almoxarife'', ''admin'', ''gestor'']))',
                   v_tab || '_upd', v_tab);
  END LOOP;
END $$;

COMMIT;
