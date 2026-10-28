-- PCM · Bateladas: o que faltava das abas da planilha "CONTROLE DE BATELADAS" (09/10/2026).
-- Idempotente: o migrate.js reaplica todas as migrations a cada deploy. Não grava nenhum dado: as tabelas nascem vazias
-- e são preenchidas pela tela (ou pela importação da planilha, que quem tem acesso faz de dentro do site).
--
--   pcm.batelada_tarefa     aba "Planilha1": por tanque, "Mudança gás out" e "Troca de diafragma da amostra" (OK / pendente)
--   pcm.eba_preventiva      aba "PREVENTIVAS EBA'S": preventivas dos EBAs (EBA-003, EBA-004…), semanal/mensal/trimestral,
--                           realizadas (azul) ou programadas (verde)
-- O calendário semanal 2025/2026, o calendário diário, a pós-preventiva, a diária/semanal/mensal e a coleta saem das tabelas
-- que já existem (batelada_leitura, batelada_preventiva — com `exata = false` quando só se sabe a semana —, batelada_programacao).

CREATE TABLE IF NOT EXISTS pcm.batelada_tarefa (
  ativo_id             uuid NOT NULL REFERENCES pcm.ativo(id) ON DELETE CASCADE,
  tipo                 text NOT NULL CHECK (tipo IN ('gas_out', 'diafragma_amostra')),
  feito                boolean NOT NULL DEFAULT false,
  atualizado_por       uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  atualizado_por_nome  text NOT NULL DEFAULT '',
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ativo_id, tipo)
);
COMMENT ON TABLE pcm.batelada_tarefa IS 'Tarefas por tanque da aba Planilha1: mudança do gás out e troca do diafragma da amostra (feito/pendente).';

CREATE TABLE IF NOT EXISTS pcm.eba_preventiva (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipamento          text NOT NULL CHECK (equipamento ~ '^EBA-[0-9]{3}$'),
  data                 date NOT NULL,
  frequencia           text NOT NULL CHECK (frequencia IN ('S', 'M', 'T')),
  realizada            boolean NOT NULL DEFAULT false,
  origem               text NOT NULL DEFAULT 'site' CHECK (origem IN ('site', 'planilha')),
  registrado_por       uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  registrado_por_nome  text NOT NULL DEFAULT '',
  registrado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_eba_preventiva UNIQUE (equipamento, data)
);
CREATE INDEX IF NOT EXISTS ix_eba_preventiva_data ON pcm.eba_preventiva (data);
COMMENT ON TABLE pcm.eba_preventiva IS 'Preventivas dos EBAs: S = semanal, M = mensal, T = trimestral. realizada = azul na planilha; programada = verde.';

GRANT SELECT, INSERT, UPDATE, DELETE ON pcm.batelada_tarefa, pcm.eba_preventiva TO biotrop_app;
GRANT SELECT ON pcm.batelada_tarefa, pcm.eba_preventiva TO biotrop_ro;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['batelada_tarefa', 'eba_preventiva'] LOOP
    EXECUTE format('ALTER TABLE pcm.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON pcm.%I', t || '_equipe_sel', t);
    EXECUTE format('CREATE POLICY %I ON pcm.%I FOR SELECT TO biotrop_app, biotrop_ro USING (app.pcm_equipe())', t || '_equipe_sel', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON pcm.%I', t || '_gestao', t);
    EXECUTE format('CREATE POLICY %I ON pcm.%I FOR ALL TO biotrop_app USING (app.pcm_gestao()) WITH CHECK (app.pcm_gestao())', t || '_gestao', t);
  END LOOP;
END $$;
