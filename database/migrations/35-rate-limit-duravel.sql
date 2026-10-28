BEGIN;
CREATE TABLE IF NOT EXISTS seguranca.limite_requisicao (
 chave text PRIMARY KEY CHECK(length(chave)=64), contador integer NOT NULL,
 expira timestamptz NOT NULL
);
REVOKE ALL ON seguranca.limite_requisicao FROM PUBLIC, biotrop_app;
CREATE OR REPLACE FUNCTION app.consumir_limite(p_chave text,p_limite integer,p_janela integer)
RETURNS TABLE(permitido boolean,restante integer,espera integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,seguranca AS $$
DECLARE c integer; e timestamptz;
BEGIN
 IF p_chave !~ '^[a-f0-9]{64}$' OR p_limite NOT BETWEEN 1 AND 10000 OR p_janela NOT BETWEEN 1 AND 86400 THEN RAISE EXCEPTION 'Limite inválido'; END IF;
 INSERT INTO seguranca.limite_requisicao(chave,contador,expira) VALUES(p_chave,1,clock_timestamp()+make_interval(secs=>p_janela))
 ON CONFLICT(chave) DO UPDATE SET contador=CASE WHEN limite_requisicao.expira<=clock_timestamp() THEN 1 ELSE LEAST(limite_requisicao.contador+1,10001) END,
 expira=CASE WHEN limite_requisicao.expira<=clock_timestamp() THEN clock_timestamp()+make_interval(secs=>p_janela) ELSE limite_requisicao.expira END
 RETURNING contador,expira INTO c,e;
 DELETE FROM seguranca.limite_requisicao WHERE expira<clock_timestamp()-interval '1 day';
 RETURN QUERY SELECT c<=p_limite,GREATEST(0,p_limite-c),GREATEST(1,ceil(extract(epoch FROM e-clock_timestamp()))::integer);
END $$;
REVOKE ALL ON FUNCTION app.consumir_limite(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consumir_limite(text,integer,integer) TO biotrop_app;
COMMIT;
