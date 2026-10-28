-- =====================================================================================
-- 26 · "Sair" encerra a sessão também no servidor
--
-- Antes, sair só apagava o cookie no navegador: uma cópia do cookie (roubada antes) ainda valia até expirar por
-- inatividade (60 min) ou pela validade (10 h). Agora o identificador da sessão (só o hash SHA-256 do sid — o
-- cookie em si nunca é guardado) entra numa lista de sessões encerradas, conferida a cada requisição.
-- "Sair de todos os aparelhos" continua pela versão da sessão (core.usuario.sessao_versao).
-- Linhas vencidas são apagadas sozinhas a cada novo encerramento. Idempotente.
-- =====================================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS seguranca.sessao_encerrada (
  sid_hash  text        PRIMARY KEY CHECK (sid_hash ~ '^[0-9a-f]{64}$'),
  expira    timestamptz NOT NULL,
  em        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE seguranca.sessao_encerrada IS 'Sessões encerradas por "Sair" (hash do sid, nunca o cookie). Vale até a validade original do cookie.';
REVOKE ALL ON seguranca.sessao_encerrada FROM PUBLIC;
ALTER TABLE seguranca.sessao_encerrada ENABLE ROW LEVEL SECURITY;   -- sem policy: só as funções abaixo mexem

CREATE OR REPLACE FUNCTION app.sessao_encerrada(p_sid_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = seguranca, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM seguranca.sessao_encerrada WHERE sid_hash = p_sid_hash AND expira > now())
$$;

CREATE OR REPLACE FUNCTION app.encerrar_sessao(p_sid_hash text, p_expira timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = seguranca, pg_temp AS $$
BEGIN
  IF p_sid_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'sid inválido'; END IF;
  INSERT INTO seguranca.sessao_encerrada (sid_hash, expira)
  VALUES (p_sid_hash, least(p_expira, now() + interval '24 hours'))
  ON CONFLICT (sid_hash) DO NOTHING;
  DELETE FROM seguranca.sessao_encerrada WHERE expira < now();
END $$;

COMMENT ON FUNCTION app.sessao_encerrada(text) IS 'Verdadeiro se a sessão (hash do sid) foi encerrada por "Sair". Consultada a cada requisição pelo requireAuth.';
COMMENT ON FUNCTION app.encerrar_sessao(text, timestamptz) IS 'Registra o encerramento da sessão no logout e apaga os registros vencidos.';
REVOKE ALL ON FUNCTION app.sessao_encerrada(text), app.encerrar_sessao(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sessao_encerrada(text), app.encerrar_sessao(text, timestamptz) TO biotrop_app;

COMMIT;
