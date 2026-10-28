-- =====================================================================================
-- 32 · PCM · Bateladas (volta do módulo, decisão de 05/10/2026: o site vira a fonte)
--
-- Como era: o técnico preenchia um Forms com o CONTADOR ACUMULADO do supervisório de cada tanque; o Forms grava
-- na lista "Bateladas" do SharePoint (Inteligência de Dados) e a planilha "CONTROLE DE BATELADAS" só via os dados
-- depois de "Atualizar dados". Como fica:
--   • o técnico de turno aponta no site, 1x por dia, o contador de cada tanque (FTD, PGD e blenders, os mesmos
--     equipamentos das folhas de diafragma — pcm.ativo FTD01…, PGD01…, BLD02…);
--   • bateladas do dia/semana/mês = diferença do contador; "desde a preventiva" = contador atual − contador na data
--     da última preventiva, que é a mais recente entre o registro manual/histórico (pcm.batelada_preventiva) e a
--     FOLHA DE DIAFRAGMAS CONCLUÍDA no site — concluir a folha zera a contagem sozinho;
--   • alerta: FTD e PGD a cada 18 bateladas, blenders a cada 30 (pcm.batelada_config);
--   • cada dia alterado entra em pcm.batelada_sharepoint, a fila que o worker usa para gravar a mesma linha na lista
--     do SharePoint (quando a TI liberar o acesso do aplicativo ao site) — os gráficos de lá continuam funcionando.
-- O histórico desde jul/2025 entra pela importação da planilha na tela (nenhum dado real fica neste arquivo).
-- As tabelas 18–20 removidas na migration 22 voltam com o mesmo desenho. Idempotente.
-- =====================================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS pcm.batelada_config (
  tipo           text PRIMARY KEY CHECK (tipo IN ('FTD', 'PGD', 'BLD')),
  frequencia     integer NOT NULL CHECK (frequencia BETWEEN 1 AND 1000),
  faixa_atencao  integer NOT NULL CHECK (faixa_atencao >= 1),
  faixa_alerta   integer NOT NULL CHECK (faixa_alerta >= 1),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_batelada_faixas CHECK (faixa_atencao <= faixa_alerta AND faixa_alerta <= frequencia)
);
INSERT INTO pcm.batelada_config (tipo, frequencia, faixa_atencao, faixa_alerta) VALUES
  ('FTD', 18, 10, 15), ('PGD', 18, 10, 15), ('BLD', 30, 20, 26)
ON CONFLICT (tipo) DO NOTHING;
COMMENT ON TABLE pcm.batelada_config IS 'Frequência da preventiva por tipo de tanque (em bateladas) e faixas de cor: < atenção verde; < alerta amarelo; < frequência laranja; >= frequência vermelho.';

CREATE TABLE IF NOT EXISTS pcm.batelada_leitura (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ativo_id             uuid NOT NULL REFERENCES pcm.ativo(id) ON DELETE CASCADE,
  data                 date NOT NULL,
  acumulado            integer NOT NULL CHECK (acumulado BETWEEN 0 AND 1000000),
  origem               text NOT NULL DEFAULT 'site' CHECK (origem IN ('site', 'planilha')),
  registrado_por       uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  registrado_por_nome  text NOT NULL DEFAULT '',
  registrado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_batelada_leitura UNIQUE (ativo_id, data)
);
CREATE INDEX IF NOT EXISTS ix_batelada_leitura_data ON pcm.batelada_leitura (data);
COMMENT ON TABLE pcm.batelada_leitura IS 'Contador acumulado de bateladas do tanque (o número do supervisório). Vale da data até o próximo apontamento.';

CREATE TABLE IF NOT EXISTS pcm.batelada_dia (
  data                 date PRIMARY KEY,
  registrado_por       uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  registrado_por_nome  text NOT NULL DEFAULT '',
  registrado_em        timestamptz NOT NULL DEFAULT now(),
  origem               text NOT NULL DEFAULT 'site' CHECK (origem IN ('site', 'planilha'))
);
COMMENT ON TABLE pcm.batelada_dia IS 'Dia de coleta apontado (quem salvou por último). Dia ausente = ninguém apontou.';

CREATE TABLE IF NOT EXISTS pcm.batelada_preventiva (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ativo_id             uuid NOT NULL REFERENCES pcm.ativo(id) ON DELETE CASCADE,
  data                 date NOT NULL,
  exata                boolean NOT NULL DEFAULT true,
  origem               text NOT NULL DEFAULT 'site' CHECK (origem IN ('site', 'planilha')),
  observacao           text NOT NULL DEFAULT '' CHECK (length(observacao) <= 500),
  registrado_por       uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  registrado_por_nome  text NOT NULL DEFAULT '',
  registrado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_batelada_preventiva UNIQUE (ativo_id, data)
);
COMMENT ON TABLE pcm.batelada_preventiva IS 'Preventiva realizada registrada à mão ou importada da planilha. A folha de diafragmas concluída no site também conta (não precisa registrar aqui).';

CREATE TABLE IF NOT EXISTS pcm.batelada_programacao (
  ativo_id             uuid PRIMARY KEY REFERENCES pcm.ativo(id) ON DELETE CASCADE,
  inicio               date,
  fim                  date,
  bacteria             text NOT NULL DEFAULT '' CHECK (bacteria IN ('', 'VEGETATIVO', 'BACILLUS')),
  comentario           text NOT NULL DEFAULT '' CHECK (length(comentario) <= 300),
  situacao             text NOT NULL DEFAULT '' CHECK (situacao IN ('', 'PROGRAMADO', 'PENDENTE PROGRAMAÇÃO', 'PENDENTE REPROGRAMAÇÃO', 'REPROGRAMADO', 'EXECUTADO')),
  atualizado_por       uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  atualizado_por_nome  text NOT NULL DEFAULT '',
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_batelada_prog CHECK (fim IS NULL OR inicio IS NULL OR fim >= inicio)
);
COMMENT ON TABLE pcm.batelada_programacao IS 'Programação da próxima preventiva do tanque (aba CALENDARIO da planilha): início/fim previstos, bactéria, comentário e status.';

-- Fila para a lista "Bateladas" do SharePoint: uma linha por data que precisa ser (re)gravada lá.
CREATE TABLE IF NOT EXISTS pcm.batelada_sharepoint (
  data          date PRIMARY KEY,
  pendente      boolean NOT NULL DEFAULT true,
  tentativas    smallint NOT NULL DEFAULT 0,
  erro          text,
  item_id       text,
  enviado_em    timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_batelada_sharepoint_pendente ON pcm.batelada_sharepoint (data) WHERE pendente;
COMMENT ON TABLE pcm.batelada_sharepoint IS 'Datas a gravar na lista Bateladas do SharePoint (worker-sharepoint.js). item_id = id do item da lista para aquela data.';

-- Mudou o contador de um dia: aquele dia e os seguintes (até hoje, no máximo 400 dias) vão para a fila,
-- porque a lista guarda o contador EM VIGOR em cada data.
CREATE OR REPLACE FUNCTION pcm.tg_batelada_fila() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pcm, pg_temp AS $$
DECLARE v_de date := CASE WHEN TG_OP = 'DELETE' THEN OLD.data ELSE NEW.data END;
BEGIN
  -- importação do histórico da planilha: esses dias já estão na lista do SharePoint
  IF current_setting('pcm.sem_fila', true) = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.data < NEW.data THEN v_de := OLD.data; END IF;
  INSERT INTO pcm.batelada_sharepoint (data, pendente, tentativas, erro, atualizado_em)
  SELECT d::date, true, 0, NULL, now()
    FROM generate_series(greatest(v_de, current_date - 400), current_date, interval '1 day') d
  ON CONFLICT (data) DO UPDATE SET pendente = true, tentativas = 0, erro = NULL, atualizado_em = now();
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS tg_batelada_fila ON pcm.batelada_leitura;
CREATE TRIGGER tg_batelada_fila AFTER INSERT OR UPDATE OR DELETE ON pcm.batelada_leitura
  FOR EACH ROW EXECUTE FUNCTION pcm.tg_batelada_fila();

-- O worker lê o contador em vigor de cada tanque numa data (sem enxergar quem apontou).
CREATE OR REPLACE FUNCTION pcm.batelada_contadores_em(p_data date)
RETURNS TABLE (codigo text, acumulado integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pcm, pg_temp AS $$
  SELECT a.codigo, coalesce((SELECT l.acumulado FROM pcm.batelada_leitura l WHERE l.ativo_id = a.id AND l.data <= p_data
                             ORDER BY l.data DESC LIMIT 1), 0)
    FROM pcm.ativo a
   WHERE a.ativo AND a.codigo ~ '^(FTD|PGD|BLD)[0-9]{2}$'
   ORDER BY a.codigo
$$;
REVOKE ALL ON FUNCTION pcm.batelada_contadores_em(date) FROM PUBLIC;

-- ------------------------------------------------------------------ privilégios e RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON pcm.batelada_config, pcm.batelada_leitura, pcm.batelada_dia, pcm.batelada_preventiva,
  pcm.batelada_programacao TO biotrop_app;
GRANT SELECT ON pcm.batelada_config, pcm.batelada_leitura, pcm.batelada_dia, pcm.batelada_preventiva,
  pcm.batelada_programacao, pcm.batelada_sharepoint TO biotrop_ro;
GRANT SELECT ON pcm.batelada_sharepoint TO biotrop_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['batelada_config', 'batelada_leitura', 'batelada_dia', 'batelada_preventiva', 'batelada_programacao'] LOOP
    EXECUTE format('ALTER TABLE pcm.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON pcm.%I', t || '_equipe_sel', t);
    EXECUTE format('CREATE POLICY %I ON pcm.%I FOR SELECT TO biotrop_app, biotrop_ro USING (app.pcm_equipe())', t || '_equipe_sel', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON pcm.%I', t || '_gestao', t);
    EXECUTE format('CREATE POLICY %I ON pcm.%I FOR ALL TO biotrop_app USING (app.pcm_gestao()) WITH CHECK (app.pcm_gestao())', t || '_gestao', t);
  END LOOP;
END $$;
ALTER TABLE pcm.batelada_sharepoint ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS batelada_sharepoint_sel ON pcm.batelada_sharepoint;
CREATE POLICY batelada_sharepoint_sel ON pcm.batelada_sharepoint FOR SELECT TO biotrop_app, biotrop_ro USING (app.pcm_gestao());

-- A equipe (líder e técnico inclusive) aponta o contador e o dia, sempre em nome próprio e até 7 dias atrás.
DROP POLICY IF EXISTS batelada_leitura_equipe_ins ON pcm.batelada_leitura;
CREATE POLICY batelada_leitura_equipe_ins ON pcm.batelada_leitura FOR INSERT TO biotrop_app
  WITH CHECK (app.pcm_equipe() AND origem = 'site' AND registrado_por = app.usuario_atual() AND data >= current_date - 7);
DROP POLICY IF EXISTS batelada_leitura_equipe_upd ON pcm.batelada_leitura;
CREATE POLICY batelada_leitura_equipe_upd ON pcm.batelada_leitura FOR UPDATE TO biotrop_app
  USING (app.pcm_equipe() AND data >= current_date - 7)
  WITH CHECK (app.pcm_equipe() AND origem = 'site' AND registrado_por = app.usuario_atual() AND data >= current_date - 7);
DROP POLICY IF EXISTS batelada_leitura_equipe_del ON pcm.batelada_leitura;
CREATE POLICY batelada_leitura_equipe_del ON pcm.batelada_leitura FOR DELETE TO biotrop_app
  USING (app.pcm_equipe() AND origem = 'site' AND data >= current_date - 7);
DROP POLICY IF EXISTS batelada_dia_equipe_ins ON pcm.batelada_dia;
CREATE POLICY batelada_dia_equipe_ins ON pcm.batelada_dia FOR INSERT TO biotrop_app
  WITH CHECK (app.pcm_equipe() AND registrado_por = app.usuario_atual());
DROP POLICY IF EXISTS batelada_dia_equipe_upd ON pcm.batelada_dia;
CREATE POLICY batelada_dia_equipe_upd ON pcm.batelada_dia FOR UPDATE TO biotrop_app
  USING (app.pcm_equipe()) WITH CHECK (app.pcm_equipe() AND registrado_por = app.usuario_atual());

-- Worker do SharePoint: só a fila e a função dos contadores.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'biotrop_worker') THEN
    GRANT USAGE ON SCHEMA pcm TO biotrop_worker;
    GRANT SELECT, UPDATE ON pcm.batelada_sharepoint TO biotrop_worker;
    GRANT EXECUTE ON FUNCTION pcm.batelada_contadores_em(date) TO biotrop_worker;
    DROP POLICY IF EXISTS batelada_sharepoint_worker ON pcm.batelada_sharepoint;
    CREATE POLICY batelada_sharepoint_worker ON pcm.batelada_sharepoint FOR ALL TO biotrop_worker USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
