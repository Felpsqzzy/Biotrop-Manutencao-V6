-- Acesso ao terminal do almoxarifado (fase 4 do empréstimo): credencial matrícula + senha, convite de primeiro acesso e
-- de redefinição, tentativas com bloqueio temporário progressivo (por matrícula e por aparelho) e sessões do tablet.
-- Separado do login do site: nada daqui vira sessão do site, e a sessão do site não abre o terminal.
-- As quatro tabelas têm RLS ligado com uma policy RESTRITIVA que nega tudo a quem não é o dono: a role da API não lê nem
-- escreve nada direto (nem se outra migration der GRANT no schema emprestimo, como a 40 faz ao ser reaplicada); só as
-- funções SECURITY DEFINER abaixo, com search_path fixo, mexem nelas. O hash da senha é calculado no Node (scrypt,
-- server/src/lib/senha-terminal.js): o banco guarda o texto versionado e só o devolve na conferência do login, que já
-- reserva a tentativa. Código de convite: só o HMAC. IP: só o HMAC. Nenhuma senha, código ou cookie na auditoria.
-- Idempotente: o migrate.js reaplica esta migration a cada deploy; não apaga nada da 40.
BEGIN;

/* ---------------------------------------------------------------- tabelas */
CREATE TABLE IF NOT EXISTS emprestimo.terminal_credencial (
 usuario_id uuid PRIMARY KEY REFERENCES emprestimo.colaborador(usuario_id),
 senha_hash text CHECK (senha_hash IS NULL OR (length(senha_hash) BETWEEN 20 AND 400 AND senha_hash ~ '^[a-z0-9]+[$]')),   -- nulo: sem senha (convite pendente)
 versao integer NOT NULL DEFAULT 1 CHECK (versao >= 1),            -- vai no cookie: troca de senha, redefinição e bloqueio incrementam
 bloqueado boolean NOT NULL DEFAULT false,                          -- bloqueio pelo painel, até alguém desbloquear
 falhas integer NOT NULL DEFAULT 0 CHECK (falhas >= 0),             -- erros seguidos; cada tentativa é reservada antes da conferência
 nivel_bloqueio integer NOT NULL DEFAULT 0 CHECK (nivel_bloqueio BETWEEN 0 AND 3),   -- próximo bloqueio: 5 min, 15 min, 1 h
 bloqueado_ate timestamptz,                                          -- bloqueio temporário por erros
 senha_definida_em timestamptz, ultimo_acesso timestamptz,
 criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS emprestimo.terminal_convite (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 usuario_id uuid NOT NULL REFERENCES emprestimo.colaborador(usuario_id),
 codigo_hash text NOT NULL CHECK (codigo_hash ~ '^[0-9a-f]{64}$'),   -- HMAC do código; o código só aparece uma vez, na tela de quem gerou
 tipo text NOT NULL CHECK (tipo IN ('primeiro_acesso','redefinicao')),
 expira timestamptz NOT NULL,
 criado_por uuid NOT NULL REFERENCES core.usuario(id), criado_em timestamptz NOT NULL DEFAULT now(),
 usado_em timestamptz, invalidado_em timestamptz
);
-- um convite em aberto por pessoa: gerar outro invalida o anterior
CREATE UNIQUE INDEX IF NOT EXISTS terminal_convite_aberto_uq ON emprestimo.terminal_convite (usuario_id) WHERE usado_em IS NULL AND invalidado_em IS NULL;
CREATE TABLE IF NOT EXISTS emprestimo.terminal_tentativa (
 id bigserial PRIMARY KEY,
 tipo text NOT NULL CHECK (tipo IN ('entrar','primeiro_acesso','saida_admin')),
 resultado text NOT NULL CHECK (resultado IN ('ok','senha','codigo','inexistente','inativo','bloqueado','sem_senha','bloqueio_temporario','limite_ip','perfil','sem_2fa','2fa','pendente')),
 usuario_id uuid REFERENCES core.usuario(id),                          -- só quando a matrícula existe: o texto digitado nunca é guardado
 ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),              -- HMAC do IP: conta erros por aparelho sem gravar o endereço
 em timestamptz NOT NULL DEFAULT now()
);
-- 'pendente': tentativa reservada antes da conferência (já conta no limite do aparelho); o fim troca pelo resultado.
-- Refeita a cada deploy (banco criado antes desta lista não tinha 'pendente').
ALTER TABLE emprestimo.terminal_tentativa DROP CONSTRAINT IF EXISTS terminal_tentativa_resultado_check;
ALTER TABLE emprestimo.terminal_tentativa ADD CONSTRAINT terminal_tentativa_resultado_check
  CHECK (resultado IN ('ok','senha','codigo','inexistente','inativo','bloqueado','sem_senha','bloqueio_temporario','limite_ip','perfil','sem_2fa','2fa','pendente'));
CREATE INDEX IF NOT EXISTS terminal_tentativa_ip_idx ON emprestimo.terminal_tentativa (ip_hash, em);
CREATE INDEX IF NOT EXISTS terminal_tentativa_usuario_idx ON emprestimo.terminal_tentativa (usuario_id, em);
CREATE INDEX IF NOT EXISTS terminal_tentativa_em_idx ON emprestimo.terminal_tentativa (em);
CREATE TABLE IF NOT EXISTS emprestimo.terminal_sessao (
 sid_hash text PRIMARY KEY CHECK (sid_hash ~ '^[0-9a-f]{64}$'),        -- só o hash do identificador; o cookie nunca é guardado
 usuario_id uuid NOT NULL REFERENCES emprestimo.colaborador(usuario_id),
 versao integer NOT NULL,                                              -- versão da credencial no login
 usuario_sv integer NOT NULL,                                          -- core.usuario.sessao_versao no login: bloqueio no site também derruba
 criada_em timestamptz NOT NULL DEFAULT now(), ultimo_uso timestamptz NOT NULL DEFAULT now(), expira timestamptz NOT NULL,
 encerrada_em timestamptz, motivo text NOT NULL DEFAULT '' CHECK (length(motivo) <= 40)
);
CREATE INDEX IF NOT EXISTS terminal_sessao_aberta_idx ON emprestimo.terminal_sessao (usuario_id) WHERE encerrada_em IS NULL;
COMMENT ON TABLE emprestimo.terminal_credencial IS 'Senha do terminal (hash scrypt versionado), versão, bloqueio e erros. Só as funções emprestimo.terminal_* leem e escrevem.';
COMMENT ON TABLE emprestimo.terminal_convite IS 'Convite de primeiro acesso/redefinição: uso único, 72 h, guardado só como HMAC.';
COMMENT ON TABLE emprestimo.terminal_tentativa IS 'Toda tentativa de entrar, de primeiro acesso e de saída administrativa (sem o texto digitado). Base do limite por aparelho.';
COMMENT ON TABLE emprestimo.terminal_sessao IS 'Sessões do tablet (hash do sid). Inatividade, validade de 30 min e encerramento conferidos a cada requisição.';

/* ---------------------------------------------------------------- RLS: fechado para todos; só as funções (dono) acessam */
ALTER TABLE emprestimo.terminal_credencial ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.terminal_convite ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.terminal_tentativa ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.terminal_sessao ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terminal_credencial_fechada ON emprestimo.terminal_credencial;
CREATE POLICY terminal_credencial_fechada ON emprestimo.terminal_credencial AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS terminal_convite_fechada ON emprestimo.terminal_convite;
CREATE POLICY terminal_convite_fechada ON emprestimo.terminal_convite AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS terminal_tentativa_fechada ON emprestimo.terminal_tentativa;
CREATE POLICY terminal_tentativa_fechada ON emprestimo.terminal_tentativa AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS terminal_sessao_fechada ON emprestimo.terminal_sessao;
CREATE POLICY terminal_sessao_fechada ON emprestimo.terminal_sessao AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
-- a 40, reaplicada antes desta, dá SELECT em todas as tabelas do schema: aqui volta a ficar sem nada
REVOKE ALL ON emprestimo.terminal_credencial, emprestimo.terminal_convite, emprestimo.terminal_tentativa, emprestimo.terminal_sessao FROM PUBLIC, biotrop_app, biotrop_ro;
REVOKE ALL ON SEQUENCE emprestimo.terminal_tentativa_id_seq FROM PUBLIC, biotrop_app, biotrop_ro;

/* ---------------------------------------------------------------- apoio (sem GRANT: só as funções abaixo chamam) */
CREATE OR REPLACE FUNCTION emprestimo.terminal_registrar(p_tipo text, p_resultado text, p_usuario uuid, p_ip_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
  INSERT INTO emprestimo.terminal_tentativa (tipo, resultado, usuario_id, ip_hash) VALUES (p_tipo, p_resultado, p_usuario, p_ip_hash);
  DELETE FROM emprestimo.terminal_tentativa WHERE em < now() - interval '180 days';
$$;
-- Aparelho com muitos erros nos últimos 15 min. O tablet é um IP só para todo mundo: limite folgado (30 erros de
-- qualquer matrícula); o limite apertado é o da matrícula (terminal_aplicar_bloqueio).
CREATE OR REPLACE FUNCTION emprestimo.terminal_ip_excedido(p_ip_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
  SELECT count(*) >= 30 FROM emprestimo.terminal_tentativa
   WHERE ip_hash = p_ip_hash AND em > now() - interval '15 minutes' AND resultado NOT IN ('ok','limite_ip')
$$;
CREATE OR REPLACE FUNCTION emprestimo.terminal_encerrar_de(p_usuario uuid, p_motivo text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
  UPDATE emprestimo.terminal_sessao SET encerrada_em = now(), motivo = p_motivo WHERE usuario_id = p_usuario AND encerrada_em IS NULL;
$$;
-- 5 erros seguidos (senha, código de convite, 2FA da saída) → bloqueio temporário progressivo: 5 min, 15 min, depois 1 h;
-- a contagem recomeça. O nível volta a zero com um acesso certo, com o desbloqueio no painel ou 24 h depois do último bloqueio.
CREATE OR REPLACE FUNCTION emprestimo.terminal_aplicar_bloqueio(p_usuario uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
DECLARE cr emprestimo.terminal_credencial%ROWTYPE; nivel integer; minutos integer;
BEGIN
 SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = p_usuario FOR UPDATE;
 IF NOT FOUND OR cr.falhas < 5 THEN RETURN; END IF;
 nivel := CASE WHEN cr.bloqueado_ate IS NULL OR cr.bloqueado_ate < now() - interval '24 hours' THEN 0 ELSE cr.nivel_bloqueio END;
 minutos := CASE nivel WHEN 0 THEN 5 WHEN 1 THEN 15 ELSE 60 END;
 UPDATE emprestimo.terminal_credencial SET falhas = 0, nivel_bloqueio = least(nivel + 1, 3), bloqueado_ate = now() + make_interval(mins => minutos), atualizado_em = now()
  WHERE usuario_id = p_usuario;
 INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_bloqueio_temporario', p_usuario, jsonb_build_object('minutos', minutos), p_usuario);
END $$;
-- Reserva a tentativa do aparelho ANTES do trabalho caro (o scrypt, no Node): a linha 'pendente' já conta no limite, e a
-- trava consultiva por aparelho (até o fim da transação) faz conferir e reservar de uma vez só — pedidos simultâneos do
-- mesmo IP não passam juntos dos 30. Passou do limite: registra 'limite_ip' e devolve false (a rota responde 429 sem
-- calcular hash). A reserva vira o resultado final em terminal_concluir_tentativa; a que não volta segue contando como erro.
CREATE OR REPLACE FUNCTION emprestimo.terminal_reservar_tentativa(p_tipo text, p_ip_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
BEGIN
 IF coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_tipo, '') NOT IN ('entrar','primeiro_acesso','saida_admin') THEN RAISE EXCEPTION 'Tentativa inválida.' USING ERRCODE = '22023'; END IF;
 PERFORM pg_advisory_xact_lock(4101, hashtext(p_ip_hash));
 IF emprestimo.terminal_ip_excedido(p_ip_hash) THEN
   PERFORM emprestimo.terminal_registrar(p_tipo, 'limite_ip', NULL, p_ip_hash);
   RETURN false;
 END IF;
 PERFORM emprestimo.terminal_registrar(p_tipo, 'pendente', NULL, p_ip_hash);
 RETURN true;
END $$;
-- Troca a reserva mais recente deste aparelho e deste tipo pelo resultado (as reservas simultâneas são equivalentes: cada
-- conclusão fecha uma). Sem reserva (chamada direta), registra uma tentativa nova.
CREATE OR REPLACE FUNCTION emprestimo.terminal_concluir_tentativa(p_tipo text, p_resultado text, p_usuario uuid, p_ip_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
DECLARE tid bigint;
BEGIN
 SELECT id INTO tid FROM emprestimo.terminal_tentativa
  WHERE ip_hash = p_ip_hash AND tipo = p_tipo AND resultado = 'pendente' AND em > now() - interval '1 hour'
  ORDER BY id DESC LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF tid IS NULL THEN PERFORM emprestimo.terminal_registrar(p_tipo, p_resultado, p_usuario, p_ip_hash);
 ELSE UPDATE emprestimo.terminal_tentativa SET resultado = p_resultado, usuario_id = p_usuario WHERE id = tid; END IF;
END $$;
REVOKE ALL ON FUNCTION emprestimo.terminal_registrar(text, text, uuid, text), emprestimo.terminal_ip_excedido(text),
  emprestimo.terminal_encerrar_de(uuid, text), emprestimo.terminal_aplicar_bloqueio(uuid), emprestimo.terminal_concluir_tentativa(text, text, uuid, text) FROM PUBLIC;

/* ---------------------------------------------------------------- apoio da API (só leitura de parâmetros) */
-- Parâmetros (algoritmo e custo) dos hashes gravados, sem sal nem hash ('scrypt$1$131072$8$1'): a conferência no Node
-- calcula um scrypt de cada conjunto em TODO login (o real num deles, ou só fictícios). Depois de mudar
-- TERMINAL_SCRYPT_LOG2N, quem ainda tem hash antigo e quem não existe levam o mesmo tempo.
CREATE OR REPLACE FUNCTION emprestimo.terminal_parametros_hash() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
  SELECT coalesce(array_agg(x.p ORDER BY x.p), '{}') FROM (
    SELECT DISTINCT array_to_string((string_to_array(senha_hash, '$'))[1:5], '$') AS p FROM emprestimo.terminal_credencial WHERE senha_hash IS NOT NULL LIMIT 8) x
$$;
-- Prazo padrão da retirada (horas): o resumo do tablet mostra a data prevista de devolução antes de confirmar.
CREATE OR REPLACE FUNCTION emprestimo.terminal_prazo_padrao() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$ SELECT prazo_padrao_horas FROM emprestimo.config WHERE id $$;

/* ---------------------------------------------------------------- situação do acesso (painel) */
CREATE OR REPLACE FUNCTION emprestimo.terminal_acessos(p_usuario uuid DEFAULT NULL)
RETURNS TABLE(usuario_id uuid, situacao text, ultimo_acesso timestamptz, convite_expira_em timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = emprestimo, core, app, pg_temp AS $$
  SELECT c.usuario_id,
         CASE WHEN cr.bloqueado THEN 'bloqueado'
              WHEN cr.bloqueado_ate > now() THEN 'bloqueado_temporario'
              WHEN cr.senha_hash IS NOT NULL THEN 'ativo'
              WHEN cv.expira > now() THEN 'convite_pendente'
              ELSE 'sem_acesso' END,
         cr.ultimo_acesso, CASE WHEN cv.expira > now() THEN cv.expira END
    FROM emprestimo.colaborador c
    LEFT JOIN emprestimo.terminal_credencial cr ON cr.usuario_id = c.usuario_id
    LEFT JOIN emprestimo.terminal_convite cv ON cv.usuario_id = c.usuario_id AND cv.usado_em IS NULL AND cv.invalidado_em IS NULL
   WHERE emprestimo.gestao() AND (p_usuario IS NULL OR c.usuario_id = p_usuario)
$$;

/* ---------------------------------------------------------------- login (entrar e saída administrativa) */
-- 1ª metade: limite do aparelho (com a tentativa já reservada nele), situação da matrícula e, se dá para conferir,
-- RESERVA também na matrícula (falhas + 1) antes de o Node conferir a senha: várias tentativas ao mesmo tempo não
-- passam de nenhum dos dois limites. O hash só sai daqui, e só nesse caso. Matrícula sem diferenciar maiúsculas.
CREATE OR REPLACE FUNCTION emprestimo.terminal_login_inicio(p_matricula text, p_ip_hash text, p_tipo text)
RETURNS TABLE(situacao text, usuario_id uuid, senha_hash text, versao integer, perfil_id text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, pg_temp AS $$
#variable_conflict use_column
DECLARE c emprestimo.colaborador%ROWTYPE; u core.usuario%ROWTYPE; cr emprestimo.terminal_credencial%ROWTYPE; sit text;
BEGIN
 IF coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_tipo, '') NOT IN ('entrar','saida_admin') THEN RAISE EXCEPTION 'Tentativa inválida.' USING ERRCODE = '22023'; END IF;
 IF NOT emprestimo.terminal_reservar_tentativa(p_tipo, p_ip_hash) THEN
   RETURN QUERY SELECT 'limite_ip'::text, NULL::uuid, NULL::text, NULL::integer, NULL::text, NULL::text;
   RETURN;
 END IF;
 SELECT * INTO c FROM emprestimo.colaborador WHERE upper(matricula) = upper(btrim(coalesce(p_matricula, '')));
 IF NOT FOUND THEN
   RETURN QUERY SELECT 'inexistente'::text, NULL::uuid, NULL::text, NULL::integer, NULL::text, NULL::text;
   RETURN;
 END IF;
 SELECT * INTO u FROM core.usuario WHERE id = c.usuario_id;
 SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = c.usuario_id FOR UPDATE;
 -- 5 reservas que não voltaram (tentativas simultâneas ou interrompidas) já valem como bloqueio
 IF cr.falhas >= 5 AND (cr.bloqueado_ate IS NULL OR cr.bloqueado_ate <= now()) THEN
   PERFORM emprestimo.terminal_aplicar_bloqueio(c.usuario_id);
   SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = c.usuario_id;
 END IF;
 sit := CASE WHEN NOT c.ativo OR NOT u.ativo THEN 'inativo'
             WHEN u.bloqueado OR coalesce(cr.bloqueado, false) THEN 'bloqueado'
             WHEN cr.senha_hash IS NULL THEN 'sem_senha'
             WHEN coalesce(cr.bloqueado_ate > now(), false) THEN 'bloqueio_temporario'
             ELSE 'verificar' END;
 IF sit = 'verificar' THEN UPDATE emprestimo.terminal_credencial SET falhas = falhas + 1 WHERE usuario_id = c.usuario_id; END IF;
 RETURN QUERY SELECT sit, c.usuario_id, CASE WHEN sit = 'verificar' THEN cr.senha_hash END, cr.versao, u.perfil_id::text, u.email::text;
END $$;

-- 2ª metade, com o resultado final (senha conferida no Node; na saída administrativa, também perfil e 2FA). Registra a
-- tentativa; erro conta para o bloqueio; acerto zera a contagem, regrava o hash se os parâmetros mudaram e, em 'entrar',
-- abre a sessão (30 min de validade, inatividade conforme emprestimo.config).
CREATE OR REPLACE FUNCTION emprestimo.terminal_login_fim(p_usuario uuid, p_ip_hash text, p_tipo text, p_resultado text, p_versao integer, p_sid_hash text, p_novo_hash text)
RETURNS TABLE(usuario_id uuid, nome text, email text, matricula text, setor text, centro_custo text, cargo text, versao integer, inatividade integer, expira_em timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, pg_temp AS $$
#variable_conflict use_column
DECLARE c emprestimo.colaborador%ROWTYPE; u core.usuario%ROWTYPE; cr emprestimo.terminal_credencial%ROWTYPE; res text := p_resultado; ina integer;
BEGIN
 IF coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_tipo, '') NOT IN ('entrar','saida_admin')
    OR coalesce(p_resultado, '') NOT IN ('ok','senha','inexistente','inativo','bloqueado','sem_senha','bloqueio_temporario','perfil','sem_2fa','2fa') THEN
   RAISE EXCEPTION 'Tentativa inválida.' USING ERRCODE = '22023'; END IF;
 IF res = 'ok' THEN
   SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = p_usuario FOR UPDATE;
   SELECT * INTO c FROM emprestimo.colaborador WHERE usuario_id = p_usuario;
   SELECT * INTO u FROM core.usuario WHERE id = p_usuario;
   -- a credencial mudou entre a conferência e aqui (redefinição, bloqueio, desligamento): não entra
   IF cr.usuario_id IS NULL OR cr.versao IS DISTINCT FROM p_versao OR coalesce(cr.bloqueado, true) OR cr.senha_hash IS NULL
      OR coalesce(cr.bloqueado_ate > now(), false) OR NOT coalesce(c.ativo, false) OR NOT coalesce(u.ativo, false) OR coalesce(u.bloqueado, true) THEN
     res := 'bloqueado';
   END IF;
 END IF;
 PERFORM emprestimo.terminal_concluir_tentativa(p_tipo, res, p_usuario, p_ip_hash);
 IF res <> 'ok' THEN
   -- a tentativa foi reservada no início (a senha chegou a ser conferida): conta para o bloqueio temporário
   IF p_usuario IS NOT NULL AND res IN ('senha','perfil','sem_2fa','2fa') THEN PERFORM emprestimo.terminal_aplicar_bloqueio(p_usuario); END IF;
   RETURN;
 END IF;
 UPDATE emprestimo.terminal_credencial SET falhas = 0, nivel_bloqueio = 0, bloqueado_ate = NULL, senha_hash = coalesce(p_novo_hash, senha_hash),
        ultimo_acesso = CASE WHEN p_tipo = 'entrar' THEN now() ELSE ultimo_acesso END, atualizado_em = now()
  WHERE usuario_id = p_usuario;
 IF p_tipo = 'saida_admin' THEN
   INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_saida_admin', p_usuario, jsonb_build_object('perfil', u.perfil_id), p_usuario);
   RETURN QUERY SELECT p_usuario, u.nome::text, u.email::text, c.matricula, c.setor, c.centro_custo, c.cargo, cr.versao, NULL::integer, NULL::timestamptz;
   RETURN;
 END IF;
 IF coalesce(p_sid_hash, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '22023'; END IF;
 SELECT inatividade_segundos INTO ina FROM emprestimo.config WHERE id;
 DELETE FROM emprestimo.terminal_sessao WHERE expira < now() - interval '1 day';
 INSERT INTO emprestimo.terminal_sessao (sid_hash, usuario_id, versao, usuario_sv, expira) VALUES (p_sid_hash, p_usuario, cr.versao, u.sessao_versao, now() + interval '30 minutes');
 INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_login', p_usuario, jsonb_build_object('via', 'senha'), p_usuario);
 RETURN QUERY SELECT p_usuario, u.nome::text, u.email::text, c.matricula, c.setor, c.centro_custo, c.cargo, cr.versao, ina,
   least(now() + make_interval(secs => ina), now() + interval '30 minutes');
END $$;

/* ---------------------------------------------------------------- primeiro acesso / redefinição pelo convite */
-- Uma transação só: confere o convite (uso único, 72 h), grava a senha nova (hash feito no Node), sobe a versão (outras
-- sessões caem), marca o convite como usado e já abre a sessão. Código errado conta para o bloqueio da matrícula.
-- A rota reserva a tentativa do aparelho ANTES do scrypt (terminal_reservar_tentativa) e aqui ela é concluída; sem
-- reserva (chamada direta), o limite do aparelho é conferido aqui, como antes. Matrícula sem diferenciar maiúsculas.
CREATE OR REPLACE FUNCTION emprestimo.terminal_primeiro_acesso(p_matricula text, p_codigo_hash text, p_senha_hash text, p_ip_hash text, p_sid_hash text)
RETURNS TABLE(situacao text, usuario_id uuid, nome text, email text, matricula text, setor text, centro_custo text, cargo text, versao integer, inatividade integer, expira_em timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, pg_temp AS $$
#variable_conflict use_column
DECLARE c emprestimo.colaborador%ROWTYPE; u core.usuario%ROWTYPE; cr emprestimo.terminal_credencial%ROWTYPE; cv emprestimo.terminal_convite%ROWTYPE;
 res text; ina integer; tid bigint;
BEGIN
 IF coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_sid_hash, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_codigo_hash, '') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_senha_hash, '') !~ '^[a-z0-9]+[$]' THEN RAISE EXCEPTION 'Tentativa inválida.' USING ERRCODE = '22023'; END IF;
 PERFORM pg_advisory_xact_lock(4101, hashtext(p_ip_hash));
 SELECT t.id INTO tid FROM emprestimo.terminal_tentativa t
  WHERE t.ip_hash = p_ip_hash AND t.tipo = 'primeiro_acesso' AND t.resultado = 'pendente' AND t.em > now() - interval '1 hour'
  ORDER BY t.id DESC LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF tid IS NULL AND emprestimo.terminal_ip_excedido(p_ip_hash) THEN
   PERFORM emprestimo.terminal_registrar('primeiro_acesso', 'limite_ip', NULL, p_ip_hash);
   RETURN QUERY SELECT 'limite_ip'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz;
   RETURN;
 END IF;
 SELECT * INTO c FROM emprestimo.colaborador c0 WHERE upper(c0.matricula) = upper(btrim(coalesce(p_matricula, '')));
 IF NOT FOUND THEN res := 'inexistente';
 ELSE
   SELECT * INTO u FROM core.usuario WHERE id = c.usuario_id;
   SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = c.usuario_id FOR UPDATE;
   IF NOT c.ativo OR NOT u.ativo THEN res := 'inativo';
   ELSIF u.bloqueado OR coalesce(cr.bloqueado, false) THEN res := 'bloqueado';
   ELSIF cr.usuario_id IS NULL THEN res := 'codigo';                    -- nunca recebeu convite
   ELSIF coalesce(cr.bloqueado_ate > now(), false) THEN res := 'bloqueio_temporario';
   ELSE
     SELECT * INTO cv FROM emprestimo.terminal_convite WHERE usuario_id = c.usuario_id AND usado_em IS NULL AND invalidado_em IS NULL FOR UPDATE;
     res := CASE WHEN NOT FOUND OR cv.expira <= now() OR cv.codigo_hash <> p_codigo_hash THEN 'codigo' ELSE 'ok' END;
   END IF;
 END IF;
 IF tid IS NULL THEN PERFORM emprestimo.terminal_registrar('primeiro_acesso', res, c.usuario_id, p_ip_hash);
 ELSE UPDATE emprestimo.terminal_tentativa t SET resultado = res, usuario_id = c.usuario_id WHERE t.id = tid; END IF;
 IF res <> 'ok' THEN
   IF res = 'codigo' AND cr.usuario_id IS NOT NULL THEN
     UPDATE emprestimo.terminal_credencial SET falhas = falhas + 1, atualizado_em = now() WHERE usuario_id = c.usuario_id;
     PERFORM emprestimo.terminal_aplicar_bloqueio(c.usuario_id);
   END IF;
   RETURN QUERY SELECT 'invalido'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::integer, NULL::timestamptz;
   RETURN;
 END IF;
 UPDATE emprestimo.terminal_convite SET usado_em = now() WHERE id = cv.id;
 UPDATE emprestimo.terminal_credencial SET senha_hash = p_senha_hash, versao = versao + 1, falhas = 0, nivel_bloqueio = 0, bloqueado_ate = NULL,
        senha_definida_em = now(), ultimo_acesso = now(), atualizado_em = now()
  WHERE usuario_id = c.usuario_id RETURNING * INTO cr;
 PERFORM emprestimo.terminal_encerrar_de(c.usuario_id, 'senha_trocada');
 SELECT inatividade_segundos INTO ina FROM emprestimo.config WHERE id;
 DELETE FROM emprestimo.terminal_sessao WHERE expira < now() - interval '1 day';
 INSERT INTO emprestimo.terminal_sessao (sid_hash, usuario_id, versao, usuario_sv, expira) VALUES (p_sid_hash, c.usuario_id, cr.versao, u.sessao_versao, now() + interval '30 minutes');
 INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_senha_definida', c.usuario_id, jsonb_build_object('tipo', cv.tipo), c.usuario_id);
 INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_login', c.usuario_id, jsonb_build_object('via', 'convite'), c.usuario_id);
 RETURN QUERY SELECT 'ok'::text, c.usuario_id, u.nome::text, u.email::text, c.matricula, c.setor, c.centro_custo, c.cargo, cr.versao, ina,
   least(now() + make_interval(secs => ina), now() + interval '30 minutes');
END $$;

/* ---------------------------------------------------------------- sessão do tablet */
-- A cada requisição: sessão aberta, dentro da validade e da inatividade, mesma versão da credencial, colaborador ativo e
-- sem bloqueio (no terminal e no site). Falhou: encerra aqui mesmo (com o motivo) e não devolve nada. Passou: renova.
CREATE OR REPLACE FUNCTION emprestimo.terminal_sessao_validar(p_sid_hash text, p_usuario uuid, p_versao integer)
RETURNS TABLE(usuario_id uuid, nome text, email text, matricula text, setor text, centro_custo text, cargo text, inatividade integer, expira_em timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, pg_temp AS $$
#variable_conflict use_column
DECLARE s emprestimo.terminal_sessao%ROWTYPE; c emprestimo.colaborador%ROWTYPE; u core.usuario%ROWTYPE; cr emprestimo.terminal_credencial%ROWTYPE;
 ina integer; mot text;
BEGIN
 IF coalesce(p_sid_hash, '') !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
 SELECT * INTO s FROM emprestimo.terminal_sessao WHERE sid_hash = p_sid_hash FOR UPDATE;
 IF NOT FOUND OR s.encerrada_em IS NOT NULL OR s.usuario_id IS DISTINCT FROM p_usuario OR s.versao IS DISTINCT FROM p_versao THEN RETURN; END IF;
 SELECT inatividade_segundos INTO ina FROM emprestimo.config WHERE id;
 SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = s.usuario_id;
 SELECT * INTO c FROM emprestimo.colaborador WHERE usuario_id = s.usuario_id;
 SELECT * INTO u FROM core.usuario WHERE id = s.usuario_id;
 mot := CASE WHEN s.expira <= now() THEN 'validade'
             WHEN s.ultimo_uso + make_interval(secs => ina) <= now() THEN 'inatividade'
             WHEN cr.usuario_id IS NULL OR cr.versao <> s.versao OR cr.bloqueado OR cr.senha_hash IS NULL THEN 'credencial'
             WHEN NOT coalesce(c.ativo, false) OR NOT coalesce(u.ativo, false) OR coalesce(u.bloqueado, true) OR u.sessao_versao <> s.usuario_sv THEN 'desligado'
        END;
 IF mot IS NOT NULL THEN
   UPDATE emprestimo.terminal_sessao SET encerrada_em = now(), motivo = mot WHERE sid_hash = p_sid_hash;
   RETURN;
 END IF;
 UPDATE emprestimo.terminal_sessao SET ultimo_uso = now() WHERE sid_hash = p_sid_hash;
 RETURN QUERY SELECT s.usuario_id, u.nome::text, u.email::text, c.matricula, c.setor, c.centro_custo, c.cargo, ina, least(now() + make_interval(secs => ina), s.expira);
END $$;
-- "Sair" (e a saída administrativa): encerra no servidor; uma cópia do cookie não volta a valer.
CREATE OR REPLACE FUNCTION emprestimo.terminal_sessao_encerrar(p_sid_hash text, p_motivo text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, pg_temp AS $$
DECLARE s emprestimo.terminal_sessao%ROWTYPE;
BEGIN
 IF coalesce(p_sid_hash, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_motivo, '') NOT IN ('logout','saida_admin','troca') THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '22023'; END IF;
 UPDATE emprestimo.terminal_sessao SET encerrada_em = now(), motivo = p_motivo WHERE sid_hash = p_sid_hash AND encerrada_em IS NULL RETURNING * INTO s;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_logout', s.usuario_id, jsonb_build_object('motivo', p_motivo), s.usuario_id);
 RETURN true;
END $$;

/* ---------------------------------------------------------------- painel: convite e bloqueio */
-- Gestão (admin, gestor, almoxarife) gera o convite; conta de admin/gestor só pela gerência (sem isso um almoxarife
-- definiria a senha e entraria no tablet como outra pessoa). Já havia senha → redefinição: a senha antiga deixa de
-- valer e as sessões caem. Gerar outro invalida o anterior. Colaborador inativo ou bloqueado não recebe.
CREATE OR REPLACE FUNCTION emprestimo.terminal_convite_gerar(p_usuario uuid, p_codigo_hash text)
RETURNS TABLE(expira_em timestamptz, redefinicao boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, app, pg_temp AS $$
#variable_conflict use_column
DECLARE c emprestimo.colaborador%ROWTYPE; u core.usuario%ROWTYPE; cr emprestimo.terminal_credencial%ROWTYPE; redef boolean;
 exp timestamptz := now() + interval '72 hours'; quem uuid;
BEGIN
 IF NOT emprestimo.gestao() THEN RAISE EXCEPTION 'Somente almoxarifado, gestão e administração.' USING ERRCODE = '42501'; END IF;
 IF coalesce(p_codigo_hash, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Código inválido.' USING ERRCODE = '22023'; END IF;
 quem := app.usuario_atual();
 SELECT * INTO c FROM emprestimo.colaborador WHERE usuario_id = p_usuario;
 IF NOT FOUND THEN RAISE EXCEPTION 'Colaborador não cadastrado no terminal.' USING ERRCODE = 'P0002'; END IF;
 SELECT * INTO u FROM core.usuario WHERE id = p_usuario;
 IF u.perfil_id IN ('admin','gestor') AND NOT emprestimo.gerencia() THEN
   RAISE EXCEPTION 'Convite ou redefinição de conta de administrador ou gestor só pela gerência.' USING ERRCODE = '42501'; END IF;
 IF NOT c.ativo OR NOT u.ativo OR u.bloqueado THEN RAISE EXCEPTION 'Colaborador inativo ou bloqueado não recebe convite.' USING ERRCODE = 'P0001'; END IF;
 INSERT INTO emprestimo.terminal_credencial (usuario_id) VALUES (p_usuario) ON CONFLICT DO NOTHING;
 SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = p_usuario FOR UPDATE;
 IF cr.bloqueado THEN RAISE EXCEPTION 'O acesso ao terminal está bloqueado: desbloqueie antes de gerar o convite.' USING ERRCODE = 'P0001'; END IF;
 redef := cr.senha_definida_em IS NOT NULL;
 UPDATE emprestimo.terminal_credencial SET senha_hash = NULL, versao = versao + 1, falhas = 0, nivel_bloqueio = 0, bloqueado_ate = NULL, atualizado_em = now()
  WHERE usuario_id = p_usuario;
 UPDATE emprestimo.terminal_convite SET invalidado_em = now() WHERE usuario_id = p_usuario AND usado_em IS NULL AND invalidado_em IS NULL;
 INSERT INTO emprestimo.terminal_convite (usuario_id, codigo_hash, tipo, expira, criado_por)
 VALUES (p_usuario, p_codigo_hash, CASE WHEN redef THEN 'redefinicao' ELSE 'primeiro_acesso' END, exp, quem);
 PERFORM emprestimo.terminal_encerrar_de(p_usuario, 'redefinicao');
 INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_convite', p_usuario, jsonb_build_object('redefinicao', redef, 'expiraEm', exp), quem);
 RETURN QUERY SELECT exp, redef;
END $$;
-- Bloqueio (derruba as sessões e invalida convite em aberto) e desbloqueio (zera também o bloqueio temporário), com justificativa.
CREATE OR REPLACE FUNCTION emprestimo.terminal_acesso_definir(p_usuario uuid, p_bloqueado boolean, p_justificativa text)
RETURNS TABLE(usuario_id uuid, situacao text, ultimo_acesso timestamptz, convite_expira_em timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, app, pg_temp AS $$
#variable_conflict use_column
DECLARE c emprestimo.colaborador%ROWTYPE; u core.usuario%ROWTYPE; cr emprestimo.terminal_credencial%ROWTYPE; just text := btrim(coalesce(p_justificativa, '')); quem uuid;
BEGIN
 IF NOT emprestimo.gestao() THEN RAISE EXCEPTION 'Somente almoxarifado, gestão e administração.' USING ERRCODE = '42501'; END IF;
 IF p_bloqueado IS NULL THEN RAISE EXCEPTION 'Informe se o acesso fica bloqueado ou liberado.' USING ERRCODE = '22023'; END IF;
 IF length(just) < 5 THEN RAISE EXCEPTION 'Explique o bloqueio ou o desbloqueio.' USING ERRCODE = '22023'; END IF;
 quem := app.usuario_atual();
 SELECT * INTO c FROM emprestimo.colaborador WHERE usuario_id = p_usuario;
 IF NOT FOUND THEN RAISE EXCEPTION 'Colaborador não cadastrado no terminal.' USING ERRCODE = 'P0002'; END IF;
 SELECT * INTO u FROM core.usuario WHERE id = p_usuario;
 IF u.perfil_id IN ('admin','gestor') AND NOT emprestimo.gerencia() THEN
   RAISE EXCEPTION 'Bloqueio ou desbloqueio de conta de administrador ou gestor só pela gerência.' USING ERRCODE = '42501'; END IF;
 INSERT INTO emprestimo.terminal_credencial (usuario_id) VALUES (p_usuario) ON CONFLICT DO NOTHING;
 SELECT * INTO cr FROM emprestimo.terminal_credencial WHERE usuario_id = p_usuario FOR UPDATE;
 IF p_bloqueado THEN
   UPDATE emprestimo.terminal_credencial SET bloqueado = true, versao = versao + 1, atualizado_em = now() WHERE usuario_id = p_usuario;
   UPDATE emprestimo.terminal_convite SET invalidado_em = now() WHERE usuario_id = p_usuario AND usado_em IS NULL AND invalidado_em IS NULL;
   PERFORM emprestimo.terminal_encerrar_de(p_usuario, 'bloqueio');
   INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('terminal_bloqueio', p_usuario, jsonb_build_object('justificativa', left(just, 500)), quem);
 ELSE
   UPDATE emprestimo.terminal_credencial SET bloqueado = false, falhas = 0, nivel_bloqueio = 0, bloqueado_ate = NULL, atualizado_em = now() WHERE usuario_id = p_usuario;
   INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por)
   VALUES ('terminal_desbloqueio', p_usuario, jsonb_build_object('justificativa', left(just, 500), 'estavaBloqueado', cr.bloqueado,
           'bloqueioTemporario', coalesce(cr.bloqueado_ate > now(), false)), quem);
 END IF;
 RETURN QUERY SELECT * FROM emprestimo.terminal_acessos(p_usuario);
END $$;

REVOKE ALL ON FUNCTION emprestimo.terminal_acessos(uuid), emprestimo.terminal_login_inicio(text, text, text),
  emprestimo.terminal_login_fim(uuid, text, text, text, integer, text, text), emprestimo.terminal_primeiro_acesso(text, text, text, text, text),
  emprestimo.terminal_sessao_validar(text, uuid, integer), emprestimo.terminal_sessao_encerrar(text, text),
  emprestimo.terminal_convite_gerar(uuid, text), emprestimo.terminal_acesso_definir(uuid, boolean, text),
  emprestimo.terminal_reservar_tentativa(text, text), emprestimo.terminal_parametros_hash(), emprestimo.terminal_prazo_padrao() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emprestimo.terminal_acessos(uuid), emprestimo.terminal_login_inicio(text, text, text),
  emprestimo.terminal_login_fim(uuid, text, text, text, integer, text, text), emprestimo.terminal_primeiro_acesso(text, text, text, text, text),
  emprestimo.terminal_sessao_validar(text, uuid, integer), emprestimo.terminal_sessao_encerrar(text, text),
  emprestimo.terminal_convite_gerar(uuid, text), emprestimo.terminal_acesso_definir(uuid, boolean, text),
  emprestimo.terminal_reservar_tentativa(text, text), emprestimo.terminal_parametros_hash(), emprestimo.terminal_prazo_padrao() TO biotrop_app;
COMMIT;
