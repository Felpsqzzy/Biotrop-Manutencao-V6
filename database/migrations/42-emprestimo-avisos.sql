-- Avisos automáticos do empréstimo por e-mail (fase 6). Mesmo padrão das cobranças de treinamento (08/29): a função
-- emprestimo.enfileirar_avisos() roda a cada ciclo do worker de e-mail (core.email_fila → Microsoft Graph), sem ninguém
-- com o site aberto. Motivo na fila = 'emprestimo_' || tipo; os cinco precisam estar em EMAIL_MOTIVOS_ATIVOS do worker.
--   · lembrete       antes do prazo (lembrete_antes_horas), ao colaborador. Só quando o prazo foi dado com mais
--                    antecedência que a janela: quem pegou hoje para devolver em 4 h não recebe lembrete na saída do balcão.
--   · vencimento     no vencimento (aviso_no_vencimento), ao colaborador, dentro do primeiro intervalo de atraso.
--   · atraso         a cada atraso_intervalo_horas depois do vencimento, ao colaborador (nunca dois no mesmo intervalo,
--                    mesmo que o intervalo mude no meio do caminho; o próximo sai um intervalo depois do último, sem
--                    lacuna quando o intervalo aumenta).
--   · escalonamento  uma vez por prazo, quando o atraso passa de escalar_apos_horas: para o atendente do empréstimo (se
--                    ainda é do almoxarifado ou da gestão), senão para o primeiro almoxarife; os outros almoxarifes e os
--                    gestores vão em cópia. Quem pegou o item não entra, mesmo sendo almoxarife.
--   · devolucao      confirmação da devolução conferida (aviso_devolucao), ao colaborador. Só conferências feitas depois
--                    de ligar a opção (aviso_devolucao_desde): ligar não dispara e-mail sobre o passado.
-- Só a quantidade PENDENTE conta (quantidade − em conferência − devolvida − baixa). Empréstimo devolvido, encerrado ou
-- estornado não recebe aviso, e o que ainda esperava na fila é cancelado quando a pendência acaba ou o prazo muda.
-- Sem duplicidade: emprestimo.aviso tem chave única (empréstimo + tipo + janela) e o INSERT é ON CONFLICT DO NOTHING;
-- duas execuções seguidas, ou dois workers ao mesmo tempo, não enfileiram duas vezes (o segundo espera o primeiro).
-- Texto curto, sem senha, matrícula, centro de custo ou dado de terceiros; tudo que vem do banco passa por escape de HTML.
-- Idempotente: o migrate.js reaplica esta migration a cada deploy.
BEGIN;

/* ---------------------------------------------------------------- configuração (colunas novas em emprestimo.config) */
-- lembrete_antes_horas e atraso_intervalo_horas já existem (40) e continuam sendo salvos pelo PUT /api/emprestimo/config.
ALTER TABLE emprestimo.config ADD COLUMN IF NOT EXISTS avisos_ativos boolean NOT NULL DEFAULT true;
ALTER TABLE emprestimo.config ADD COLUMN IF NOT EXISTS aviso_no_vencimento boolean NOT NULL DEFAULT true;
ALTER TABLE emprestimo.config ADD COLUMN IF NOT EXISTS escalar_apos_horas integer NOT NULL DEFAULT 48 CHECK (escalar_apos_horas BETWEEN 1 AND 720);
ALTER TABLE emprestimo.config ADD COLUMN IF NOT EXISTS aviso_devolucao boolean NOT NULL DEFAULT false;
-- Quando a confirmação de devolução foi ligada (preenchida pela função de salvar): o passado não vira enxurrada de e-mails.
ALTER TABLE emprestimo.config ADD COLUMN IF NOT EXISTS aviso_devolucao_desde timestamptz;

/* ---------------------------------------------------------------- registro dos avisos */
-- janela: o prazo a que o aviso se refere (lembrete, vencimento, escalonamento), o prazo + nº de ordem do atraso (1º, 2º…
-- daquele prazo; não depende do intervalo, que pode mudar) ou o instante da conferência (devolução). A chave única é o
-- que impede o segundo envio.
-- email_id nulo = pulado (colaborador inativo, isto é, cadastro do terminal desligado ou usuário do site desativado, ou
-- sem e-mail válido; ninguém do almoxarifado com e-mail): fica registrado, com o motivo em observacao, e não é tentado
-- de novo na mesma janela.
CREATE TABLE IF NOT EXISTS emprestimo.aviso (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 emprestimo_id uuid NOT NULL REFERENCES emprestimo.emprestimo(id),
 tipo text NOT NULL CHECK (tipo IN ('lembrete','vencimento','atraso','escalonamento','devolucao')),
 janela text NOT NULL CHECK (length(janela) BETWEEN 1 AND 80),
 prazo timestamptz,                                                                       -- nulo na confirmação de devolução
 email_id uuid UNIQUE REFERENCES core.email_fila(id) DEFERRABLE INITIALLY DEFERRED,       -- o aviso nasce antes da mensagem, na mesma transação
 observacao text NOT NULL DEFAULT '' CHECK (length(observacao) <= 200),
 criado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE (emprestimo_id, tipo, janela)
);
CREATE INDEX IF NOT EXISTS emprestimo_aviso_criado_idx ON emprestimo.aviso (criado_em DESC);
-- A confirmação de devolução procura as conferências recentes sem passar por empréstimo.
CREATE INDEX IF NOT EXISTS emprestimo_evento_conferencia_idx ON emprestimo.emprestimo_evento (em) WHERE tipo IN ('conferencia','avaria');

-- Registro só cresce (vale também para a função proprietária); quem cancela é a fila, não o registro.
CREATE OR REPLACE FUNCTION emprestimo.aviso_trava() RETURNS trigger LANGUAGE plpgsql SET search_path = emprestimo, pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'O registro de avisos não pode ser alterado ou apagado.' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS aviso_imutavel ON emprestimo.aviso;
CREATE TRIGGER aviso_imutavel BEFORE UPDATE OR DELETE ON emprestimo.aviso FOR EACH ROW EXECUTE FUNCTION emprestimo.aviso_trava();

-- RLS: gestão (admin, gestor, almoxarife; nunca no canal do terminal) lê. Sem policy nem privilégio de INSERT/UPDATE/
-- DELETE: só as funções abaixo gravam. O mesmo vale para emprestimo.config (40): a API só tem SELECT.
ALTER TABLE emprestimo.aviso ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aviso_sel ON emprestimo.aviso;
CREATE POLICY aviso_sel ON emprestimo.aviso FOR SELECT USING (emprestimo.gestao());
REVOKE ALL ON emprestimo.aviso FROM PUBLIC, biotrop_app, biotrop_ro;
GRANT SELECT ON emprestimo.aviso TO biotrop_app, biotrop_ro;

/* ---------------------------------------------------------------- texto dos e-mails */
CREATE OR REPLACE FUNCTION emprestimo.escape_html(p_texto text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT replace(replace(replace(replace(replace(coalesce(p_texto, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;
-- Mesma regra do worker (EMAIL_PATTERN): endereço que o worker recusaria vira "pulado" aqui, e não erro de envio lá.
CREATE OR REPLACE FUNCTION emprestimo.email_valido(p_email text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_email ~* '^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$' AND length(p_email) <= 254, false)
$$;
CREATE OR REPLACE FUNCTION emprestimo.fmt_qtd(q numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(CASE WHEN q = trunc(q) THEN trunc(q)::text ELSE rtrim(q::text, '0') END, '.', ',')
$$;
CREATE OR REPLACE FUNCTION emprestimo.fmt_data(p timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(p AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI')
$$;
CREATE OR REPLACE FUNCTION emprestimo.fmt_atraso(p_horas numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_horas >= 48 THEN floor(p_horas / 24)::integer || ' dias' WHEN p_horas >= 24 THEN '1 dia' ELSE floor(p_horas)::integer || ' h' END
$$;
CREATE OR REPLACE FUNCTION emprestimo.pendente_total(p_emprestimo uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa), 0) FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = p_emprestimo
$$;
-- Só o que está pendente: item já devolvido (ou em conferência) não aparece; devolução parcial mostra só o saldo.
CREATE OR REPLACE FUNCTION emprestimo.aviso_itens_html(p_emprestimo uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce('<table style="border-collapse:collapse;margin:8px 0 14px;font-size:14px">' ||
    '<tr><td style="padding:4px 14px 4px 0;color:#55706d">Código</td><td style="padding:4px 14px 4px 0;color:#55706d">Item</td><td style="padding:4px 0;color:#55706d;text-align:right">Pendente</td></tr>' ||
    string_agg('<tr><td style="padding:4px 14px 4px 0">' || emprestimo.escape_html(x.codigo) || '</td><td style="padding:4px 14px 4px 0">' || emprestimo.escape_html(x.descricao) ||
               '</td><td style="padding:4px 0;text-align:right"><b>' || emprestimo.fmt_qtd(x.pendente) || '</b></td></tr>', '' ORDER BY x.codigo, x.id) || '</table>', '')
    FROM (SELECT i.id, i.codigo, i.descricao, i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa AS pendente
            FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = p_emprestimo) x
   WHERE x.pendente > 0
$$;
-- O que o almoxarife conferiu naquela conferência (os eventos de uma conferência têm o mesmo instante).
CREATE OR REPLACE FUNCTION emprestimo.aviso_conferencia_html(p_emprestimo uuid, p_em timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce('<table style="border-collapse:collapse;margin:8px 0 14px;font-size:14px">' ||
    '<tr><td style="padding:4px 14px 4px 0;color:#55706d">Código</td><td style="padding:4px 14px 4px 0;color:#55706d">Item</td><td style="padding:4px 14px 4px 0;color:#55706d;text-align:right">Qtd.</td><td style="padding:4px 0;color:#55706d">Condição</td></tr>' ||
    string_agg('<tr><td style="padding:4px 14px 4px 0">' || emprestimo.escape_html(i.codigo) || '</td><td style="padding:4px 14px 4px 0">' || emprestimo.escape_html(i.descricao) ||
               '</td><td style="padding:4px 14px 4px 0;text-align:right"><b>' || emprestimo.fmt_qtd(v.quantidade) || '</b></td><td style="padding:4px 0">' ||
               CASE v.tipo WHEN 'avaria' THEN 'Com avaria' ELSE 'Boa' END || '</td></tr>', '' ORDER BY i.codigo, v.id) || '</table>', '')
    FROM emprestimo.emprestimo_evento v JOIN emprestimo.emprestimo_item i ON i.id = v.item_id
   WHERE v.emprestimo_id = p_emprestimo AND v.em = p_em AND v.tipo IN ('conferencia','avaria')
$$;
-- Moldura igual à do certificado do LMS (29): faixa verde com o módulo, título e corpo.
CREATE OR REPLACE FUNCTION emprestimo.aviso_html(p_titulo text, p_corpo text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '<div style="font-family:Arial,sans-serif;color:#173431;max-width:640px;border:1px solid #d9e6e1;border-radius:14px;overflow:hidden">' ||
    '<div style="background:#00634e;color:#fff;padding:18px 22px"><div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.85">Biotrop · Almoxarifado</div>' ||
    '<div style="font-size:22px;font-weight:bold;margin-top:4px">' || emprestimo.escape_html(p_titulo) || '</div></div>' ||
    '<div style="padding:20px 22px">' || p_corpo ||
    '<p style="color:#55706d;font-size:12px;margin-top:18px">Mensagem automática da Plataforma de Manutenção BIOTROP.</p></div></div>'
$$;

/* ---------------------------------------------------------------- enfileiramento (chamado pelo worker a cada ciclo) */
-- p_agora existe para os testes simularem o tempo; o worker só alcança emprestimo.enfileirar_avisos(), que usa now().
CREATE OR REPLACE FUNCTION emprestimo.enfileirar_avisos_em(p_agora timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, public, pg_temp AS $$
DECLARE
 cfg emprestimo.config%ROWTYPE; r record; c record;
 v_aviso uuid; v_mail uuid; v_para citext; v_copia citext[]; v_obs text;
 v_assunto text; v_titulo text; v_corpo text; v_ola text; v_onde text; v_total integer := 0;
BEGIN
 -- 1) o que ainda espera na fila e perdeu o sentido: a pendência acabou (devolução, baixa, estorno) ou o prazo mudou
 UPDATE core.email_fila f
    SET status = 'cancelado',
        erro = CASE WHEN e.status IN ('em_andamento','parcialmente_devolvido','aguardando_conferencia') AND emprestimo.pendente_total(e.id) > 0
                    THEN 'Cancelado: o prazo do empréstimo mudou' ELSE 'Cancelado: não há mais pendência neste empréstimo' END
   FROM emprestimo.aviso a JOIN emprestimo.emprestimo e ON e.id = a.emprestimo_id
  WHERE f.id = a.email_id AND f.status = 'pendente' AND a.tipo <> 'devolucao'
    AND (e.status NOT IN ('em_andamento','parcialmente_devolvido','aguardando_conferencia') OR a.prazo IS DISTINCT FROM e.prazo
         OR emprestimo.pendente_total(e.id) = 0);

 SELECT * INTO cfg FROM emprestimo.config WHERE id;
 -- avisos desligados no painel: o que já esperava na fila também não sai (não só deixa de enfileirar o novo)
 IF NOT FOUND THEN RETURN 0; END IF;
 IF NOT cfg.avisos_ativos THEN
   UPDATE core.email_fila f SET status = 'cancelado', erro = 'Cancelado: avisos de empréstimo desligados'
     FROM emprestimo.aviso a WHERE f.id = a.email_id AND f.status = 'pendente';
   RETURN 0;
 END IF;
 v_onde := '<p>Devolva no <b>Almoxarifado</b>: pelo terminal de empréstimo, na entrada, ou com o almoxarife. Precisa de mais prazo? Fale com o Almoxarifado.</p>';

 -- 2) o que cabe agora, empréstimo a empréstimo, menos as janelas já registradas
 FOR r IN
   WITH ab AS (
     SELECT e.id, e.numero, e.colaborador_id, e.atendente_id, e.prazo, e.criado_em,
            to_char(e.prazo AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS pk,
            extract(epoch FROM p_agora - e.prazo) / 3600 AS horas                              -- negativo antes do prazo
       FROM emprestimo.emprestimo e
      WHERE e.status IN ('em_andamento','parcialmente_devolvido','aguardando_conferencia')
        AND e.prazo <= p_agora + make_interval(hours => cfg.lembrete_antes_horas)
        AND emprestimo.pendente_total(e.id) > 0
   ), cand AS (
     SELECT ab.*, 'lembrete'::text AS tipo, ab.pk AS janela, NULL::timestamptz AS conf_em FROM ab
      WHERE ab.horas < 0 AND ab.prazo - ab.criado_em > make_interval(hours => cfg.lembrete_antes_horas)
     UNION ALL
     SELECT ab.*, 'vencimento', ab.pk, NULL FROM ab
      WHERE cfg.aviso_no_vencimento AND ab.horas >= 0 AND ab.horas < cfg.atraso_intervalo_horas
     UNION ALL
     -- atraso: nº de ordem = o maior já registrado naquele prazo + 1 (nunca repete um número). Numerar pelo tempo
     -- (horas ÷ intervalo) fazia o aumento do intervalo cair em números já usados e calar o aviso por dias; quem
     -- espaça os avisos é a trava por criado_em logo abaixo.
     SELECT ab.*, 'atraso', ab.pk || ':' || (SELECT coalesce(max(split_part(a.janela, ':', 2)::integer), 0) + 1 FROM emprestimo.aviso a
                                             WHERE a.emprestimo_id = ab.id AND a.tipo = 'atraso' AND a.prazo = ab.prazo), NULL FROM ab
      WHERE ab.horas >= cfg.atraso_intervalo_horas
        AND NOT EXISTS (SELECT 1 FROM emprestimo.aviso a WHERE a.emprestimo_id = ab.id AND a.tipo = 'atraso' AND a.prazo = ab.prazo
                          AND a.criado_em > p_agora - make_interval(hours => cfg.atraso_intervalo_horas))
     UNION ALL
     SELECT ab.*, 'escalonamento', ab.pk, NULL FROM ab WHERE ab.horas >= cfg.escalar_apos_horas
     UNION ALL
     SELECT e.id, e.numero, e.colaborador_id, e.atendente_id, e.prazo, e.criado_em, NULL, NULL,
            'devolucao', to_char(v.em AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'), v.em
       FROM (SELECT DISTINCT x.emprestimo_id, x.em FROM emprestimo.emprestimo_evento x
              WHERE cfg.aviso_devolucao AND x.tipo IN ('conferencia','avaria') AND x.em <= p_agora
                AND x.em >= greatest(coalesce(cfg.aviso_devolucao_desde, cfg.atualizado_em), p_agora - interval '7 days')) v
       JOIN emprestimo.emprestimo e ON e.id = v.emprestimo_id
   )
   SELECT * FROM cand k
    WHERE NOT EXISTS (SELECT 1 FROM emprestimo.aviso a WHERE a.emprestimo_id = k.id AND a.tipo = k.tipo AND a.janela = k.janela)
    ORDER BY k.prazo, k.id, k.tipo, k.janela
 LOOP
   v_para := NULL; v_copia := NULL; v_obs := ''; v_mail := NULL; v_aviso := NULL;
   -- inativo como no resto do módulo (41): cadastro do terminal desligado no painel OU usuário do site desativado
   SELECT u.nome, u.email, u.ativo AND coalesce(col.ativo, false) AS ativo INTO c
     FROM core.usuario u LEFT JOIN emprestimo.colaborador col ON col.usuario_id = u.id WHERE u.id = r.colaborador_id;
   IF r.tipo = 'escalonamento' THEN
     SELECT array_agg(u.email ORDER BY (u.id IS NOT DISTINCT FROM r.atendente_id) DESC, (u.perfil_id = 'almoxarife') DESC, u.nome, u.email) INTO v_copia
       FROM core.usuario u
      WHERE u.ativo AND NOT u.bloqueado AND emprestimo.email_valido(u.email::text) AND u.id <> r.colaborador_id
        AND (u.perfil_id IN ('almoxarife','gestor') OR (u.id = r.atendente_id AND u.perfil_id = 'admin'));
     IF v_copia IS NULL THEN v_obs := 'Ninguém do almoxarifado ou da gestão com e-mail válido';
     ELSE v_para := v_copia[1]; v_copia := v_copia[2:41]; END IF;
   ELSIF NOT coalesce(c.ativo, false) THEN v_obs := 'Colaborador inativo';
   ELSIF NOT emprestimo.email_valido(c.email::text) THEN v_obs := 'Colaborador sem e-mail válido';
   ELSE v_para := c.email;
   END IF;
   IF v_para IS NOT NULL THEN v_mail := gen_random_uuid(); END IF;

   INSERT INTO emprestimo.aviso (emprestimo_id, tipo, janela, prazo, email_id, observacao, criado_em)
   VALUES (r.id, r.tipo, r.janela, CASE WHEN r.tipo <> 'devolucao' THEN r.prazo END, v_mail, v_obs, p_agora)
   ON CONFLICT (emprestimo_id, tipo, janela) DO NOTHING
   RETURNING id INTO v_aviso;
   -- outro worker já registrou esta janela, ou não há para quem mandar (o registro do pulo basta)
   CONTINUE WHEN v_aviso IS NULL OR v_mail IS NULL;

   v_ola := '<p>Olá, ' || emprestimo.escape_html(split_part(btrim(c.nome), ' ', 1)) || '.</p>';
   IF r.tipo = 'lembrete' THEN
     v_assunto := '[Lembrete] Empréstimo ' || r.numero || ' vence em ' || to_char(r.prazo AT TIME ZONE 'America/Sao_Paulo', 'DD/MM "às" HH24:MI');
     v_titulo := 'Lembrete de devolução';
     v_corpo := v_ola || '<p>O empréstimo <b>' || emprestimo.escape_html(r.numero) || '</b> vence em <b>' || emprestimo.fmt_data(r.prazo) ||
                '</b>. Itens que ainda estão com você:</p>' || emprestimo.aviso_itens_html(r.id) || v_onde;
   ELSIF r.tipo = 'vencimento' THEN
     v_assunto := '[Empréstimo] ' || r.numero || ': o prazo de devolução venceu';
     v_titulo := 'Prazo de devolução vencido';
     v_corpo := v_ola || '<p>O prazo do empréstimo <b>' || emprestimo.escape_html(r.numero) || '</b> venceu em <b>' || emprestimo.fmt_data(r.prazo) ||
                '</b>. Devolva o quanto antes:</p>' || emprestimo.aviso_itens_html(r.id) || v_onde;
   ELSIF r.tipo = 'atraso' THEN
     v_assunto := '[Ação necessária] Empréstimo ' || r.numero || ' em atraso';
     v_titulo := 'Empréstimo em atraso';
     v_corpo := v_ola || '<p>O empréstimo <b>' || emprestimo.escape_html(r.numero) || '</b> está em atraso desde <b>' || emprestimo.fmt_data(r.prazo) ||
                '</b> (' || emprestimo.fmt_atraso(r.horas) || '). Itens pendentes:</p>' || emprestimo.aviso_itens_html(r.id) || v_onde;
   ELSIF r.tipo = 'escalonamento' THEN
     v_assunto := '[Almoxarifado] Empréstimo ' || r.numero || ' em atraso há ' || emprestimo.fmt_atraso(r.horas);
     v_titulo := 'Atraso prolongado';
     v_corpo := '<p>O empréstimo <b>' || emprestimo.escape_html(r.numero) || '</b>, de <b>' || emprestimo.escape_html(c.nome) || '</b>, está em atraso desde <b>' ||
                emprestimo.fmt_data(r.prazo) || '</b> (' || emprestimo.fmt_atraso(r.horas) || '). Itens pendentes:</p>' || emprestimo.aviso_itens_html(r.id) ||
                '<p style="color:#55706d">Acompanhe na Plataforma de Manutenção, em Almoxarifado › Empréstimos.</p>';
   ELSE   -- devolução conferida
     v_assunto := '[Almoxarifado] Devolução conferida: ' || r.numero;
     v_titulo := 'Devolução conferida';
     v_corpo := v_ola || '<p>O Almoxarifado conferiu a devolução do empréstimo <b>' || emprestimo.escape_html(r.numero) || '</b> em <b>' || emprestimo.fmt_data(r.conf_em) ||
                '</b>:</p>' || emprestimo.aviso_conferencia_html(r.id, r.conf_em) ||
                CASE WHEN emprestimo.pendente_total(r.id) > 0
                     THEN '<p>Ainda está com você (prazo <b>' || emprestimo.fmt_data(r.prazo) || '</b>):</p>' || emprestimo.aviso_itens_html(r.id) || v_onde
                     ELSE '<p>Nada mais pendente neste empréstimo. Obrigado!</p>' END;
   END IF;
   INSERT INTO core.email_fila (id, destinatario, copia, assunto, corpo_html, referencia_tabela, referencia_id, motivo)
   VALUES (v_mail, v_para, nullif(v_copia, '{}'::citext[]), left(v_assunto, 255), emprestimo.aviso_html(v_titulo, v_corpo), 'emprestimo.aviso', v_aviso::text, 'emprestimo_' || r.tipo);
   v_total := v_total + 1;
 END LOOP;
 RETURN v_total;
END $$;
COMMENT ON FUNCTION emprestimo.enfileirar_avisos_em(timestamptz) IS
  'Avisos do empréstimo (lembrete, vencimento, atraso, escalonamento, devolução conferida) sobre a quantidade pendente, sem duplicidade (emprestimo.aviso). Devolve quantos e-mails entraram na fila.';

CREATE OR REPLACE FUNCTION emprestimo.enfileirar_avisos() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = emprestimo, core, public, pg_temp AS $$ SELECT emprestimo.enfileirar_avisos_em(now()) $$;
COMMENT ON FUNCTION emprestimo.enfileirar_avisos() IS 'Chamada pelo worker de e-mail a cada ciclo (como lms.enfileirar_cobrancas_treinamento). Sempre no horário do banco.';

/* ---------------------------------------------------------------- configuração e registro, pela API do painel */
-- Gestão lê a configuração pelo RLS de emprestimo.config; gravar os avisos é da gerência (admin/gestor), conferido aqui
-- de novo (a rota também confere) e auditado em emprestimo.auditoria com o antes e o depois.
CREATE OR REPLACE FUNCTION emprestimo.avisos_config_salvar(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = emprestimo, core, app, public, pg_temp AS $$
DECLARE uid uuid; antes emprestimo.config%ROWTYPE; cfg emprestimo.config%ROWTYPE; k text;
BEGIN
 IF NOT app.usuario_ativo() THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501'; END IF;
 IF NOT emprestimo.gerencia() THEN RAISE EXCEPTION 'Somente gestor e administrador.' USING ERRCODE = '42501'; END IF;
 uid := app.usuario_atual();
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Dados inválidos.' USING ERRCODE = '22023'; END IF;
 FOREACH k IN ARRAY ARRAY['avisosAtivos','avisoNoVencimento','avisoDevolucao'] LOOP
   IF p ? k AND jsonb_typeof(p->k) <> 'boolean' THEN RAISE EXCEPTION 'Use verdadeiro ou falso nas opções de aviso.' USING ERRCODE = '22023'; END IF;
 END LOOP;
 IF p ? 'escalarAposHoras' THEN
   IF jsonb_typeof(p->'escalarAposHoras') <> 'number' OR (p->>'escalarAposHoras') !~ '^[0-9]{1,3}$' THEN RAISE EXCEPTION 'Escalonamento: de 1 a 720 horas.' USING ERRCODE = '22023'; END IF;
   IF (p->>'escalarAposHoras')::integer NOT BETWEEN 1 AND 720 THEN RAISE EXCEPTION 'Escalonamento: de 1 a 720 horas.' USING ERRCODE = '22023'; END IF;
 END IF;
 SELECT * INTO antes FROM emprestimo.config WHERE id FOR UPDATE;
 UPDATE emprestimo.config SET avisos_ativos = coalesce((p->>'avisosAtivos')::boolean, avisos_ativos),
   aviso_no_vencimento = coalesce((p->>'avisoNoVencimento')::boolean, aviso_no_vencimento),
   escalar_apos_horas = coalesce((p->>'escalarAposHoras')::integer, escalar_apos_horas),
   aviso_devolucao = coalesce((p->>'avisoDevolucao')::boolean, aviso_devolucao),
   aviso_devolucao_desde = CASE WHEN coalesce((p->>'avisoDevolucao')::boolean, aviso_devolucao) AND NOT aviso_devolucao THEN now() ELSE aviso_devolucao_desde END,
   atualizado_por = uid, atualizado_em = now()
  WHERE id RETURNING * INTO cfg;
 INSERT INTO emprestimo.auditoria (tipo, detalhe, por) VALUES ('avisos_config_salva', jsonb_build_object(
   'antes', jsonb_build_object('avisosAtivos', antes.avisos_ativos, 'avisoNoVencimento', antes.aviso_no_vencimento, 'escalarAposHoras', antes.escalar_apos_horas, 'avisoDevolucao', antes.aviso_devolucao),
   'depois', jsonb_build_object('avisosAtivos', cfg.avisos_ativos, 'avisoNoVencimento', cfg.aviso_no_vencimento, 'escalarAposHoras', cfg.escalar_apos_horas, 'avisoDevolucao', cfg.aviso_devolucao)), uid);
 RETURN jsonb_build_object('avisosAtivos', cfg.avisos_ativos, 'avisoNoVencimento', cfg.aviso_no_vencimento, 'escalarAposHoras', cfg.escalar_apos_horas,
   'avisoDevolucao', cfg.aviso_devolucao, 'lembreteAntesHoras', cfg.lembrete_antes_horas, 'atrasoIntervaloHoras', cfg.atraso_intervalo_horas);
END $$;

-- Registro para a tela "Avisos enviados": situação da fila (o RLS de core.email_fila só deixa o admin ler), sem assunto
-- nem corpo. Pulado = não havia para quem mandar; o motivo vem em observacao, e o erro da fila também (texto genérico).
CREATE OR REPLACE FUNCTION emprestimo.avisos_log(p_limite integer DEFAULT 200)
RETURNS TABLE(id uuid, emprestimo_id uuid, emprestimo_numero text, tipo text, destinatario text, copias integer, status text, tentativas integer,
  criado_em timestamptz, enviado_em timestamptz, observacao text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = emprestimo, core, app, pg_temp AS $$
  SELECT a.id, a.emprestimo_id, e.numero, a.tipo, coalesce(f.destinatario::text, ''), coalesce(cardinality(f.copia), 0),
         CASE WHEN a.email_id IS NULL THEN 'pulado' ELSE coalesce(f.status::text, 'pendente') END, coalesce(f.tentativas, 0)::integer,
         a.criado_em, f.enviado_em, CASE WHEN a.email_id IS NULL THEN a.observacao ELSE coalesce(f.erro, '') END
    FROM emprestimo.aviso a JOIN emprestimo.emprestimo e ON e.id = a.emprestimo_id LEFT JOIN core.email_fila f ON f.id = a.email_id
   WHERE app.usuario_ativo() AND emprestimo.gestao()
   ORDER BY a.criado_em DESC, a.id
   LIMIT least(greatest(coalesce(p_limite, 200), 1), 500)
$$;

/* ---------------------------------------------------------------- quem pode chamar o quê */
-- O worker (biotrop_worker) só alcança emprestimo.enfileirar_avisos(): nenhuma tabela do schema, nenhuma outra função.
-- Sem GRANT de tabela para ele aqui: a conferência de 02a barra o deploy se a role ganhar tabela fora de core.email_fila.
REVOKE ALL ON FUNCTION emprestimo.escape_html(text), emprestimo.email_valido(text), emprestimo.fmt_qtd(numeric), emprestimo.fmt_data(timestamptz),
  emprestimo.fmt_atraso(numeric), emprestimo.pendente_total(uuid), emprestimo.aviso_itens_html(uuid), emprestimo.aviso_conferencia_html(uuid, timestamptz),
  emprestimo.aviso_html(text, text), emprestimo.enfileirar_avisos_em(timestamptz), emprestimo.enfileirar_avisos(),
  emprestimo.avisos_config_salvar(jsonb), emprestimo.avisos_log(integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA emprestimo TO biotrop_worker;
GRANT EXECUTE ON FUNCTION emprestimo.enfileirar_avisos() TO biotrop_worker;
GRANT EXECUTE ON FUNCTION emprestimo.avisos_config_salvar(jsonb), emprestimo.avisos_log(integer) TO biotrop_app;
COMMIT;
