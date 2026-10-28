-- =====================================================================================
-- 21 · Cadastros do PCM (SCI × SCM) — o PCM e a gestão passam a GRAVAR famílias, campos e centros de custo
--
-- Bug: a tela "PCM · Cadastros" (rota /api/master-data) deixa admin, gestor, pcm (e almoxarife nas famílias)
-- editar, mas o RLS de 02c só aceitava escrita de almoxarife e admin em almox.familia, almox.familia_campo e
-- almox.centro_custo. Para o PCM o UPDATE não afetava nenhuma linha e voltava "ok": desativar/reativar uma
-- família parecia funcionar, mas o banco não mudava — na atualização seguinte a tela voltava ao estado antigo
-- (a opção "ressuscitava" ou continuava inativa) e as edições "sumiam".
--
-- Correção: escrita para os mesmos perfis que a rota já confere. DELETE continua só com o admin (SCI e SCM
-- antigas apontam para estas linhas; o caminho normal é marcar ativo = false). Idempotente.
-- =====================================================================================
BEGIN;

DO $$
DECLARE v_tab text;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY['familia', 'familia_campo', 'centro_custo'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_ins', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR INSERT
                      WITH CHECK (app.tem_perfil(ARRAY[''almoxarife'', ''admin'', ''gestor'', ''pcm'']))',
                   v_tab || '_ins', v_tab);
    EXECUTE format('DROP POLICY IF EXISTS %I ON almox.%I', v_tab || '_upd', v_tab);
    EXECUTE format('CREATE POLICY %I ON almox.%I FOR UPDATE
                      USING      (app.tem_perfil(ARRAY[''almoxarife'', ''admin'', ''gestor'', ''pcm'']))
                      WITH CHECK (app.tem_perfil(ARRAY[''almoxarife'', ''admin'', ''gestor'', ''pcm'']))',
                   v_tab || '_upd', v_tab);
  END LOOP;
END $$;

COMMIT;
