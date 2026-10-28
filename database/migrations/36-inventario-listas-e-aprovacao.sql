-- Inventário, segunda etapa: listas por CAMM, origem da importação, justificativa de divergência e aprovação.
--  • base (snapshot): hash do arquivo (reimportar o mesmo arquivo é avisado), data da exportação e pendências
--    da importação (sem cadastro, sem localização, duplicidade) — pendência não vira saldo zero.
--  • item: CAMM/lista de trabalho; cada lista tem seus três contadores. A mesma posição não entra duas vezes
--    na mesma campanha (UNIQUE campanha_id, linha_id da 34).
--  • justificativa: append-only, obrigatória para cada posição com resultado final diferente do saldo.
--  • fechar = aprovar: só gestor/admin, que não pode ter contado nesse inventário. Falta de custo não bloqueia
--    (o relatório mostra a cobertura de valorização); unidade continua obrigatória.
-- Idempotente: só ADD COLUMN IF NOT EXISTS, CREATE IF NOT EXISTS e CREATE OR REPLACE. Redefine
-- inventario.executar (a versão da 34 é sobrescrita aqui a cada deploy).
BEGIN;

ALTER TABLE inventario.snapshot ADD COLUMN IF NOT EXISTS arquivo_hash text NOT NULL DEFAULT '' CHECK (arquivo_hash ~ '^([0-9a-f]{64})?$');
ALTER TABLE inventario.snapshot ADD COLUMN IF NOT EXISTS data_exportacao date;
ALTER TABLE inventario.snapshot ADD COLUMN IF NOT EXISTS pendencias jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(pendencias) = 'array');
ALTER TABLE inventario.snapshot ADD COLUMN IF NOT EXISTS resumo jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(resumo) = 'object');
CREATE INDEX IF NOT EXISTS inventario_snapshot_hash ON inventario.snapshot(arquivo_hash) WHERE arquivo_hash <> '';

ALTER TABLE inventario.item ADD COLUMN IF NOT EXISTS camm text NOT NULL DEFAULT '' CHECK (length(camm) <= 80);
CREATE INDEX IF NOT EXISTS inventario_item_camm ON inventario.item(campanha_id, camm);

ALTER TABLE inventario.campanha ADD COLUMN IF NOT EXISTS observacoes text NOT NULL DEFAULT '' CHECK (length(observacoes) <= 2000);
ALTER TABLE inventario.campanha ADD COLUMN IF NOT EXISTS aprovacao_obs text NOT NULL DEFAULT '' CHECK (length(aprovacao_obs) <= 2000);

CREATE TABLE IF NOT EXISTS inventario.justificativa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES inventario.item(id),
  texto text NOT NULL CHECK (length(btrim(texto)) BETWEEN 3 AND 1000),
  por uuid NOT NULL REFERENCES core.usuario(id),
  em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventario_justificativa_item ON inventario.justificativa(item_id, em);
ALTER TABLE inventario.justificativa ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS justificativa_gestao ON inventario.justificativa;
CREATE POLICY justificativa_gestao ON inventario.justificativa FOR SELECT USING (inventario.gestao());
REVOKE ALL ON inventario.justificativa FROM PUBLIC, biotrop_app, biotrop_ro;
GRANT SELECT ON inventario.justificativa TO biotrop_app, biotrop_ro;

CREATE OR REPLACE FUNCTION inventario.trava_justificativa() RETURNS trigger LANGUAGE plpgsql SET search_path = inventario, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Justificativa não pode ser alterada ou apagada; registre outra.' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS justificativa_imutavel ON inventario.justificativa;
CREATE TRIGGER justificativa_imutavel BEFORE UPDATE OR DELETE ON inventario.justificativa FOR EACH ROW EXECUTE FUNCTION inventario.trava_justificativa();

-- Quem contou (em qualquer etapa) num inventário aberto não acompanha nem aprova esse inventário.
CREATE OR REPLACE FUNCTION inventario.contador_em(p_campanha uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = inventario, app, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM inventario.item i WHERE i.campanha_id = p_campanha
                 AND app.usuario_atual() IN (i.contador1_id, i.contador2_id, i.contador3_id));
$$;
REVOKE ALL ON FUNCTION inventario.contador_em(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventario.contador_em(uuid) TO biotrop_app, biotrop_ro;

-- Nome de quem contou/aprovou no relatório, inclusive de quem já saiu (inativo). Só gestão.
CREATE OR REPLACE FUNCTION inventario.nomes(p_ids uuid[]) RETURNS TABLE(id uuid, nome text) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = inventario, core, app, pg_temp AS $$
BEGIN
  IF NOT inventario.gestao() THEN RAISE EXCEPTION 'Somente gestão.' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT u.id, u.nome FROM core.usuario u WHERE u.id = ANY(p_ids);
END $$;
REVOKE ALL ON FUNCTION inventario.nomes(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventario.nomes(uuid[]) TO biotrop_app;

CREATE OR REPLACE FUNCTION inventario.executar(acao text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = inventario, core, almox, app, pg_temp AS $$
DECLARE uid uuid; s inventario.snapshot%ROWTYPE; c inventario.campanha%ROWTYPE; i inventario.item%ROWTYPE;
 l inventario.snapshot_linha%ROWTYPE; v jsonb; lista jsonb; listas jsonb; n numeric(20,6); alvo uuid; esperado integer;
 total integer := 0; a uuid; b uuid; d uuid; nome_camm text; vistos uuid[] := '{}';
BEGIN
  IF NOT app.usuario_ativo() THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501'; END IF;
  uid := app.usuario_atual();
  IF acao = 'contar' THEN
    SELECT * INTO i FROM inventario.item WHERE id = (p->>'id')::uuid FOR UPDATE;
    IF NOT FOUND OR uid NOT IN (i.contador1_id, i.contador2_id, i.contador3_id) THEN RAISE EXCEPTION 'Contagem não atribuída.' USING ERRCODE = '42501'; END IF;
    SELECT * INTO c FROM inventario.campanha WHERE id = i.campanha_id FOR UPDATE;
    IF c.estado <> 'aberta' OR i.encerrado THEN RAISE EXCEPTION 'Contagem já encerrada.' USING ERRCODE = 'P0001'; END IF;
    alvo := CASE i.etapa WHEN 1 THEN i.contador1_id WHEN 2 THEN i.contador2_id ELSE i.contador3_id END;
    IF alvo <> uid THEN RAISE EXCEPTION 'Aguarde sua etapa de contagem.' USING ERRCODE = '42501'; END IF;
    esperado := (p->>'expectedVersion')::integer;
    IF esperado IS NULL OR esperado <> i.versao THEN RAISE EXCEPTION 'Versão desatualizada.' USING ERRCODE = 'P0001'; END IF;
    IF coalesce(p->>'quantidade', '') !~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE = '22023'; END IF;
    n := (p->>'quantidade')::numeric;
    SELECT * INTO l FROM inventario.snapshot_linha WHERE id = i.linha_id;
    INSERT INTO inventario.contagem(item_id, etapa, quantidade, por) VALUES (i.id, i.etapa, n, uid);
    UPDATE inventario.item SET encerrado = (n = l.saldo OR i.etapa = 3),
      etapa = CASE WHEN n = l.saldo OR i.etapa = 3 THEN i.etapa ELSE i.etapa + 1 END, versao = versao + 1
     WHERE id = i.id RETURNING * INTO i;
    RETURN jsonb_build_object('id', i.id, 'etapa', i.etapa, 'encerrado', i.encerrado, 'versao', i.versao);
  END IF;

  IF NOT inventario.gestao() THEN RAISE EXCEPTION 'Somente almoxarifado e gestão.' USING ERRCODE = '42501'; END IF;

  IF acao = 'snapshot' THEN
    IF jsonb_typeof(coalesce(p->'pendencias', '[]')) <> 'array' OR jsonb_array_length(coalesce(p->'pendencias', '[]')) > 20000 THEN
      RAISE EXCEPTION 'Pendências inválidas.' USING ERRCODE = '22023'; END IF;
    INSERT INTO inventario.snapshot(nome, data_referencia, fonte, criado_por, arquivo_hash, data_exportacao, pendencias, resumo)
    VALUES (p->>'nome', (p->>'dataReferencia')::date, coalesce(p->>'fonte', ''), uid, coalesce(p->>'arquivoHash', ''),
            nullif(p->>'dataExportacao', '')::date, coalesce(p->'pendencias', '[]'), coalesce(p->'resumo', '{}'))
    RETURNING * INTO s;
    RETURN to_jsonb(s) - 'pendencias';

  ELSIF acao = 'importar' THEN
    SELECT * INTO s FROM inventario.snapshot WHERE id = (p->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Base inexistente.' USING ERRCODE = 'P0002'; END IF;
    IF s.estado <> 'rascunho' THEN RAISE EXCEPTION 'Base finalizada é imutável.' USING ERRCODE = '42501'; END IF;
    IF jsonb_typeof(p->'linhas') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'linhas') NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Envie entre 1 e 2000 linhas.' USING ERRCODE = '22023'; END IF;
    FOR v IN SELECT value FROM jsonb_array_elements(p->'linhas') LOOP
      IF coalesce(v->>'codigo', '') !~ '^MAN[A-Z0-9._/-]*$' OR coalesce(v->>'saldo', '') !~ '^-?[0-9]{1,14}(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'Código MAN ou saldo inválido.' USING ERRCODE = '22023'; END IF;
      IF v->>'precoUnitario' IS NOT NULL AND (v->>'precoUnitario') !~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'Preço inválido.' USING ERRCODE = '22023'; END IF;
      IF coalesce(v->>'site', '') = '' OR coalesce(v->>'deposito', '') = '' OR coalesce(v->>'localizacao', '') = '' THEN RAISE EXCEPTION 'Informe site, depósito e localização.' USING ERRCODE = '22023'; END IF;
      INSERT INTO inventario.snapshot_linha(snapshot_id, codigo, descricao, unidade, site, deposito, localizacao, lote, serie, variante, status, dimensoes_extras, saldo, preco_unitario, origem_preco)
      VALUES (s.id, v->>'codigo', v->>'descricao', coalesce(v->>'unidade', ''), v->>'site', v->>'deposito', v->>'localizacao', coalesce(v->>'lote', ''), coalesce(v->>'serie', ''),
              coalesce(v->>'variante', ''), coalesce(v->>'status', ''), coalesce(v->'dimensoesExtras', '{}'), (v->>'saldo')::numeric, (v->>'precoUnitario')::numeric, coalesce(v->'origemPreco', '{}'));
      total := total + 1;
    END LOOP;
    RETURN jsonb_build_object('id', s.id, 'importadas', total);

  ELSIF acao = 'finalizar' THEN
    SELECT * INTO s FROM inventario.snapshot WHERE id = (p->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Base inexistente.' USING ERRCODE = 'P0002'; END IF;
    IF s.estado <> 'rascunho' THEN RAISE EXCEPTION 'Base já finalizada.' USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventario.snapshot_linha WHERE snapshot_id = s.id) THEN RAISE EXCEPTION 'Importe linhas antes de finalizar.' USING ERRCODE = 'P0001'; END IF;
    UPDATE inventario.snapshot SET estado = 'pronto', finalizado_em = now() WHERE id = s.id RETURNING * INTO s;
    RETURN to_jsonb(s) - 'pendencias';

  ELSIF acao = 'descartar' THEN
    -- importação que falhou no meio: o rascunho (ainda sem inventário) pode ser apagado e importado de novo
    SELECT * INTO s FROM inventario.snapshot WHERE id = (p->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Base inexistente.' USING ERRCODE = 'P0002'; END IF;
    IF s.estado <> 'rascunho' THEN RAISE EXCEPTION 'Base finalizada não pode ser apagada.' USING ERRCODE = '42501'; END IF;
    DELETE FROM inventario.snapshot_linha WHERE snapshot_id = s.id;
    DELETE FROM inventario.snapshot WHERE id = s.id;
    RETURN jsonb_build_object('id', s.id, 'descartada', true);

  ELSIF acao = 'campanha' THEN
    SELECT * INTO s FROM inventario.snapshot WHERE id = (p->>'snapshotId')::uuid FOR UPDATE;
    IF NOT FOUND OR s.estado <> 'pronto' THEN RAISE EXCEPTION 'Escolha uma base finalizada.' USING ERRCODE = 'P0001'; END IF;
    -- formato antigo (uma lista só, sem CAMM) continua aceito
    listas := CASE WHEN jsonb_typeof(p->'listas') = 'array' THEN p->'listas'
                   ELSE jsonb_build_array(jsonb_build_object('camm', '', 'linhaIds', p->'linhaIds', 'contador1Id', p->>'contador1Id', 'contador2Id', p->>'contador2Id', 'contador3Id', p->>'contador3Id')) END;
    IF jsonb_array_length(listas) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Informe de 1 a 200 listas.' USING ERRCODE = '22023'; END IF;
    INSERT INTO inventario.campanha(nome, snapshot_id, criado_por, observacoes) VALUES (p->>'nome', s.id, uid, coalesce(p->>'observacoes', '')) RETURNING * INTO c;
    FOR lista IN SELECT value FROM jsonb_array_elements(listas) LOOP
      nome_camm := btrim(coalesce(lista->>'camm', ''));
      IF length(nome_camm) > 80 THEN RAISE EXCEPTION 'Nome do CAMM acima de 80 caracteres.' USING ERRCODE = '22023'; END IF;
      a := (lista->>'contador1Id')::uuid; b := (lista->>'contador2Id')::uuid; d := (lista->>'contador3Id')::uuid;
      IF a IS NULL OR b IS NULL OR d IS NULL OR a = b OR a = d OR b = d OR (SELECT count(*) FROM core.usuario WHERE id IN (a, b, d) AND ativo AND NOT bloqueado) <> 3 THEN
        RAISE EXCEPTION 'Escolha três contadores ativos e distintos em cada lista.' USING ERRCODE = '22023'; END IF;
      IF jsonb_typeof(lista->'linhaIds') IS DISTINCT FROM 'array' OR jsonb_array_length(lista->'linhaIds') < 1 THEN RAISE EXCEPTION 'Lista sem posições.' USING ERRCODE = '22023'; END IF;
      FOR v IN SELECT value FROM jsonb_array_elements(lista->'linhaIds') LOOP
        SELECT * INTO l FROM inventario.snapshot_linha WHERE id = (v #>> '{}')::uuid AND snapshot_id = s.id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Linha não pertence à base.' USING ERRCODE = '22023'; END IF;
        IF l.id = ANY(vistos) THEN RAISE EXCEPTION 'A posição % / % está em duas listas. Cada posição entra uma vez só.', l.codigo, l.localizacao USING ERRCODE = 'P0001'; END IF;
        vistos := vistos || l.id; total := total + 1;
        IF total > 20000 THEN RAISE EXCEPTION 'Selecione até 20000 posições.' USING ERRCODE = '22023'; END IF;
        INSERT INTO inventario.item(campanha_id, linha_id, codigo, descricao, unidade, site, deposito, localizacao, lote, serie, variante, status, dimensoes_extras, contador1_id, contador2_id, contador3_id, camm)
        VALUES (c.id, l.id, l.codigo, l.descricao, l.unidade, l.site, l.deposito, l.localizacao, l.lote, l.serie, l.variante, l.status, l.dimensoes_extras, a, b, d, nome_camm);
      END LOOP;
    END LOOP;
    RETURN to_jsonb(c);

  ELSIF acao = 'justificar' THEN
    SELECT * INTO i FROM inventario.item WHERE id = (p->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Posição inexistente.' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO c FROM inventario.campanha WHERE id = i.campanha_id;
    IF c.estado <> 'aberta' THEN RAISE EXCEPTION 'Inventário já aprovado.' USING ERRCODE = 'P0001'; END IF;
    IF inventario.contador_em(c.id) THEN RAISE EXCEPTION 'Quem conta neste inventário não justifica as divergências.' USING ERRCODE = '42501'; END IF;
    IF NOT i.encerrado THEN RAISE EXCEPTION 'Justifique depois do resultado final.' USING ERRCODE = 'P0001'; END IF;
    IF length(btrim(coalesce(p->>'texto', ''))) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Escreva a justificativa (3 a 1000 caracteres).' USING ERRCODE = '22023'; END IF;
    INSERT INTO inventario.justificativa(item_id, texto, por) VALUES (i.id, btrim(p->>'texto'), uid);
    RETURN jsonb_build_object('id', i.id, 'justificada', true);

  ELSIF acao = 'fechar' THEN
    IF NOT app.tem_perfil(ARRAY['admin', 'gestor']) THEN RAISE EXCEPTION 'A aprovação do inventário é da gestão.' USING ERRCODE = '42501'; END IF;
    SELECT * INTO c FROM inventario.campanha WHERE id = (p->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Inventário inexistente.' USING ERRCODE = 'P0002'; END IF;
    IF c.estado <> 'aberta' THEN RAISE EXCEPTION 'Inventário já aprovado.' USING ERRCODE = 'P0001'; END IF;
    IF inventario.contador_em(c.id) THEN RAISE EXCEPTION 'Quem contou neste inventário não pode aprová-lo.' USING ERRCODE = '42501'; END IF;
    IF EXISTS (SELECT 1 FROM inventario.item it WHERE it.campanha_id = c.id AND NOT it.encerrado) THEN
      RAISE EXCEPTION 'Há posições sem resultado final.' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM inventario.item it JOIN inventario.snapshot_linha sl ON sl.id = it.linha_id WHERE it.campanha_id = c.id AND btrim(sl.unidade) = '') THEN
      RAISE EXCEPTION 'Há posições sem unidade de medida.' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM inventario.item it JOIN inventario.snapshot_linha sl ON sl.id = it.linha_id
                WHERE it.campanha_id = c.id
                  AND (SELECT x.quantidade FROM inventario.contagem x WHERE x.item_id = it.id ORDER BY x.etapa DESC LIMIT 1) <> sl.saldo
                  AND NOT EXISTS (SELECT 1 FROM inventario.justificativa j WHERE j.item_id = it.id)) THEN
      RAISE EXCEPTION 'Justifique todas as divergências antes de aprovar.' USING ERRCODE = 'P0001'; END IF;
    IF length(coalesce(p->>'observacao', '')) > 2000 THEN RAISE EXCEPTION 'Observação acima de 2000 caracteres.' USING ERRCODE = '22023'; END IF;
    UPDATE inventario.campanha SET estado = 'fechada', fechado_por = uid, fechado_em = now(), aprovacao_obs = coalesce(p->>'observacao', '')
     WHERE id = c.id RETURNING * INTO c;
    RETURN to_jsonb(c);
  END IF;
  RAISE EXCEPTION 'Operação inválida.' USING ERRCODE = '22023';
END $$;
REVOKE ALL ON FUNCTION inventario.executar(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventario.executar(text, jsonb) TO biotrop_app;
COMMIT;
