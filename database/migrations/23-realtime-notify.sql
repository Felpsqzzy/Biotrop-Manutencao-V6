-- =====================================================================================
-- 23 · Tempo real por aviso do PostgreSQL (LISTEN/NOTIFY) em vez de consulta a cada 3 segundos
--
-- Antes: cada pessoa abria uma conexão de tempo real por módulo (6) e o servidor consultava o banco a cada 3 s
-- em cada uma — com 70 pessoas, ~140 consultas por segundo mesmo sem ninguém mexer em nada.
-- Agora: quando um registro de app.sync_registro muda, o banco avisa no canal "biomanut_sync" só QUAL módulo
-- mudou (nunca o conteúdo). O servidor então busca a mudança para quem está conectado, com o RLS de cada um.
-- Idempotente.
-- =====================================================================================
BEGIN;

CREATE OR REPLACE FUNCTION app.avisar_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- só o nome do módulo: o conteúdo continua passando pelo RLS de cada pessoa ao ser lido
  PERFORM pg_notify('biomanut_sync', COALESCE(NEW.namespace, OLD.namespace));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS tg_avisar_sync ON app.sync_registro;
CREATE TRIGGER tg_avisar_sync AFTER INSERT OR UPDATE OR DELETE ON app.sync_registro
  FOR EACH ROW EXECUTE FUNCTION app.avisar_sync();

COMMIT;
