-- =====================================================================================
-- 33 · Bateladas: o contador só aumenta (pedido de 06/10/2026)
--
-- Várias pessoas apontam no mesmo dia. Regra:
--   • a equipe (técnico, líder) só AUMENTA o contador: nunca grava um valor menor que o que já está em vigor no
--     dia (o do próprio dia, se alguém já apontou, ou o do dia anterior) e nunca apaga um apontamento;
--   • o PCM, a gestão e o admin podem diminuir ou corrigir, sempre com justificativa, que fica registrada em
--     pcm.batelada_correcao (de → para, motivo, quem, quando).
-- A API confere isso; esta trigger repete a regra no banco (quem contornar a API também é barrado).
-- Sessão sem usuário (migrations, rotinas do banco) não passa pela trava. Idempotente.
-- =====================================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS pcm.batelada_correcao (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ativo_id   uuid NOT NULL REFERENCES pcm.ativo(id) ON DELETE CASCADE,
  data       date NOT NULL,
  de         integer,
  para       integer NOT NULL CHECK (para BETWEEN 0 AND 1000000),
  motivo     text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 5 AND 500),
  por        uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  por_nome   text NOT NULL DEFAULT '',
  em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_batelada_correcao_data ON pcm.batelada_correcao (data DESC, ativo_id);
COMMENT ON TABLE pcm.batelada_correcao IS 'Correções do PCM no contador de bateladas (diminuir ou fugir das travas), com a justificativa. Trilha de auditoria: não se apaga.';

GRANT SELECT, INSERT ON pcm.batelada_correcao TO biotrop_app;
GRANT SELECT ON pcm.batelada_correcao TO biotrop_ro;
ALTER TABLE pcm.batelada_correcao ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS batelada_correcao_sel ON pcm.batelada_correcao;
CREATE POLICY batelada_correcao_sel ON pcm.batelada_correcao FOR SELECT TO biotrop_app, biotrop_ro USING (app.pcm_equipe());
DROP POLICY IF EXISTS batelada_correcao_ins ON pcm.batelada_correcao;
CREATE POLICY batelada_correcao_ins ON pcm.batelada_correcao FOR INSERT TO biotrop_app
  WITH CHECK (app.pcm_gestao() AND por = app.usuario_atual());

-- trava no banco: fora da gestão, o contador do tanque só sobe
CREATE OR REPLACE FUNCTION pcm.tg_batelada_so_aumenta() RETURNS trigger
LANGUAGE plpgsql SET search_path = pcm, app, pg_temp AS $$
DECLARE v_antes integer;
BEGIN
  -- dois IFs: sem usuário na sessão, app.pcm_gestao() nem pode ser chamada
  IF coalesce(current_setting('app.usuario_id', true), '') = '' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF app.pcm_gestao() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Só o PCM apaga um apontamento de bateladas.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.acumulado < OLD.acumulado THEN
    RAISE EXCEPTION 'O contador de bateladas só aumenta (estava em %).', OLD.acumulado USING ERRCODE = '42501';
  END IF;
  SELECT l.acumulado INTO v_antes FROM pcm.batelada_leitura l
   WHERE l.ativo_id = NEW.ativo_id AND l.data < NEW.data ORDER BY l.data DESC LIMIT 1;
  IF v_antes IS NOT NULL AND NEW.acumulado < v_antes THEN
    RAISE EXCEPTION 'O contador de bateladas só aumenta (o anterior é %).', v_antes USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tg_batelada_so_aumenta ON pcm.batelada_leitura;
CREATE TRIGGER tg_batelada_so_aumenta BEFORE INSERT OR UPDATE OR DELETE ON pcm.batelada_leitura
  FOR EACH ROW EXECUTE FUNCTION pcm.tg_batelada_so_aumenta();

COMMIT;
