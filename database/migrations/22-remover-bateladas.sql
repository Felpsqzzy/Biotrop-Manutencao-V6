-- =====================================================================================
-- 22 · Remove o que sobrou do primeiro controle de bateladas (migrations 18–20, apagadas do repositório)
--
-- 05/10/2026: as bateladas voltaram na migration 32 (pcm.batelada_*). Como o migrate.js reaplica TODOS os
-- arquivos a cada atualização, este arquivo NÃO pode mais apagar as tabelas pcm.batelada_*: isso zeraria os
-- apontamentos a cada deploy. Ele remove só as tabelas do primeiro desenho que não voltaram (envase e
-- checklist). Em banco onde nunca existiram, não faz nada. Idempotente.
-- =====================================================================================
BEGIN;

DROP TABLE IF EXISTS pcm.envase_preventiva;
DROP TABLE IF EXISTS pcm.envase_equipamento;
DROP TABLE IF EXISTS pcm.batelada_checklist;

COMMIT;
