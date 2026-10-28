-- Inventário cego: referência imutável, três contadores distintos e trilha append-only.
-- inventario.executar é redefinida na 36 (listas por CAMM, justificativa e aprovação); a versão abaixo é sobrescrita a cada deploy.
-- Todas as escritas passam pela função abaixo. A role da API não tem DML nas tabelas.
BEGIN;
CREATE SCHEMA IF NOT EXISTS inventario;
CREATE OR REPLACE FUNCTION inventario.gestao() RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT app.usuario_ativo() AND app.tem_perfil(ARRAY['admin','gestor','almoxarife']) $$;
REVOKE ALL ON FUNCTION inventario.gestao() FROM PUBLIC;
GRANT USAGE ON SCHEMA inventario TO biotrop_app, biotrop_ro;
GRANT EXECUTE ON FUNCTION inventario.gestao() TO biotrop_app, biotrop_ro;

CREATE TABLE IF NOT EXISTS inventario.snapshot (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text NOT NULL CHECK(length(btrim(nome)) BETWEEN 1 AND 160),
 data_referencia date NOT NULL, fonte text NOT NULL DEFAULT '' CHECK(length(fonte)<=500),
 estado text NOT NULL DEFAULT 'rascunho' CHECK(estado IN ('rascunho','pronto')),
 criado_por uuid NOT NULL REFERENCES core.usuario(id), criado_em timestamptz NOT NULL DEFAULT now(), finalizado_em timestamptz
);
CREATE TABLE IF NOT EXISTS inventario.snapshot_linha (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_id uuid NOT NULL REFERENCES inventario.snapshot(id),
 codigo text NOT NULL REFERENCES almox.material(codigo), descricao text NOT NULL CHECK(length(descricao) BETWEEN 1 AND 500),
 unidade text NOT NULL DEFAULT '' CHECK(length(unidade)<=20), site text NOT NULL DEFAULT '' CHECK(length(site)<=120),
 deposito text NOT NULL DEFAULT '' CHECK(length(deposito)<=120), localizacao text NOT NULL DEFAULT '' CHECK(length(localizacao)<=120),
 lote text NOT NULL DEFAULT '' CHECK(length(lote)<=120), serie text NOT NULL DEFAULT '' CHECK(length(serie)<=120),
 variante text NOT NULL DEFAULT '' CHECK(length(variante)<=120), status text NOT NULL DEFAULT '' CHECK(length(status)<=120),
 dimensoes_extras jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(dimensoes_extras)='object'),
 saldo numeric(20,6) NOT NULL, preco_unitario numeric(20,6) CHECK(preco_unitario>=0),
 origem_preco jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(origem_preco)='object'), moeda text NOT NULL DEFAULT 'BRL' CHECK(moeda='BRL'),
 UNIQUE(snapshot_id,codigo,site,deposito,localizacao,lote,serie,variante,status,dimensoes_extras)
);
CREATE TABLE IF NOT EXISTS inventario.campanha (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text NOT NULL CHECK(length(btrim(nome)) BETWEEN 1 AND 160),
 snapshot_id uuid NOT NULL REFERENCES inventario.snapshot(id), estado text NOT NULL DEFAULT 'aberta' CHECK(estado IN ('aberta','fechada')),
 criado_por uuid NOT NULL REFERENCES core.usuario(id), criado_em timestamptz NOT NULL DEFAULT now(), fechado_por uuid REFERENCES core.usuario(id), fechado_em timestamptz
);
CREATE TABLE IF NOT EXISTS inventario.item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campanha_id uuid NOT NULL REFERENCES inventario.campanha(id),
 linha_id uuid NOT NULL REFERENCES inventario.snapshot_linha(id),
 codigo text NOT NULL, descricao text NOT NULL, unidade text NOT NULL, site text NOT NULL, deposito text NOT NULL,
 localizacao text NOT NULL, lote text NOT NULL, serie text NOT NULL, variante text NOT NULL, status text NOT NULL, dimensoes_extras jsonb NOT NULL,
 contador1_id uuid NOT NULL REFERENCES core.usuario(id), contador2_id uuid NOT NULL REFERENCES core.usuario(id), contador3_id uuid NOT NULL REFERENCES core.usuario(id),
 etapa smallint NOT NULL DEFAULT 1 CHECK(etapa BETWEEN 1 AND 3), encerrado boolean NOT NULL DEFAULT false, versao integer NOT NULL DEFAULT 1 CHECK(versao>0),
 CHECK(contador1_id<>contador2_id AND contador1_id<>contador3_id AND contador2_id<>contador3_id), UNIQUE(campanha_id,linha_id)
);
CREATE TABLE IF NOT EXISTS inventario.contagem (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES inventario.item(id), etapa smallint NOT NULL CHECK(etapa BETWEEN 1 AND 3),
 quantidade numeric(20,6) NOT NULL CHECK(quantidade>=0), por uuid NOT NULL REFERENCES core.usuario(id), em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(item_id,etapa)
);
CREATE INDEX IF NOT EXISTS inventario_item_campanha ON inventario.item(campanha_id);
CREATE INDEX IF NOT EXISTS inventario_item_contadores ON inventario.item(contador1_id,contador2_id,contador3_id);

ALTER TABLE inventario.snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario.snapshot_linha ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario.campanha ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario.item ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventario.contagem ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS snapshot_gestao ON inventario.snapshot;
CREATE POLICY snapshot_gestao ON inventario.snapshot FOR SELECT USING(inventario.gestao());
DROP POLICY IF EXISTS linha_gestao ON inventario.snapshot_linha;
CREATE POLICY linha_gestao ON inventario.snapshot_linha FOR SELECT USING(inventario.gestao());
DROP POLICY IF EXISTS item_visivel ON inventario.item;
CREATE POLICY item_visivel ON inventario.item FOR SELECT USING(app.usuario_ativo() AND (inventario.gestao() OR app.usuario_atual() IN (contador1_id,contador2_id,contador3_id)));
DROP POLICY IF EXISTS campanha_visivel ON inventario.campanha;
CREATE POLICY campanha_visivel ON inventario.campanha FOR SELECT USING(app.usuario_ativo() AND (inventario.gestao() OR EXISTS(SELECT 1 FROM inventario.item i WHERE i.campanha_id=inventario.campanha.id)));
DROP POLICY IF EXISTS contagem_gestao ON inventario.contagem;
CREATE POLICY contagem_gestao ON inventario.contagem FOR SELECT USING(inventario.gestao());
REVOKE ALL ON ALL TABLES IN SCHEMA inventario FROM PUBLIC, biotrop_app, biotrop_ro;
GRANT SELECT ON inventario.snapshot,inventario.snapshot_linha,inventario.campanha,inventario.item,inventario.contagem TO biotrop_app,biotrop_ro;

-- Imutabilidade mesmo para DML futuro concedido por engano. A função proprietária segue as mesmas travas.
CREATE OR REPLACE FUNCTION inventario.trava() RETURNS trigger LANGUAGE plpgsql SET search_path=inventario,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='contagem' THEN RAISE EXCEPTION 'Contagem não pode ser alterada ou apagada.' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='snapshot_linha' THEN
   IF EXISTS(SELECT 1 FROM inventario.snapshot WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END AND estado='pronto') THEN
     RAISE EXCEPTION 'Snapshot finalizado é imutável.' USING ERRCODE='42501';
   END IF;
 END IF;
 IF TG_TABLE_NAME='snapshot' THEN
   IF TG_OP IN ('UPDATE','DELETE') AND OLD.estado='pronto' THEN RAISE EXCEPTION 'Snapshot finalizado é imutável.' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS contagem_imutavel ON inventario.contagem;
CREATE TRIGGER contagem_imutavel BEFORE UPDATE OR DELETE ON inventario.contagem FOR EACH ROW EXECUTE FUNCTION inventario.trava();
DROP TRIGGER IF EXISTS linha_imutavel ON inventario.snapshot_linha;
CREATE TRIGGER linha_imutavel BEFORE INSERT OR UPDATE OR DELETE ON inventario.snapshot_linha FOR EACH ROW EXECUTE FUNCTION inventario.trava();
DROP TRIGGER IF EXISTS snapshot_imutavel ON inventario.snapshot;
CREATE TRIGGER snapshot_imutavel BEFORE UPDATE OR DELETE ON inventario.snapshot FOR EACH ROW EXECUTE FUNCTION inventario.trava();

CREATE OR REPLACE FUNCTION inventario.usuarios() RETURNS TABLE(id uuid,nome text,perfil_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=inventario,core,app,pg_temp AS $$
BEGIN
 IF NOT inventario.gestao() THEN RAISE EXCEPTION 'Somente gestão.' USING ERRCODE='42501'; END IF;
 -- contador possível = quem entra no site; quem só usa o terminal do almoxarifado (perfil 'terminal', migration 40) fica de fora
 RETURN QUERY SELECT u.id,u.nome,u.perfil_id::text FROM core.usuario u WHERE u.ativo AND NOT u.bloqueado AND u.perfil_id <> 'terminal' ORDER BY u.nome;
END $$;
REVOKE ALL ON FUNCTION inventario.usuarios() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventario.usuarios() TO biotrop_app;

CREATE OR REPLACE FUNCTION inventario.executar(acao text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=inventario,core,almox,app,pg_temp AS $$
DECLARE uid uuid; s inventario.snapshot%ROWTYPE; c inventario.campanha%ROWTYPE; i inventario.item%ROWTYPE;
 l inventario.snapshot_linha%ROWTYPE; v jsonb; n numeric(20,6); alvo uuid; esperado integer; total integer:=0; a uuid; b uuid; d uuid;
BEGIN
 IF NOT app.usuario_ativo() THEN RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE='42501'; END IF;
 uid:=app.usuario_atual();
 IF acao='contar' THEN
   SELECT * INTO i FROM inventario.item WHERE id=(p->>'id')::uuid FOR UPDATE;
   IF NOT FOUND OR uid NOT IN(i.contador1_id,i.contador2_id,i.contador3_id) THEN RAISE EXCEPTION 'Contagem não atribuída.' USING ERRCODE='42501'; END IF;
   SELECT * INTO c FROM inventario.campanha WHERE id=i.campanha_id FOR UPDATE;
   IF c.estado<>'aberta' OR i.encerrado THEN RAISE EXCEPTION 'Contagem já encerrada.' USING ERRCODE='P0001'; END IF;
   alvo:=CASE i.etapa WHEN 1 THEN i.contador1_id WHEN 2 THEN i.contador2_id ELSE i.contador3_id END;
   IF alvo<>uid THEN RAISE EXCEPTION 'Aguarde sua etapa de contagem.' USING ERRCODE='42501'; END IF;
   esperado:=(p->>'expectedVersion')::integer;
   IF esperado IS NULL OR esperado<>i.versao THEN RAISE EXCEPTION 'Versão desatualizada.' USING ERRCODE='P0001'; END IF;
   IF coalesce(p->>'quantidade','') !~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'Quantidade inválida.' USING ERRCODE='22023'; END IF;
   n:=(p->>'quantidade')::numeric;
   SELECT * INTO l FROM inventario.snapshot_linha WHERE id=i.linha_id;
   INSERT INTO inventario.contagem(item_id,etapa,quantidade,por) VALUES(i.id,i.etapa,n,uid);
   UPDATE inventario.item SET encerrado=(n=l.saldo OR i.etapa=3), etapa=CASE WHEN n=l.saldo OR i.etapa=3 THEN i.etapa ELSE i.etapa+1 END,versao=versao+1 WHERE id=i.id RETURNING * INTO i;
   RETURN jsonb_build_object('id',i.id,'etapa',i.etapa,'encerrado',i.encerrado,'versao',i.versao);
 END IF;
 IF NOT inventario.gestao() THEN RAISE EXCEPTION 'Somente almoxarifado e gestão.' USING ERRCODE='42501'; END IF;
 IF acao='snapshot' THEN
   INSERT INTO inventario.snapshot(nome,data_referencia,fonte,criado_por) VALUES(p->>'nome',(p->>'dataReferencia')::date,coalesce(p->>'fonte',''),uid) RETURNING * INTO s;
   RETURN to_jsonb(s);
 ELSIF acao='importar' THEN
   SELECT * INTO s FROM inventario.snapshot WHERE id=(p->>'id')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Snapshot inexistente.' USING ERRCODE='P0002'; END IF;
   IF s.estado<>'rascunho' THEN RAISE EXCEPTION 'Snapshot finalizado é imutável.' USING ERRCODE='42501'; END IF;
   IF jsonb_typeof(p->'linhas') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'linhas') NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Envie entre 1 e 2000 linhas.' USING ERRCODE='22023'; END IF;
   FOR v IN SELECT value FROM jsonb_array_elements(p->'linhas') LOOP
     IF coalesce(v->>'codigo','') !~ '^MAN[A-Z0-9._/-]*$' OR coalesce(v->>'saldo','') !~ '^-?[0-9]{1,14}(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'Código MAN ou saldo inválido.' USING ERRCODE='22023'; END IF;
     IF v->>'precoUnitario' IS NOT NULL AND (v->>'precoUnitario') !~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'Preço inválido.' USING ERRCODE='22023'; END IF;
     IF coalesce(v->>'site','')='' OR coalesce(v->>'deposito','')='' OR coalesce(v->>'localizacao','')='' THEN RAISE EXCEPTION 'Informe site, depósito e localização.' USING ERRCODE='22023'; END IF;
     INSERT INTO inventario.snapshot_linha(snapshot_id,codigo,descricao,unidade,site,deposito,localizacao,lote,serie,variante,status,dimensoes_extras,saldo,preco_unitario,origem_preco)
      VALUES(s.id,v->>'codigo',v->>'descricao',coalesce(v->>'unidade',''),v->>'site',v->>'deposito',v->>'localizacao',coalesce(v->>'lote',''),coalesce(v->>'serie',''),coalesce(v->>'variante',''),coalesce(v->>'status',''),coalesce(v->'dimensoesExtras','{}'),(v->>'saldo')::numeric,(v->>'precoUnitario')::numeric,coalesce(v->'origemPreco','{}'));
     total:=total+1;
   END LOOP;
   RETURN jsonb_build_object('id',s.id,'importadas',total);
 ELSIF acao='finalizar' THEN
   SELECT * INTO s FROM inventario.snapshot WHERE id=(p->>'id')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Snapshot inexistente.' USING ERRCODE='P0002'; END IF;
   IF s.estado<>'rascunho' THEN RAISE EXCEPTION 'Snapshot já finalizado.' USING ERRCODE='P0001'; END IF;
   IF NOT EXISTS(SELECT 1 FROM inventario.snapshot_linha WHERE snapshot_id=s.id) THEN RAISE EXCEPTION 'Importe linhas antes de finalizar.' USING ERRCODE='P0001'; END IF;
   UPDATE inventario.snapshot SET estado='pronto',finalizado_em=now() WHERE id=s.id RETURNING * INTO s; RETURN to_jsonb(s);
 ELSIF acao='campanha' THEN
   SELECT * INTO s FROM inventario.snapshot WHERE id=(p->>'snapshotId')::uuid FOR UPDATE;
   IF NOT FOUND OR s.estado<>'pronto' THEN RAISE EXCEPTION 'Escolha um snapshot finalizado.' USING ERRCODE='P0001'; END IF;
   a:=(p->>'contador1Id')::uuid; b:=(p->>'contador2Id')::uuid; d:=(p->>'contador3Id')::uuid;
   IF a IS NULL OR b IS NULL OR d IS NULL OR a=b OR a=d OR b=d OR (SELECT count(*) FROM core.usuario WHERE id IN(a,b,d) AND ativo AND NOT bloqueado)<>3 THEN RAISE EXCEPTION 'Escolha três contadores ativos e distintos.' USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(p->'linhaIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'linhaIds') NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'Selecione de 1 a 20000 linhas.' USING ERRCODE='22023'; END IF;
   INSERT INTO inventario.campanha(nome,snapshot_id,criado_por) VALUES(p->>'nome',s.id,uid) RETURNING * INTO c;
   FOR v IN SELECT value FROM jsonb_array_elements(p->'linhaIds') LOOP
     SELECT * INTO l FROM inventario.snapshot_linha WHERE id=(v #>> '{}')::uuid AND snapshot_id=s.id;
     IF NOT FOUND THEN RAISE EXCEPTION 'Linha não pertence ao snapshot.' USING ERRCODE='22023'; END IF;
     INSERT INTO inventario.item(campanha_id,linha_id,codigo,descricao,unidade,site,deposito,localizacao,lote,serie,variante,status,dimensoes_extras,contador1_id,contador2_id,contador3_id)
     VALUES(c.id,l.id,l.codigo,l.descricao,l.unidade,l.site,l.deposito,l.localizacao,l.lote,l.serie,l.variante,l.status,l.dimensoes_extras,a,b,d);
   END LOOP; RETURN to_jsonb(c);
 ELSIF acao='fechar' THEN
   SELECT * INTO c FROM inventario.campanha WHERE id=(p->>'id')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Campanha inexistente.' USING ERRCODE='P0002'; END IF;
   IF c.estado<>'aberta' THEN RAISE EXCEPTION 'Campanha já fechada.' USING ERRCODE='P0001'; END IF;
   IF EXISTS(SELECT 1 FROM inventario.item it JOIN inventario.snapshot_linha sl ON sl.id=it.linha_id WHERE it.campanha_id=c.id AND (NOT it.encerrado OR sl.preco_unitario IS NULL OR btrim(sl.unidade)='')) THEN RAISE EXCEPTION 'Complete contagens, custo unitário e unidade antes de fechar.' USING ERRCODE='P0001'; END IF;
   UPDATE inventario.campanha SET estado='fechada',fechado_por=uid,fechado_em=now() WHERE id=c.id RETURNING * INTO c; RETURN to_jsonb(c);
 END IF;
 RAISE EXCEPTION 'Operação inválida.' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION inventario.executar(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventario.executar(text,jsonb) TO biotrop_app;
COMMIT;
