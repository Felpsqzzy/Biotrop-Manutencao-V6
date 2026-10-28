-- Inventário: cada inventário nasce de uma exportação nova do Dynamics (pedido do Felipe, 07/10/2026).
--  • a base (snapshot) serve a um único inventário;
--  • a base precisa ter sido importada nas últimas 24 horas;
--  • se a tela registrou a hora da exportação (resumo.exportadoEm, lida do nome do arquivo do Dynamics ou
--    das propriedades da planilha), ela também precisa ser das últimas 24 horas.
-- Trigger em vez de mexer em inventario.executar: vale para qualquer caminho que crie inventário.
-- Idempotente (CREATE OR REPLACE + DROP TRIGGER IF EXISTS).
BEGIN;
CREATE OR REPLACE FUNCTION inventario.base_do_dia() RETURNS trigger LANGUAGE plpgsql
SET search_path = inventario, pg_temp AS $$
DECLARE s inventario.snapshot%ROWTYPE; exportado timestamptz;
BEGIN
  SELECT * INTO s FROM inventario.snapshot WHERE id = NEW.snapshot_id;
  IF EXISTS (SELECT 1 FROM inventario.campanha c WHERE c.snapshot_id = NEW.snapshot_id) THEN
    RAISE EXCEPTION 'Esta lista do Dynamics já foi usada em outro inventário. Exporte a lista de novo e importe.' USING ERRCODE = 'P0001';
  END IF;
  IF s.criado_em < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'A lista foi importada há mais de 24 horas. Exporte a lista de novo no Dynamics e importe.' USING ERRCODE = 'P0001';
  END IF;
  IF s.resumo ? 'exportadoEm' THEN
    BEGIN exportado := (s.resumo->>'exportadoEm')::timestamptz;
    EXCEPTION WHEN others THEN exportado := NULL; END;
    IF exportado IS NULL OR exportado < now() - interval '24 hours' THEN
      RAISE EXCEPTION 'A exportação do Dynamics é antiga. Exporte a lista de novo e importe.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS campanha_base_do_dia ON inventario.campanha;
CREATE TRIGGER campanha_base_do_dia BEFORE INSERT ON inventario.campanha FOR EACH ROW EXECUTE FUNCTION inventario.base_do_dia();
COMMIT;
