-- Empréstimo de ferramentas e de material do almoxarifado (REG.0306/0305), com terminal de autoatendimento.
-- Padrão do inventário (34/36): a role da API NÃO tem DML nas tabelas; toda escrita passa por emprestimo.executar(),
-- que confere perfil, trava as linhas e grava o histórico. Saldo nunca fica negativo (CHECK), histórico só cresce (trigger).
-- Idempotente: o migrate.js reaplica esta migration a cada deploy.
BEGIN;
CREATE SCHEMA IF NOT EXISTS emprestimo;

-- Perfil do terminal: não aparece em nenhuma policy existente, então não enxerga nada do site.
INSERT INTO core.perfil (id, nome, fixo, descricao)
VALUES ('terminal', 'Terminal do Almoxarifado', false, 'Só usa o terminal de empréstimo (retirar, devolver, consultar). Sem acesso a nenhuma tela ou dado do site.')
ON CONFLICT (id) DO NOTHING;

-- Canal da requisição: a API do terminal define app.canal = 'terminal' na transação. No terminal TODO mundo é só
-- colaborador (até um administrador): gestão e gerência ficam desligadas no banco, não só na tela.
CREATE OR REPLACE FUNCTION emprestimo.no_terminal() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('app.canal', true), '') = 'terminal' $$;
CREATE OR REPLACE FUNCTION emprestimo.gestao() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT NOT emprestimo.no_terminal() AND app.usuario_ativo() AND app.tem_perfil(ARRAY['admin','gestor','almoxarife']) $$;
CREATE OR REPLACE FUNCTION emprestimo.gerencia() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT NOT emprestimo.no_terminal() AND app.usuario_ativo() AND app.tem_perfil(ARRAY['admin','gestor']) $$;
CREATE OR REPLACE FUNCTION emprestimo.operador() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app.usuario_ativo() AND (emprestimo.no_terminal() OR app.tem_perfil(ARRAY['terminal'])) $$;
REVOKE ALL ON FUNCTION emprestimo.no_terminal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emprestimo.no_terminal() TO biotrop_app, biotrop_ro;
REVOKE ALL ON FUNCTION emprestimo.gestao(), emprestimo.gerencia(), emprestimo.operador() FROM PUBLIC;
GRANT USAGE ON SCHEMA emprestimo TO biotrop_app, biotrop_ro;
GRANT EXECUTE ON FUNCTION emprestimo.gestao(), emprestimo.gerencia(), emprestimo.operador() TO biotrop_app, biotrop_ro;

/* ---------------------------------------------------------------- cadastro */
CREATE TABLE IF NOT EXISTS emprestimo.colaborador (
 usuario_id uuid PRIMARY KEY REFERENCES core.usuario(id),
 matricula text NOT NULL UNIQUE CHECK (matricula ~ '^[A-Za-z0-9]{3,20}$'),
 setor text NOT NULL DEFAULT '' CHECK (length(setor) <= 120),
 centro_custo text NOT NULL DEFAULT '' CHECK (length(centro_custo) <= 120),
 cargo text NOT NULL DEFAULT '' CHECK (length(cargo) <= 120),
 ativo boolean NOT NULL DEFAULT true,
 criado_por uuid NOT NULL REFERENCES core.usuario(id), criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS emprestimo.ferramenta (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 codigo text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z0-9][A-Z0-9._/-]{1,39}$'),
 nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 160),
 descricao text NOT NULL DEFAULT '' CHECK (length(descricao) <= 1000),
 categoria text NOT NULL DEFAULT '' CHECK (length(categoria) <= 80),
 marca text NOT NULL DEFAULT '' CHECK (length(marca) <= 80), modelo text NOT NULL DEFAULT '' CHECK (length(modelo) <= 80),
 controle text NOT NULL CHECK (controle IN ('individual','quantidade')),
 localizacao text NOT NULL DEFAULT '' CHECK (length(localizacao) <= 120),
 conservacao text NOT NULL DEFAULT 'boa' CHECK (conservacao IN ('nova','boa','regular','ruim')),
 ativo boolean NOT NULL DEFAULT true,
 criado_por uuid NOT NULL REFERENCES core.usuario(id), criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now()
);
-- Saldo por ferramenta (as duas formas de controle). Para controle individual as unidades abaixo detalham o mesmo saldo.
CREATE TABLE IF NOT EXISTS emprestimo.ferramenta_saldo (
 ferramenta_id uuid PRIMARY KEY REFERENCES emprestimo.ferramenta(id),
 total integer NOT NULL, disponivel integer NOT NULL, emprestada integer NOT NULL DEFAULT 0,
 em_conferencia integer NOT NULL DEFAULT 0, manutencao integer NOT NULL DEFAULT 0, baixada integer NOT NULL DEFAULT 0,
 CHECK (total >= 0 AND disponivel >= 0 AND emprestada >= 0 AND em_conferencia >= 0 AND manutencao >= 0 AND baixada >= 0),
 CHECK (total = disponivel + emprestada + em_conferencia + manutencao + baixada)
);
CREATE TABLE IF NOT EXISTS emprestimo.ferramenta_unidade (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ferramenta_id uuid NOT NULL REFERENCES emprestimo.ferramenta(id),
 identificador text NOT NULL CHECK (length(btrim(identificador)) BETWEEN 1 AND 80),
 estado text NOT NULL DEFAULT 'disponivel' CHECK (estado IN ('disponivel','emprestada','em_conferencia','manutencao','baixada')),
 UNIQUE (ferramenta_id, identificador)
);
CREATE TABLE IF NOT EXISTS emprestimo.config (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 prazo_padrao_horas integer NOT NULL DEFAULT 168 CHECK (prazo_padrao_horas BETWEEN 1 AND 2160),
 lembrete_antes_horas integer NOT NULL DEFAULT 24 CHECK (lembrete_antes_horas BETWEEN 1 AND 720),
 atraso_intervalo_horas integer NOT NULL DEFAULT 24 CHECK (atraso_intervalo_horas BETWEEN 1 AND 720),
 inatividade_segundos integer NOT NULL DEFAULT 90 CHECK (inatividade_segundos BETWEEN 30 AND 900),
 atualizado_por uuid REFERENCES core.usuario(id), atualizado_em timestamptz NOT NULL DEFAULT now()
);
INSERT INTO emprestimo.config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

/* ---------------------------------------------------------------- empréstimos */
CREATE SEQUENCE IF NOT EXISTS emprestimo.seq_numero;
CREATE TABLE IF NOT EXISTS emprestimo.emprestimo (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 numero text NOT NULL UNIQUE DEFAULT ('EMP-' || lpad(nextval('emprestimo.seq_numero')::text, 6, '0')),
 colaborador_id uuid NOT NULL REFERENCES core.usuario(id),
 matricula text NOT NULL, setor text NOT NULL DEFAULT '', centro_custo text NOT NULL DEFAULT '',   -- fotografia do cadastro no dia da retirada
 atendente_id uuid REFERENCES core.usuario(id),                                                      -- almoxarife que registrou; nulo = autoatendimento
 origem text NOT NULL CHECK (origem IN ('terminal','painel')),
 finalidade text NOT NULL DEFAULT 'manutencao' CHECK (finalidade IN ('capex','om','sm','tpm','manutencao','consumo','outro')),
 finalidade_ref text NOT NULL DEFAULT '' CHECK (length(finalidade_ref) <= 60),
 prazo timestamptz NOT NULL, observacao text NOT NULL DEFAULT '' CHECK (length(observacao) <= 1000),
 status text NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento','parcialmente_devolvido','aguardando_conferencia','devolvido','encerrado','estornado')),
 chave text NOT NULL CHECK (length(chave) BETWEEN 8 AND 80),
 criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(), encerrado_em timestamptz,
 UNIQUE (colaborador_id, chave)
);
CREATE INDEX IF NOT EXISTS emprestimo_colab_idx ON emprestimo.emprestimo (colaborador_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS emprestimo_aberto_idx ON emprestimo.emprestimo (prazo) WHERE status IN ('em_andamento','parcialmente_devolvido','aguardando_conferencia');
CREATE TABLE IF NOT EXISTS emprestimo.emprestimo_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), emprestimo_id uuid NOT NULL REFERENCES emprestimo.emprestimo(id),
 tipo text NOT NULL CHECK (tipo IN ('ferramenta','material')),
 ferramenta_id uuid REFERENCES emprestimo.ferramenta(id), unidade_id uuid REFERENCES emprestimo.ferramenta_unidade(id),
 material_codigo text REFERENCES almox.material(codigo),
 codigo text NOT NULL, descricao text NOT NULL,                                                      -- fotografia no dia da retirada
 quantidade numeric(14,3) NOT NULL CHECK (quantidade > 0),
 qtd_conferencia numeric(14,3) NOT NULL DEFAULT 0, qtd_devolvida numeric(14,3) NOT NULL DEFAULT 0, qtd_baixa numeric(14,3) NOT NULL DEFAULT 0,
 numero_baixa text NOT NULL DEFAULT '' CHECK (length(numero_baixa) <= 60),
 CHECK ((tipo = 'ferramenta' AND ferramenta_id IS NOT NULL AND material_codigo IS NULL)
     OR (tipo = 'material' AND material_codigo IS NOT NULL AND ferramenta_id IS NULL AND unidade_id IS NULL)),
 CHECK (unidade_id IS NULL OR quantidade = 1),
 CHECK (tipo = 'material' OR (quantidade = trunc(quantidade) AND qtd_conferencia = trunc(qtd_conferencia) AND qtd_devolvida = trunc(qtd_devolvida) AND qtd_baixa = trunc(qtd_baixa))),
 CHECK (qtd_conferencia >= 0 AND qtd_devolvida >= 0 AND qtd_baixa >= 0 AND qtd_conferencia + qtd_devolvida + qtd_baixa <= quantidade)
);
CREATE INDEX IF NOT EXISTS emprestimo_item_emp_idx ON emprestimo.emprestimo_item (emprestimo_id);
CREATE TABLE IF NOT EXISTS emprestimo.emprestimo_evento (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), emprestimo_id uuid NOT NULL REFERENCES emprestimo.emprestimo(id),
 item_id uuid REFERENCES emprestimo.emprestimo_item(id),
 tipo text NOT NULL CHECK (tipo IN ('retirada','devolucao','conferencia','avaria','recusada','extravio','consumo','baixa','estorno','prazo')),
 quantidade numeric(14,3), condicao text NOT NULL DEFAULT '' CHECK (length(condicao) <= 40),
 justificativa text NOT NULL DEFAULT '' CHECK (length(justificativa) <= 1000),
 por uuid NOT NULL REFERENCES core.usuario(id), em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emprestimo_evento_emp_idx ON emprestimo.emprestimo_evento (emprestimo_id, em);
-- Fase 4: chave de operação da devolução (obrigatória no terminal, opcional no painel). O mesmo pedido duas vezes
-- devolve o resultado do primeiro, sem devolver em dobro.
ALTER TABLE emprestimo.emprestimo_evento ADD COLUMN IF NOT EXISTS chave text CHECK (chave IS NULL OR chave ~ '^[A-Za-z0-9_-]{8,80}$');
CREATE UNIQUE INDEX IF NOT EXISTS emprestimo_evento_chave_uq ON emprestimo.emprestimo_evento (emprestimo_id, item_id, chave) WHERE chave IS NOT NULL;
-- Cadastro, ajustes de saldo, colaboradores e configuração.
CREATE TABLE IF NOT EXISTS emprestimo.auditoria (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text NOT NULL CHECK (length(tipo) BETWEEN 1 AND 60),
 ferramenta_id uuid REFERENCES emprestimo.ferramenta(id), usuario_alvo uuid REFERENCES core.usuario(id),
 detalhe jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detalhe) = 'object'),
 por uuid NOT NULL REFERENCES core.usuario(id), em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emprestimo_auditoria_ferr_idx ON emprestimo.auditoria (ferramenta_id, em);
-- Chave de operação do ajuste de saldo (opcional, gerada pelo painel ao abrir o formulário): reenviar depois de uma
-- resposta perdida não ajusta duas vezes. Baixa e conferência usam a chave de emprestimo_evento (acima).
ALTER TABLE emprestimo.auditoria ADD COLUMN IF NOT EXISTS chave text CHECK (chave IS NULL OR chave ~ '^[A-Za-z0-9_-]{8,80}$');
CREATE UNIQUE INDEX IF NOT EXISTS emprestimo_auditoria_chave_uq ON emprestimo.auditoria (ferramenta_id, chave) WHERE chave IS NOT NULL;
-- Matrícula única sem diferenciar maiúsculas: "T1001" e "t1001" são a mesma pessoa (o login do tablet também compara
-- assim, migration 41). A gravação guarda como foi digitada.
CREATE UNIQUE INDEX IF NOT EXISTS emprestimo_colaborador_matricula_ci_uq ON emprestimo.colaborador (upper(matricula));

/* ---------------------------------------------------------------- RLS: leitura; escrita só pela função */
ALTER TABLE emprestimo.colaborador ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.ferramenta ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.ferramenta_saldo ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.ferramenta_unidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.config ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.emprestimo ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.emprestimo_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.emprestimo_evento ENABLE ROW LEVEL SECURITY;
ALTER TABLE emprestimo.auditoria ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS colaborador_sel ON emprestimo.colaborador;
CREATE POLICY colaborador_sel ON emprestimo.colaborador FOR SELECT USING (app.usuario_ativo() AND (emprestimo.gestao() OR usuario_id = app.usuario_atual()));
DROP POLICY IF EXISTS ferramenta_sel ON emprestimo.ferramenta;
CREATE POLICY ferramenta_sel ON emprestimo.ferramenta FOR SELECT USING (emprestimo.gestao() OR (emprestimo.operador() AND ativo));
DROP POLICY IF EXISTS saldo_sel ON emprestimo.ferramenta_saldo;
CREATE POLICY saldo_sel ON emprestimo.ferramenta_saldo FOR SELECT USING (emprestimo.gestao() OR emprestimo.operador());
DROP POLICY IF EXISTS unidade_sel ON emprestimo.ferramenta_unidade;
CREATE POLICY unidade_sel ON emprestimo.ferramenta_unidade FOR SELECT USING (emprestimo.gestao() OR emprestimo.operador());
DROP POLICY IF EXISTS config_sel ON emprestimo.config;
CREATE POLICY config_sel ON emprestimo.config FOR SELECT USING (emprestimo.gestao() OR emprestimo.operador());
DROP POLICY IF EXISTS emprestimo_sel ON emprestimo.emprestimo;
CREATE POLICY emprestimo_sel ON emprestimo.emprestimo FOR SELECT USING (app.usuario_ativo() AND (emprestimo.gestao() OR colaborador_id = app.usuario_atual()));
DROP POLICY IF EXISTS item_sel ON emprestimo.emprestimo_item;
CREATE POLICY item_sel ON emprestimo.emprestimo_item FOR SELECT USING (emprestimo_id IN (SELECT id FROM emprestimo.emprestimo));
DROP POLICY IF EXISTS evento_sel ON emprestimo.emprestimo_evento;
CREATE POLICY evento_sel ON emprestimo.emprestimo_evento FOR SELECT USING (emprestimo_id IN (SELECT id FROM emprestimo.emprestimo));
DROP POLICY IF EXISTS auditoria_sel ON emprestimo.auditoria;
CREATE POLICY auditoria_sel ON emprestimo.auditoria FOR SELECT USING (emprestimo.gestao());
REVOKE ALL ON ALL TABLES IN SCHEMA emprestimo FROM PUBLIC, biotrop_app, biotrop_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA emprestimo TO biotrop_app, biotrop_ro;

-- Histórico só cresce; nada de emprestimo é apagado (correção = estorno). Vale também para a função proprietária.
CREATE OR REPLACE FUNCTION emprestimo.trava() RETURNS trigger LANGUAGE plpgsql SET search_path = emprestimo, pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME IN ('emprestimo_evento','auditoria') THEN RAISE EXCEPTION 'O histórico não pode ser alterado ou apagado.' USING ERRCODE = '42501'; END IF;
 RAISE EXCEPTION 'Empréstimos não são apagados: corrija por estorno.' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS evento_imutavel ON emprestimo.emprestimo_evento;
CREATE TRIGGER evento_imutavel BEFORE UPDATE OR DELETE ON emprestimo.emprestimo_evento FOR EACH ROW EXECUTE FUNCTION emprestimo.trava();
DROP TRIGGER IF EXISTS auditoria_imutavel ON emprestimo.auditoria;
CREATE TRIGGER auditoria_imutavel BEFORE UPDATE OR DELETE ON emprestimo.auditoria FOR EACH ROW EXECUTE FUNCTION emprestimo.trava();
DROP TRIGGER IF EXISTS emprestimo_sem_delete ON emprestimo.emprestimo;
CREATE TRIGGER emprestimo_sem_delete BEFORE DELETE ON emprestimo.emprestimo FOR EACH ROW EXECUTE FUNCTION emprestimo.trava();
DROP TRIGGER IF EXISTS item_sem_delete ON emprestimo.emprestimo_item;
CREATE TRIGGER item_sem_delete BEFORE DELETE ON emprestimo.emprestimo_item FOR EACH ROW EXECUTE FUNCTION emprestimo.trava();

/* ---------------------------------------------------------------- nomes das pessoas (o RLS de core.usuario não mostra terceiros) */
-- Gestão: colaboradores cadastrados no empréstimo. Fora da gestão: só a própria linha.
CREATE OR REPLACE FUNCTION emprestimo.colaboradores() RETURNS TABLE(usuario_id uuid, nome text, email text, perfil_id text, matricula text, setor text,
  centro_custo text, cargo text, ativo boolean, bloqueado boolean, criado_em timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = emprestimo, core, app, public, pg_temp AS $$
  SELECT c.usuario_id, u.nome, u.email::text, u.perfil_id, c.matricula, c.setor, c.centro_custo, c.cargo, c.ativo, u.bloqueado, c.criado_em
    FROM emprestimo.colaborador c JOIN core.usuario u ON u.id = c.usuario_id
   WHERE app.usuario_ativo() AND (emprestimo.gestao() OR c.usuario_id = app.usuario_atual())
   ORDER BY u.nome
$$;
-- Nome de quem aparece num empréstimo (colaborador, atendente, autor do evento): gestão vê todos; o colaborador, só os do que é dele.
CREATE OR REPLACE FUNCTION emprestimo.nomes(p_ids uuid[]) RETURNS TABLE(id uuid, nome text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = emprestimo, core, app, pg_temp AS $$
  SELECT u.id, u.nome FROM core.usuario u
   WHERE u.id = ANY (p_ids) AND app.usuario_ativo()
     AND (emprestimo.gestao() OR u.id = app.usuario_atual()
          OR EXISTS (SELECT 1 FROM emprestimo.emprestimo e WHERE e.colaborador_id = app.usuario_atual()
                       AND (e.atendente_id = u.id OR EXISTS (SELECT 1 FROM emprestimo.emprestimo_evento v WHERE v.emprestimo_id = e.id AND v.por = u.id))))
$$;
REVOKE ALL ON FUNCTION emprestimo.colaboradores(), emprestimo.nomes(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emprestimo.colaboradores(), emprestimo.nomes(uuid[]) TO biotrop_app;

/* ---------------------------------------------------------------- status do empréstimo a partir dos itens */
-- "Atrasado" não é gravado: é prazo vencido com pendência, calculado na hora da consulta.
CREATE OR REPLACE FUNCTION emprestimo.recalcular(p_id uuid) RETURNS text LANGUAGE plpgsql SET search_path = emprestimo, pg_temp AS $$
DECLARE s record; novo text;
BEGIN
 SELECT coalesce(bool_and(quantidade - qtd_conferencia - qtd_devolvida - qtd_baixa = 0 AND qtd_conferencia = 0), true) AS fechado,
        coalesce(bool_or(qtd_conferencia > 0), false) AS em_conf, coalesce(sum(qtd_baixa), 0) AS baixa, coalesce(sum(qtd_devolvida + qtd_baixa), 0) AS feito
   INTO s FROM emprestimo.emprestimo_item WHERE emprestimo_id = p_id;
 novo := CASE WHEN s.fechado THEN CASE WHEN s.baixa > 0 THEN 'encerrado' ELSE 'devolvido' END
              WHEN s.em_conf THEN 'aguardando_conferencia' WHEN s.feito > 0 THEN 'parcialmente_devolvido' ELSE 'em_andamento' END;
 UPDATE emprestimo.emprestimo SET status = novo, atualizado_em = now(), encerrado_em = CASE WHEN s.fechado THEN coalesce(encerrado_em, now()) ELSE NULL END
  WHERE id = p_id AND status <> 'estornado';
 RETURN novo;
END $$;
REVOKE ALL ON FUNCTION emprestimo.recalcular(uuid) FROM PUBLIC;
-- Quantidade no formato do Brasil nas mensagens (1 → "1", 2,5 → "2,5"): o numeric(14,3) cru sairia "1.000", que em
-- português lê "mil". A 42 recria a mesma função para os e-mails.
CREATE OR REPLACE FUNCTION emprestimo.fmt_qtd(q numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(CASE WHEN q = trunc(q) THEN trunc(q)::text ELSE rtrim(q::text, '0') END, '.', ',')
$$;
-- O que mudou num cadastro (auditoria das alterações): { campo: { de, para } } só dos campos listados que mudaram.
-- p_antes nulo = cadastro novo (de: null).
CREATE OR REPLACE FUNCTION emprestimo.alteracoes(p_antes jsonb, p_depois jsonb, p_campos text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, jsonb_build_object('de', p_antes->k, 'para', p_depois->k)), '{}'::jsonb)
    FROM unnest(p_campos) k WHERE p_antes->k IS DISTINCT FROM p_depois->k
$$;
REVOKE ALL ON FUNCTION emprestimo.fmt_qtd(numeric), emprestimo.alteracoes(jsonb, jsonb, text[]) FROM PUBLIC;

/* ---------------------------------------------------------------- todas as escritas */
CREATE OR REPLACE FUNCTION emprestimo.executar(acao text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, almox, app, public, pg_temp AS $$
DECLARE
 uid uuid; g boolean; r boolean; o boolean;
 f emprestimo.ferramenta%ROWTYPE; fa emprestimo.ferramenta%ROWTYPE; s emprestimo.ferramenta_saldo%ROWTYPE; un emprestimo.ferramenta_unidade%ROWTYPE;
 col emprestimo.colaborador%ROWTYPE; e emprestimo.emprestimo%ROWTYPE; it emprestimo.emprestimo_item%ROWTYPE;
 m almox.material%ROWTYPE; cfg emprestimo.config%ROWTYPE; cu core.usuario%ROWTYPE;
 v jsonb; q numeric; n integer; colab uuid; novo_id uuid; chaves text[] := '{}'; k text; pend numeric; just text; res text; tot integer := 0; antes jsonb;
BEGIN
 IF NOT app.usuario_ativo() THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501'; END IF;
 uid := app.usuario_atual(); g := emprestimo.gestao(); r := emprestimo.gerencia(); o := emprestimo.operador();
 IF NOT (g OR o) THEN RAISE EXCEPTION 'Seu perfil não usa o empréstimo.' USING ERRCODE = '42501'; END IF;
 SELECT * INTO cfg FROM emprestimo.config WHERE id;
 just := btrim(coalesce(p->>'justificativa', ''));

 /* ---- retirada (terminal: só para si; painel: para qualquer colaborador cadastrado) ---- */
 IF acao = 'emprestar' THEN
   IF g AND NOT emprestimo.no_terminal() THEN
     IF coalesce(p->>'colaboradorId', '') !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Informe o colaborador.' USING ERRCODE = '22023'; END IF;
     colab := (p->>'colaboradorId')::uuid;
   ELSE
     IF p->>'colaboradorId' IS NOT NULL AND p->>'colaboradorId' <> uid::text THEN RAISE EXCEPTION 'O terminal só registra empréstimo para quem está logado.' USING ERRCODE = '42501'; END IF;
     colab := uid;
   END IF;
   IF coalesce(p->>'chave', '') !~ '^[A-Za-z0-9_-]{8,80}$' THEN RAISE EXCEPTION 'Chave de operação inválida.' USING ERRCODE = '22023'; END IF;
   SELECT * INTO e FROM emprestimo.emprestimo WHERE colaborador_id = colab AND chave = p->>'chave';
   IF FOUND THEN RETURN jsonb_build_object('id', e.id, 'numero', e.numero, 'repetido', true); END IF;   -- clique duplo / reenvio
   SELECT * INTO col FROM emprestimo.colaborador WHERE usuario_id = colab;
   SELECT * INTO cu FROM core.usuario WHERE id = colab;
   IF NOT FOUND OR cu.bloqueado OR NOT cu.ativo OR col.usuario_id IS NULL OR NOT col.ativo THEN RAISE EXCEPTION 'Colaborador não cadastrado ou bloqueado no terminal.' USING ERRCODE = '42501'; END IF;
   IF jsonb_typeof(p->'itens') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'itens') NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Informe de 1 a 30 itens.' USING ERRCODE = '22023'; END IF;
   IF coalesce(p->>'finalidade', 'manutencao') NOT IN ('capex','om','sm','tpm','manutencao','consumo','outro') THEN RAISE EXCEPTION 'Finalidade inválida.' USING ERRCODE = '22023'; END IF;
   INSERT INTO emprestimo.emprestimo (colaborador_id, matricula, setor, centro_custo, atendente_id, origem, finalidade, finalidade_ref, prazo, observacao, chave)
   VALUES (colab, col.matricula, col.setor, col.centro_custo, CASE WHEN emprestimo.no_terminal() THEN NULL ELSE uid END, CASE WHEN emprestimo.no_terminal() THEN 'terminal' ELSE 'painel' END,
           coalesce(p->>'finalidade', 'manutencao'), left(btrim(coalesce(p->>'finalidadeRef', '')), 60),
           coalesce(nullif(p->>'prazo', '')::timestamptz, now() + make_interval(hours => cfg.prazo_padrao_horas)), left(btrim(coalesce(p->>'observacao', '')), 1000), p->>'chave')
   ON CONFLICT (colaborador_id, chave) DO NOTHING
   RETURNING * INTO e;
   IF NOT FOUND THEN   -- o mesmo pedido chegou duas vezes ao mesmo tempo: o segundo espera o primeiro e devolve o mesmo empréstimo
     SELECT * INTO e FROM emprestimo.emprestimo WHERE colaborador_id = colab AND chave = p->>'chave';
     RETURN jsonb_build_object('id', e.id, 'numero', e.numero, 'repetido', true);
   END IF;
   IF e.prazo <= now() OR e.prazo > now() + interval '90 days' THEN RAISE EXCEPTION 'O prazo precisa estar entre agora e 90 dias.' USING ERRCODE = '22023'; END IF;
   -- ordem fixa de travas: o saldo de cada ferramenta na ordem do id (uuid), a mesma da devolução, da conferência e do
   -- estorno; evita impasse com outra retirada, devolução ou conferência das mesmas ferramentas ao mesmo tempo
   FOR v IN SELECT value FROM jsonb_array_elements(p->'itens')
     ORDER BY CASE WHEN value->>'ferramentaId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (value->>'ferramentaId')::uuid END,
              coalesce(value->>'ferramentaId', value->>'materialCodigo', '') LOOP
     k := coalesce(lower(v->>'ferramentaId'), v->>'materialCodigo', '');
     IF k = '' OR k = ANY (chaves) THEN RAISE EXCEPTION 'Item ausente ou repetido.' USING ERRCODE = '22023'; END IF;
     chaves := chaves || k;
     IF v->>'ferramentaId' IS NOT NULL THEN
       IF coalesce(v->>'quantidade', '') !~ '^[0-9]{1,3}$' OR (v->>'quantidade')::integer < 1 THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE = '22023'; END IF;
       n := (v->>'quantidade')::integer;
       SELECT * INTO f FROM emprestimo.ferramenta WHERE id = (v->>'ferramentaId')::uuid;
       IF NOT FOUND OR NOT f.ativo THEN RAISE EXCEPTION 'Ferramenta indisponível no cadastro.' USING ERRCODE = 'P0002'; END IF;
       SELECT * INTO s FROM emprestimo.ferramenta_saldo WHERE ferramenta_id = f.id FOR UPDATE;
       IF f.controle = 'individual' THEN
         IF n <> 1 OR coalesce(v->>'unidadeId', '') !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION '% é controlada por unidade: escolha a unidade (quantidade 1).', f.nome USING ERRCODE = '22023'; END IF;
         SELECT * INTO un FROM emprestimo.ferramenta_unidade WHERE id = (v->>'unidadeId')::uuid AND ferramenta_id = f.id FOR UPDATE;
         IF NOT FOUND THEN RAISE EXCEPTION 'Unidade inexistente.' USING ERRCODE = 'P0002'; END IF;
         IF un.estado <> 'disponivel' THEN RAISE EXCEPTION 'A unidade % de % não está disponível.', un.identificador, f.nome USING ERRCODE = 'P0001'; END IF;
         UPDATE emprestimo.ferramenta_unidade SET estado = 'emprestada' WHERE id = un.id;
       ELSIF v->>'unidadeId' IS NOT NULL THEN RAISE EXCEPTION 'Esta ferramenta é controlada por quantidade.' USING ERRCODE = '22023'; END IF;
       UPDATE emprestimo.ferramenta_saldo SET disponivel = disponivel - n, emprestada = emprestada + n WHERE ferramenta_id = f.id AND disponivel >= n;
       IF NOT FOUND THEN RAISE EXCEPTION 'Saldo insuficiente de % (disponível: %).', f.nome, s.disponivel USING ERRCODE = 'P0001'; END IF;
       INSERT INTO emprestimo.emprestimo_item (emprestimo_id, tipo, ferramenta_id, unidade_id, codigo, descricao, quantidade)
       VALUES (e.id, 'ferramenta', f.id, un.id, f.codigo, f.nome || CASE WHEN un.id IS NOT NULL THEN ' (' || un.identificador || ')' ELSE '' END, n) RETURNING * INTO it;
       un := NULL;
     ELSE
       -- o terminal só empresta ferramenta (material do REG.0306 é no balcão): a rota do terminal recusa antes; esta é a trava do banco
       IF emprestimo.no_terminal() THEN RAISE EXCEPTION 'O terminal empresta só ferramentas. Material é retirado no balcão do almoxarifado.' USING ERRCODE = '42501'; END IF;
       IF coalesce(v->>'quantidade', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' OR (v->>'quantidade')::numeric <= 0 THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE = '22023'; END IF;
       SELECT * INTO m FROM almox.material WHERE codigo = upper(btrim(v->>'materialCodigo'));
       IF NOT FOUND OR NOT m.ativo THEN RAISE EXCEPTION 'Material % não está no catálogo ativo.', v->>'materialCodigo' USING ERRCODE = 'P0002'; END IF;
       INSERT INTO emprestimo.emprestimo_item (emprestimo_id, tipo, material_codigo, codigo, descricao, quantidade)
       VALUES (e.id, 'material', m.codigo, m.codigo, left(m.descricao, 500), (v->>'quantidade')::numeric) RETURNING * INTO it;
     END IF;
     INSERT INTO emprestimo.emprestimo_evento (emprestimo_id, item_id, tipo, quantidade, por) VALUES (e.id, it.id, 'retirada', it.quantidade, uid);
     tot := tot + 1;
   END LOOP;
   RETURN jsonb_build_object('id', e.id, 'numero', e.numero, 'itens', tot, 'repetido', false);
 END IF;

 /* ---- devolução: quem pegou (ou o almoxarife) informa; o almoxarife confere depois ---- */
 IF acao = 'devolver' THEN
   SELECT * INTO e FROM emprestimo.emprestimo WHERE id = (p->>'emprestimoId')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo inexistente.' USING ERRCODE = 'P0002'; END IF;
   IF NOT g AND e.colaborador_id <> uid THEN RAISE EXCEPTION 'Este empréstimo não é seu.' USING ERRCODE = '42501'; END IF;
   -- chave de operação (a API do terminal sempre manda; o painel, se quiser): a trava acima enfileira o reenvio, que
   -- acha a chave e devolve o mesmo resultado
   IF p->>'chave' IS NOT NULL THEN
     IF coalesce(p->>'chave', '') !~ '^[A-Za-z0-9_-]{8,80}$' THEN RAISE EXCEPTION 'Chave de operação inválida.' USING ERRCODE = '22023'; END IF;
     SELECT tipo INTO k FROM emprestimo.emprestimo_evento WHERE emprestimo_id = e.id AND chave = p->>'chave' LIMIT 1;
     IF FOUND THEN
       IF k = 'devolucao' THEN RETURN jsonb_build_object('id', e.id, 'status', e.status, 'repetido', true); END IF;
       RAISE EXCEPTION 'Chave de operação já usada em outra operação.' USING ERRCODE = '22023';
     END IF;
   END IF;
   IF e.status IN ('devolvido','encerrado','estornado') THEN RAISE EXCEPTION 'Este empréstimo já está fechado.' USING ERRCODE = 'P0001'; END IF;
   IF jsonb_typeof(p->'itens') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'itens') NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Informe os itens devolvidos.' USING ERRCODE = '22023'; END IF;
   IF (SELECT count(DISTINCT lower(value->>'itemId')) <> count(*) FROM jsonb_array_elements(p->'itens')) THEN RAISE EXCEPTION 'Item repetido na devolução.' USING ERRCODE = '22023'; END IF;
   -- itens na ordem do id da ferramenta (a mesma da retirada): o saldo de cada uma é travado nessa ordem, sem impasse
   FOR v IN SELECT x.value FROM jsonb_array_elements(p->'itens') WITH ORDINALITY x(value, ordem)
     LEFT JOIN emprestimo.emprestimo_item ei ON ei.emprestimo_id = e.id AND ei.id::text = lower(x.value->>'itemId')
     ORDER BY ei.ferramenta_id, x.value->>'itemId', x.ordem LOOP
     IF coalesce(v->>'quantidade', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' OR (v->>'quantidade')::numeric <= 0 THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE = '22023'; END IF;
     IF coalesce(v->>'condicao', 'boa') NOT IN ('boa','avaria') THEN RAISE EXCEPTION 'Condição inválida.' USING ERRCODE = '22023'; END IF;
     -- no terminal, avaria vem com a descrição de quem devolve (no painel, quem explica é a conferência)
     IF emprestimo.no_terminal() AND v->>'condicao' = 'avaria' AND length(btrim(coalesce(v->>'observacao', ''))) < 5 THEN
       RAISE EXCEPTION 'Descreva a avaria (pelo menos 5 caracteres).' USING ERRCODE = '22023'; END IF;
     q := (v->>'quantidade')::numeric;
     SELECT * INTO it FROM emprestimo.emprestimo_item WHERE id = (v->>'itemId')::uuid AND emprestimo_id = e.id FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Item não pertence a este empréstimo.' USING ERRCODE = 'P0002'; END IF;
     IF it.tipo = 'material' AND emprestimo.no_terminal() THEN RAISE EXCEPTION 'Material é devolvido no balcão do almoxarifado.' USING ERRCODE = '42501'; END IF;
     IF it.tipo = 'ferramenta' AND q <> trunc(q) THEN RAISE EXCEPTION 'Ferramenta se movimenta em unidades inteiras.' USING ERRCODE = '22023'; END IF;
     pend := it.quantidade - it.qtd_conferencia - it.qtd_devolvida - it.qtd_baixa;
     IF q > pend THEN RAISE EXCEPTION 'A quantidade devolvida de % passa do que está pendente (%).', it.descricao, emprestimo.fmt_qtd(pend) USING ERRCODE = 'P0001'; END IF;
     UPDATE emprestimo.emprestimo_item SET qtd_conferencia = qtd_conferencia + q WHERE id = it.id;
     IF it.tipo = 'ferramenta' THEN
       UPDATE emprestimo.ferramenta_saldo SET emprestada = emprestada - q::integer, em_conferencia = em_conferencia + q::integer WHERE ferramenta_id = it.ferramenta_id;
       IF it.unidade_id IS NOT NULL THEN UPDATE emprestimo.ferramenta_unidade SET estado = 'em_conferencia' WHERE id = it.unidade_id; END IF;
     END IF;
     INSERT INTO emprestimo.emprestimo_evento (emprestimo_id, item_id, tipo, quantidade, condicao, justificativa, chave, por)
     VALUES (e.id, it.id, 'devolucao', q, coalesce(v->>'condicao', 'boa'), left(btrim(coalesce(v->>'observacao', '')), 1000), p->>'chave', uid);
   END LOOP;
   RETURN jsonb_build_object('id', e.id, 'status', emprestimo.recalcular(e.id), 'repetido', false);
 END IF;

 IF NOT g THEN RAISE EXCEPTION 'Somente o almoxarifado e a gestão.' USING ERRCODE = '42501'; END IF;

 /* ---- conferência da devolução pelo almoxarife ---- */
 IF acao = 'conferir' THEN
   SELECT * INTO e FROM emprestimo.emprestimo WHERE id = (p->>'emprestimoId')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo inexistente.' USING ERRCODE = 'P0002'; END IF;
   -- chave de operação (opcional; o painel gera ao abrir a conferência): o reenvio devolve o resultado do primeiro
   IF p->>'chave' IS NOT NULL THEN
     IF coalesce(p->>'chave', '') !~ '^[A-Za-z0-9_-]{8,80}$' THEN RAISE EXCEPTION 'Chave de operação inválida.' USING ERRCODE = '22023'; END IF;
     SELECT tipo INTO k FROM emprestimo.emprestimo_evento WHERE emprestimo_id = e.id AND chave = p->>'chave' LIMIT 1;
     IF FOUND THEN
       IF k IN ('conferencia','avaria','recusada') THEN RETURN jsonb_build_object('id', e.id, 'status', e.status, 'repetido', true); END IF;
       RAISE EXCEPTION 'Chave de operação já usada em outra operação.' USING ERRCODE = '22023';
     END IF;
   END IF;
   IF jsonb_typeof(p->'itens') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'itens') NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Informe os itens conferidos.' USING ERRCODE = '22023'; END IF;
   -- itens na ordem do id da ferramenta (a mesma da retirada): o saldo de cada uma é travado nessa ordem, sem impasse
   FOR v IN SELECT x.value FROM jsonb_array_elements(p->'itens') WITH ORDINALITY x(value, ordem)
     LEFT JOIN emprestimo.emprestimo_item ei ON ei.emprestimo_id = e.id AND ei.id::text = lower(x.value->>'itemId')
     ORDER BY ei.ferramenta_id, x.value->>'itemId', x.ordem LOOP
     res := coalesce(v->>'resultado', '');
     IF res NOT IN ('boa','avaria','recusada') THEN RAISE EXCEPTION 'Resultado da conferência inválido.' USING ERRCODE = '22023'; END IF;
     IF coalesce(v->>'quantidade', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' OR (v->>'quantidade')::numeric <= 0 THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE = '22023'; END IF;
     IF res <> 'boa' AND length(btrim(coalesce(v->>'observacao', ''))) < 5 THEN RAISE EXCEPTION 'Explique a avaria ou a divergência.' USING ERRCODE = '22023'; END IF;
     q := (v->>'quantidade')::numeric;
     SELECT * INTO it FROM emprestimo.emprestimo_item WHERE id = (v->>'itemId')::uuid AND emprestimo_id = e.id FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Item não pertence a este empréstimo.' USING ERRCODE = 'P0002'; END IF;
     IF it.tipo = 'ferramenta' AND q <> trunc(q) THEN RAISE EXCEPTION 'Ferramenta se movimenta em unidades inteiras.' USING ERRCODE = '22023'; END IF;
     IF q > it.qtd_conferencia THEN RAISE EXCEPTION 'Só há % de % aguardando conferência.', emprestimo.fmt_qtd(it.qtd_conferencia), it.descricao USING ERRCODE = 'P0001'; END IF;
     IF res = 'recusada' THEN UPDATE emprestimo.emprestimo_item SET qtd_conferencia = qtd_conferencia - q WHERE id = it.id;
     ELSE UPDATE emprestimo.emprestimo_item SET qtd_conferencia = qtd_conferencia - q, qtd_devolvida = qtd_devolvida + q WHERE id = it.id; END IF;
     IF it.tipo = 'ferramenta' THEN
       IF res = 'boa' THEN UPDATE emprestimo.ferramenta_saldo SET em_conferencia = em_conferencia - q::integer, disponivel = disponivel + q::integer WHERE ferramenta_id = it.ferramenta_id;
       ELSIF res = 'avaria' THEN UPDATE emprestimo.ferramenta_saldo SET em_conferencia = em_conferencia - q::integer, manutencao = manutencao + q::integer WHERE ferramenta_id = it.ferramenta_id;
       ELSE UPDATE emprestimo.ferramenta_saldo SET em_conferencia = em_conferencia - q::integer, emprestada = emprestada + q::integer WHERE ferramenta_id = it.ferramenta_id; END IF;
       IF it.unidade_id IS NOT NULL THEN
         UPDATE emprestimo.ferramenta_unidade SET estado = CASE res WHEN 'boa' THEN 'disponivel' WHEN 'avaria' THEN 'manutencao' ELSE 'emprestada' END WHERE id = it.unidade_id;
       END IF;
     END IF;
     -- a chave vai só no primeiro evento: o painel pode dividir o mesmo item em linhas (parte boa, parte com avaria)
     INSERT INTO emprestimo.emprestimo_evento (emprestimo_id, item_id, tipo, quantidade, condicao, justificativa, chave, por)
     VALUES (e.id, it.id, CASE res WHEN 'boa' THEN 'conferencia' WHEN 'avaria' THEN 'avaria' ELSE 'recusada' END, q, res, left(btrim(coalesce(v->>'observacao', '')), 1000),
             CASE WHEN tot = 0 THEN p->>'chave' END, uid);
     tot := tot + 1;
   END LOOP;
   RETURN jsonb_build_object('id', e.id, 'status', emprestimo.recalcular(e.id));
 END IF;

 /* ---- baixa do que não voltou: extravio, consumo (material) ou perda definitiva; nº da baixa do Dynamics opcional ---- */
 IF acao = 'baixar' THEN
   SELECT * INTO e FROM emprestimo.emprestimo WHERE id = (p->>'emprestimoId')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo inexistente.' USING ERRCODE = 'P0002'; END IF;
   -- chave de operação (opcional; o painel gera ao abrir a baixa): reenviar não baixa duas vezes
   IF p->>'chave' IS NOT NULL THEN
     IF coalesce(p->>'chave', '') !~ '^[A-Za-z0-9_-]{8,80}$' THEN RAISE EXCEPTION 'Chave de operação inválida.' USING ERRCODE = '22023'; END IF;
     SELECT tipo INTO k FROM emprestimo.emprestimo_evento WHERE emprestimo_id = e.id AND chave = p->>'chave' LIMIT 1;
     IF FOUND THEN
       IF k IN ('extravio','consumo') THEN RETURN jsonb_build_object('id', e.id, 'status', e.status, 'repetido', true); END IF;
       RAISE EXCEPTION 'Chave de operação já usada em outra operação.' USING ERRCODE = '22023';
     END IF;
   END IF;
   IF e.status = 'estornado' THEN RAISE EXCEPTION 'Empréstimo estornado.' USING ERRCODE = 'P0001'; END IF;
   res := coalesce(p->>'motivo', '');
   IF res NOT IN ('extravio','consumo') THEN RAISE EXCEPTION 'Motivo da baixa inválido.' USING ERRCODE = '22023'; END IF;
   IF length(just) < 5 THEN RAISE EXCEPTION 'Explique a baixa.' USING ERRCODE = '22023'; END IF;
   IF coalesce(p->>'quantidade', '') !~ '^[0-9]{1,10}(\.[0-9]{1,3})?$' OR (p->>'quantidade')::numeric <= 0 THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE = '22023'; END IF;
   q := (p->>'quantidade')::numeric;
   SELECT * INTO it FROM emprestimo.emprestimo_item WHERE id = (p->>'itemId')::uuid AND emprestimo_id = e.id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Item não pertence a este empréstimo.' USING ERRCODE = 'P0002'; END IF;
   IF it.tipo = 'ferramenta' AND q <> trunc(q) THEN RAISE EXCEPTION 'Ferramenta se movimenta em unidades inteiras.' USING ERRCODE = '22023'; END IF;
   IF res = 'consumo' AND it.tipo <> 'material' THEN RAISE EXCEPTION 'Consumo só vale para material; ferramenta perdida é extravio.' USING ERRCODE = '22023'; END IF;
   pend := it.quantidade - it.qtd_conferencia - it.qtd_devolvida - it.qtd_baixa;
   IF q > pend THEN RAISE EXCEPTION 'A baixa passa do que está pendente (%).', emprestimo.fmt_qtd(pend) USING ERRCODE = 'P0001'; END IF;
   UPDATE emprestimo.emprestimo_item SET qtd_baixa = qtd_baixa + q, numero_baixa = CASE WHEN btrim(coalesce(p->>'numeroBaixa', '')) <> '' THEN left(btrim(p->>'numeroBaixa'), 60) ELSE numero_baixa END WHERE id = it.id; -- baixa sem número não apaga o número já registrado
   IF it.tipo = 'ferramenta' THEN
     UPDATE emprestimo.ferramenta_saldo SET emprestada = emprestada - q::integer, baixada = baixada + q::integer WHERE ferramenta_id = it.ferramenta_id;
     IF it.unidade_id IS NOT NULL THEN UPDATE emprestimo.ferramenta_unidade SET estado = 'baixada' WHERE id = it.unidade_id; END IF;
   END IF;
   INSERT INTO emprestimo.emprestimo_evento (emprestimo_id, item_id, tipo, quantidade, justificativa, chave, por)
   VALUES (e.id, it.id, CASE res WHEN 'extravio' THEN 'extravio' ELSE 'consumo' END, q, just, p->>'chave', uid);
   RETURN jsonb_build_object('id', e.id, 'status', emprestimo.recalcular(e.id));
 END IF;

 /* ---- novo prazo (com justificativa) ---- */
 IF acao = 'prazo' THEN
   SELECT * INTO e FROM emprestimo.emprestimo WHERE id = (p->>'emprestimoId')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo inexistente.' USING ERRCODE = 'P0002'; END IF;
   IF e.status IN ('devolvido','encerrado','estornado') THEN RAISE EXCEPTION 'Este empréstimo já está fechado.' USING ERRCODE = 'P0001'; END IF;
   IF length(just) < 5 THEN RAISE EXCEPTION 'Explique a mudança de prazo.' USING ERRCODE = '22023'; END IF;
   IF coalesce(p->>'prazo', '') = '' OR (p->>'prazo')::timestamptz <= now() OR (p->>'prazo')::timestamptz > now() + interval '90 days' THEN RAISE EXCEPTION 'O prazo precisa estar entre agora e 90 dias.' USING ERRCODE = '22023'; END IF;
   UPDATE emprestimo.emprestimo SET prazo = (p->>'prazo')::timestamptz, atualizado_em = now() WHERE id = e.id;
   INSERT INTO emprestimo.emprestimo_evento (emprestimo_id, tipo, justificativa, por) VALUES (e.id, 'prazo', left(just || ' (de ' || to_char(e.prazo AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ')', 1000), uid);
   RETURN jsonb_build_object('id', e.id, 'prazo', (p->>'prazo')::timestamptz);
 END IF;

 /* ---- cadastro de ferramenta, unidades e colaborador ---- */
 IF acao = 'ferramenta_salvar' THEN
   IF coalesce(p->>'controle', '') NOT IN ('individual','quantidade') AND p->>'id' IS NULL THEN RAISE EXCEPTION 'Informe o tipo de controle.' USING ERRCODE = '22023'; END IF;
   IF p->>'id' IS NULL THEN
     INSERT INTO emprestimo.ferramenta (codigo, nome, descricao, categoria, marca, modelo, controle, localizacao, conservacao, criado_por)
     VALUES (upper(btrim(p->>'codigo')), btrim(p->>'nome'), left(coalesce(p->>'descricao', ''), 1000), left(btrim(coalesce(p->>'categoria', '')), 80), left(btrim(coalesce(p->>'marca', '')), 80),
             left(btrim(coalesce(p->>'modelo', '')), 80), p->>'controle', left(btrim(coalesce(p->>'localizacao', '')), 120), coalesce(p->>'conservacao', 'boa'), uid) RETURNING * INTO f;
     IF f.controle = 'individual' THEN
       IF jsonb_typeof(p->'unidades') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'unidades') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Informe de 1 a 200 patrimônios ou séries.' USING ERRCODE = '22023'; END IF;
       -- cada patrimônio é um texto: objeto, lista, número ou sim/não não viram identificador por conversão
       IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'unidades') x WHERE jsonb_typeof(x) <> 'string') THEN RAISE EXCEPTION 'Cada patrimônio ou série precisa ser um texto.' USING ERRCODE = '22023'; END IF;
       INSERT INTO emprestimo.ferramenta_unidade (ferramenta_id, identificador) SELECT f.id, btrim(x) FROM jsonb_array_elements_text(p->'unidades') x;
       GET DIAGNOSTICS n = ROW_COUNT;
     ELSE
       IF coalesce(p->>'total', '') !~ '^[0-9]{1,5}$' THEN RAISE EXCEPTION 'Informe a quantidade total.' USING ERRCODE = '22023'; END IF;
       n := (p->>'total')::integer;
     END IF;
     INSERT INTO emprestimo.ferramenta_saldo (ferramenta_id, total, disponivel) VALUES (f.id, n, n);
     INSERT INTO emprestimo.auditoria (tipo, ferramenta_id, detalhe, por) VALUES ('ferramenta_criada', f.id, jsonb_build_object('codigo', f.codigo, 'controle', f.controle, 'total', n), uid);
   ELSE
     SELECT * INTO fa FROM emprestimo.ferramenta WHERE id = (p->>'id')::uuid FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Ferramenta inexistente.' USING ERRCODE = 'P0002'; END IF;
     UPDATE emprestimo.ferramenta SET nome = btrim(coalesce(p->>'nome', nome)), descricao = left(coalesce(p->>'descricao', descricao), 1000), categoria = left(btrim(coalesce(p->>'categoria', categoria)), 80),
       marca = left(btrim(coalesce(p->>'marca', marca)), 80), modelo = left(btrim(coalesce(p->>'modelo', modelo)), 80), localizacao = left(btrim(coalesce(p->>'localizacao', localizacao)), 120),
       conservacao = coalesce(p->>'conservacao', conservacao), ativo = coalesce((p->>'ativo')::boolean, ativo), atualizado_em = now()
      WHERE id = fa.id RETURNING * INTO f;
     -- alteração cadastral auditada com o antes e o depois de cada campo que mudou (nada de alteração silenciosa)
     INSERT INTO emprestimo.auditoria (tipo, ferramenta_id, detalhe, por) VALUES ('ferramenta_editada', f.id, jsonb_build_object('ativo', f.ativo,
       'alteracoes', emprestimo.alteracoes(to_jsonb(fa), to_jsonb(f), ARRAY['nome','descricao','categoria','marca','modelo','localizacao','conservacao','ativo'])), uid);
   END IF;
   RETURN jsonb_build_object('id', f.id, 'codigo', f.codigo);
 END IF;
 IF acao = 'unidade_adicionar' THEN
   SELECT * INTO f FROM emprestimo.ferramenta WHERE id = (p->>'ferramentaId')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'Ferramenta inexistente.' USING ERRCODE = 'P0002'; END IF;
   IF f.controle <> 'individual' THEN RAISE EXCEPTION 'Esta ferramenta é controlada por quantidade: use o ajuste de saldo.' USING ERRCODE = '22023'; END IF;
   SELECT * INTO s FROM emprestimo.ferramenta_saldo WHERE ferramenta_id = f.id FOR UPDATE;
   INSERT INTO emprestimo.ferramenta_unidade (ferramenta_id, identificador) VALUES (f.id, btrim(p->>'identificador'));
   UPDATE emprestimo.ferramenta_saldo SET total = total + 1, disponivel = disponivel + 1 WHERE ferramenta_id = f.id;
   INSERT INTO emprestimo.auditoria (tipo, ferramenta_id, detalhe, por) VALUES ('unidade_adicionada', f.id, jsonb_build_object('identificador', btrim(p->>'identificador')), uid);
   RETURN jsonb_build_object('id', f.id);
 END IF;
 IF acao = 'colaborador_salvar' THEN
   IF coalesce(p->>'email', '') !~* '^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$' OR length(p->>'email') > 254 OR length(btrim(coalesce(p->>'nome', ''))) < 3 THEN RAISE EXCEPTION 'Informe nome completo e e-mail válidos.' USING ERRCODE = '22023'; END IF;
   SELECT * INTO cu FROM core.usuario WHERE email = lower(btrim(p->>'email'))::citext;
   IF NOT FOUND THEN   -- pessoa só do terminal: perfil mínimo; quem já tem conta no site é apenas vinculado (mesmo cadastro, sem duplicar)
     INSERT INTO core.usuario (nome, email, perfil_id) VALUES (btrim(p->>'nome'), lower(btrim(p->>'email'))::citext, 'terminal') RETURNING * INTO cu;
   ELSIF cu.perfil_id IN ('admin','gestor') AND NOT r THEN
     -- mesma regra do convite e do bloqueio (41): sem ela o almoxarife desligaria, reativaria ou trocaria a matrícula
     -- (o login do tablet) de quem o gerencia
     RAISE EXCEPTION 'Cadastro de administrador ou gestor no terminal só pela gerência.' USING ERRCODE = '42501';
   END IF;
   SELECT * INTO col FROM emprestimo.colaborador WHERE usuario_id = cu.id FOR UPDATE;
   antes := CASE WHEN FOUND THEN to_jsonb(col) END;
   -- sem "ativo" no pedido, editar mantém a situação (só o cadastro novo nasce ativo): desligado não volta por engano
   INSERT INTO emprestimo.colaborador (usuario_id, matricula, setor, centro_custo, cargo, ativo, criado_por)
   VALUES (cu.id, btrim(p->>'matricula'), left(btrim(coalesce(p->>'setor', '')), 120), left(btrim(coalesce(p->>'centroCusto', '')), 120), left(btrim(coalesce(p->>'cargo', '')), 120),
           coalesce((p->>'ativo')::boolean, col.ativo, true), uid)
   -- setor, centroCusto e cargo fora do pedido também ficam como estão (edição parcial, como o PUT da ferramenta)
   ON CONFLICT (usuario_id) DO UPDATE SET matricula = EXCLUDED.matricula,
     setor = CASE WHEN p ? 'setor' THEN EXCLUDED.setor ELSE emprestimo.colaborador.setor END,
     centro_custo = CASE WHEN p ? 'centroCusto' THEN EXCLUDED.centro_custo ELSE emprestimo.colaborador.centro_custo END,
     cargo = CASE WHEN p ? 'cargo' THEN EXCLUDED.cargo ELSE emprestimo.colaborador.cargo END, ativo = EXCLUDED.ativo, atualizado_em = now()
   RETURNING * INTO col;
   INSERT INTO emprestimo.auditoria (tipo, usuario_alvo, detalhe, por) VALUES ('colaborador_salvo', cu.id, jsonb_build_object('ativo', col.ativo, 'novo', antes IS NULL,
     'alteracoes', emprestimo.alteracoes(antes, to_jsonb(col), ARRAY['matricula','setor','centro_custo','cargo','ativo'])), uid);
   RETURN jsonb_build_object('usuarioId', cu.id, 'perfil', cu.perfil_id);
 END IF;

 /* ---- só administrador e gestor: ajuste de saldo, estorno e configuração ---- */
 IF NOT r THEN RAISE EXCEPTION 'Somente gestor e administrador.' USING ERRCODE = '42501'; END IF;
 IF acao = 'ajustar' THEN
   res := coalesce(p->>'movimento', '');
   IF res NOT IN ('entrada','para_manutencao','de_manutencao','baixar') THEN RAISE EXCEPTION 'Movimento inválido.' USING ERRCODE = '22023'; END IF;
   IF length(just) < 5 THEN RAISE EXCEPTION 'Explique o ajuste.' USING ERRCODE = '22023'; END IF;
   IF coalesce(p->>'quantidade', '') !~ '^[0-9]{1,5}$' OR (p->>'quantidade')::integer < 1 THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE = '22023'; END IF;
   n := (p->>'quantidade')::integer;
   IF p->>'chave' IS NOT NULL AND p->>'chave' !~ '^[A-Za-z0-9_-]{8,80}$' THEN RAISE EXCEPTION 'Chave de operação inválida.' USING ERRCODE = '22023'; END IF;
   SELECT * INTO f FROM emprestimo.ferramenta WHERE id = (p->>'ferramentaId')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'Ferramenta inexistente.' USING ERRCODE = 'P0002'; END IF;
   SELECT * INTO s FROM emprestimo.ferramenta_saldo WHERE ferramenta_id = f.id FOR UPDATE;
   -- chave de operação (opcional; o painel gera ao abrir o ajuste): conferida depois da trava do saldo, o reenvio
   -- espera o primeiro terminar e devolve o mesmo resultado, sem ajustar de novo
   IF p->>'chave' IS NOT NULL AND EXISTS (SELECT 1 FROM emprestimo.auditoria WHERE ferramenta_id = f.id AND chave = p->>'chave') THEN
     RETURN jsonb_build_object('id', f.id, 'repetido', true);
   END IF;
   IF f.controle = 'individual' THEN
     IF res = 'entrada' OR n <> 1 OR coalesce(p->>'unidadeId', '') !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Ferramenta individual: informe a unidade (quantidade 1); para nova unidade use o cadastro.' USING ERRCODE = '22023'; END IF;
     SELECT * INTO un FROM emprestimo.ferramenta_unidade WHERE id = (p->>'unidadeId')::uuid AND ferramenta_id = f.id FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Unidade inexistente.' USING ERRCODE = 'P0002'; END IF;
     IF (res = 'para_manutencao' AND un.estado <> 'disponivel') OR (res = 'de_manutencao' AND un.estado <> 'manutencao') OR (res = 'baixar' AND un.estado NOT IN ('disponivel','manutencao')) THEN
       RAISE EXCEPTION 'A unidade está % e não aceita esse movimento.', un.estado USING ERRCODE = 'P0001'; END IF;
     k := un.estado;   -- de onde sai a baixa
     UPDATE emprestimo.ferramenta_unidade SET estado = CASE res WHEN 'para_manutencao' THEN 'manutencao' WHEN 'de_manutencao' THEN 'disponivel' ELSE 'baixada' END WHERE id = un.id;
   END IF;
   IF res = 'entrada' THEN UPDATE emprestimo.ferramenta_saldo SET total = total + n, disponivel = disponivel + n WHERE ferramenta_id = f.id;
   ELSIF res = 'para_manutencao' THEN UPDATE emprestimo.ferramenta_saldo SET disponivel = disponivel - n, manutencao = manutencao + n WHERE ferramenta_id = f.id;
   ELSIF res = 'de_manutencao' THEN UPDATE emprestimo.ferramenta_saldo SET manutencao = manutencao - n, disponivel = disponivel + n WHERE ferramenta_id = f.id;
   ELSE   -- baixa definitiva: sai do disponível ou da manutenção (p.de; na individual, do estado da unidade)
     IF f.controle = 'quantidade' THEN k := coalesce(p->>'de', 'disponivel'); END IF;
     IF k = 'disponivel' THEN UPDATE emprestimo.ferramenta_saldo SET disponivel = disponivel - n, baixada = baixada + n WHERE ferramenta_id = f.id;
     ELSIF k = 'manutencao' THEN UPDATE emprestimo.ferramenta_saldo SET manutencao = manutencao - n, baixada = baixada + n WHERE ferramenta_id = f.id;
     ELSE RAISE EXCEPTION 'Informe de onde sai a baixa (disponível ou manutenção).' USING ERRCODE = '22023'; END IF;
   END IF;
   INSERT INTO emprestimo.auditoria (tipo, ferramenta_id, detalhe, chave, por) VALUES ('saldo_ajustado', f.id, jsonb_build_object('movimento', res, 'quantidade', n, 'justificativa', left(just, 500)), p->>'chave', uid);
   RETURN jsonb_build_object('id', f.id);
 END IF;
 IF acao = 'estornar' THEN
   SELECT * INTO e FROM emprestimo.emprestimo WHERE id = (p->>'emprestimoId')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Empréstimo inexistente.' USING ERRCODE = 'P0002'; END IF;
   IF e.status = 'estornado' THEN RAISE EXCEPTION 'Empréstimo já estornado.' USING ERRCODE = 'P0001'; END IF;
   IF length(just) < 5 THEN RAISE EXCEPTION 'Explique o estorno.' USING ERRCODE = '22023'; END IF;
   IF EXISTS (SELECT 1 FROM emprestimo.emprestimo_item WHERE emprestimo_id = e.id AND (qtd_conferencia > 0 OR qtd_devolvida > 0 OR qtd_baixa > 0)) THEN
     RAISE EXCEPTION 'Já há devolução ou baixa neste empréstimo: conclua por conferência e baixa, não por estorno.' USING ERRCODE = 'P0001'; END IF;
   FOR it IN SELECT * FROM emprestimo.emprestimo_item WHERE emprestimo_id = e.id ORDER BY ferramenta_id NULLS LAST, id FOR UPDATE LOOP
     IF it.tipo = 'ferramenta' THEN
       SELECT * INTO s FROM emprestimo.ferramenta_saldo WHERE ferramenta_id = it.ferramenta_id FOR UPDATE;
       UPDATE emprestimo.ferramenta_saldo SET emprestada = emprestada - it.quantidade::integer, disponivel = disponivel + it.quantidade::integer WHERE ferramenta_id = it.ferramenta_id;
       IF it.unidade_id IS NOT NULL THEN UPDATE emprestimo.ferramenta_unidade SET estado = 'disponivel' WHERE id = it.unidade_id; END IF;
     END IF;
     INSERT INTO emprestimo.emprestimo_evento (emprestimo_id, item_id, tipo, quantidade, justificativa, por) VALUES (e.id, it.id, 'estorno', it.quantidade, just, uid);
   END LOOP;
   UPDATE emprestimo.emprestimo SET status = 'estornado', atualizado_em = now(), encerrado_em = now() WHERE id = e.id;
   RETURN jsonb_build_object('id', e.id, 'status', 'estornado');
 END IF;
 IF acao = 'config_salvar' THEN
   UPDATE emprestimo.config SET prazo_padrao_horas = coalesce((p->>'prazoPadraoHoras')::integer, prazo_padrao_horas), lembrete_antes_horas = coalesce((p->>'lembreteAntesHoras')::integer, lembrete_antes_horas),
     atraso_intervalo_horas = coalesce((p->>'atrasoIntervaloHoras')::integer, atraso_intervalo_horas), inatividade_segundos = coalesce((p->>'inatividadeSegundos')::integer, inatividade_segundos),
     atualizado_por = uid, atualizado_em = now() WHERE id RETURNING * INTO cfg;
   INSERT INTO emprestimo.auditoria (tipo, detalhe, por) VALUES ('config_salva', to_jsonb(cfg) - 'atualizado_por', uid);
   RETURN to_jsonb(cfg) - 'atualizado_por';
 END IF;
 RAISE EXCEPTION 'Ação desconhecida.' USING ERRCODE = '22023';
END $$;
REVOKE ALL ON FUNCTION emprestimo.executar(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emprestimo.executar(text, jsonb) TO biotrop_app;
COMMIT;
