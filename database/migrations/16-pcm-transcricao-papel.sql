-- PCM · Preventivas: transcrição da folha de papel.
--
-- Enquanto o técnico preenche a folha impressa na oficina, o PCM lança no site o que
-- ele marcou. A linha guarda os dois lados:
--   tecnico_nome           quem executou (o técnico da folha de papel);
--   registrado_por(_nome)  quem digitou no site (a sessão logada — nunca vem do navegador).
-- Só admin, gestor e pcm informam um técnico diferente de si mesmo (regra na API).
BEGIN;

ALTER TABLE pcm.preventiva_item
  ADD COLUMN IF NOT EXISTS registrado_por uuid REFERENCES core.usuario(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS registrado_por_nome text NOT NULL DEFAULT '';

COMMENT ON COLUMN pcm.preventiva_item.tecnico_nome IS 'Quem executou a avaliação/troca. Na transcrição de folha de papel, o técnico informado pelo PCM.';
COMMENT ON COLUMN pcm.preventiva_item.registrado_por IS 'Quem gravou a linha no site (sessão). Igual ao técnico quando ele mesmo preenche.';

-- Linhas já gravadas: quem registrou foi o próprio técnico da sessão.
UPDATE pcm.preventiva_item SET registrado_por = tecnico_id, registrado_por_nome = tecnico_nome
 WHERE registrado_por IS NULL AND tecnico_id IS NOT NULL;

COMMIT;
