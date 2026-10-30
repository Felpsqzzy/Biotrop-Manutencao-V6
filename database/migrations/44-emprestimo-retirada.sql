-- Empréstimo (EM) × retirada (RM) e os campos da planilha de ferramentas (decisões do Felipe, 21/10/2026).
--   · EM: a ferramenta vai e volta (o fluxo da 40). RM: sai do estoque e não volta; só de ferramenta marcada
--     "retirável" no cadastro. A retirada nasce 'aguardando_baixa' (saldo: disponível → emprestada) até o almoxarife
--     confirmar (emprestada → baixada, status 'encerrado', nº da baixa do Dynamics opcional) ou recusar (volta ao
--     disponível, status 'estornado', com justificativa).
--   · Retirada não tem prazo (prazo nulo): não fica "atrasada" nem entra nos avisos por e-mail (a 42 só olha os status
--     do empréstimo: em_andamento, parcialmente_devolvido, aguardando_conferencia). Devolução, conferência, baixa por
--     extravio, novo prazo e estorno recusam retirada: ela se resolve só por confirmar ou recusar.
--   · Ferramenta: retiravel, codigo_compra e patrimonio (colunas da planilha de ferramentas; códigos FMNT próprios, fora
--     do catálogo MAN/Dynamics). Importação em lote pelo painel (ação 'ferramentas_importar').
-- As regras ficam em emprestimo.executar() (migration 40: ações emprestar, ferramenta_salvar, retirada_confirmar,
-- retirada_recusar e ferramentas_importar), que usa as colunas criadas aqui; a função só lê as colunas ao rodar, então a
-- ordem 40 → 44 do migrate.js vale também num banco novo.
-- Idempotente: o migrate.js reaplica esta migration a cada deploy; as CHECKs são refeitas (DROP IF EXISTS + ADD) e
-- nada da 40 é apagado.
BEGIN;

/* ---------------------------------------------------------------- modalidade do registro */
ALTER TABLE emprestimo.emprestimo ADD COLUMN IF NOT EXISTS modalidade text NOT NULL DEFAULT 'emprestimo';
ALTER TABLE emprestimo.emprestimo DROP CONSTRAINT IF EXISTS emprestimo_modalidade_check;
ALTER TABLE emprestimo.emprestimo ADD CONSTRAINT emprestimo_modalidade_check CHECK (modalidade IN ('emprestimo','retirada'));
-- status novo 'aguardando_baixa', só da retirada (a lista da 40 é refeita aqui com ele)
ALTER TABLE emprestimo.emprestimo DROP CONSTRAINT IF EXISTS emprestimo_status_check;
ALTER TABLE emprestimo.emprestimo ADD CONSTRAINT emprestimo_status_check
  CHECK (status IN ('em_andamento','parcialmente_devolvido','aguardando_conferencia','devolvido','encerrado','estornado','aguardando_baixa'));
ALTER TABLE emprestimo.emprestimo DROP CONSTRAINT IF EXISTS emprestimo_retirada_status_check;
ALTER TABLE emprestimo.emprestimo ADD CONSTRAINT emprestimo_retirada_status_check
  CHECK (CASE modalidade WHEN 'retirada' THEN status IN ('aguardando_baixa','encerrado','estornado') ELSE status <> 'aguardando_baixa' END);
-- empréstimo sempre com prazo; retirada sem prazo de devolução
ALTER TABLE emprestimo.emprestimo ALTER COLUMN prazo DROP NOT NULL;
ALTER TABLE emprestimo.emprestimo DROP CONSTRAINT IF EXISTS emprestimo_prazo_modalidade_check;
ALTER TABLE emprestimo.emprestimo ADD CONSTRAINT emprestimo_prazo_modalidade_check CHECK ((modalidade = 'emprestimo') = (prazo IS NOT NULL));
-- fila "Retiradas aguardando baixa" do painel
CREATE INDEX IF NOT EXISTS emprestimo_retirada_pendente_idx ON emprestimo.emprestimo (criado_em) WHERE status = 'aguardando_baixa';

/* ---------------------------------------------------------------- campos da planilha no cadastro da ferramenta */
ALTER TABLE emprestimo.ferramenta ADD COLUMN IF NOT EXISTS retiravel boolean NOT NULL DEFAULT false;
ALTER TABLE emprestimo.ferramenta ADD COLUMN IF NOT EXISTS codigo_compra text NOT NULL DEFAULT '';
ALTER TABLE emprestimo.ferramenta ADD COLUMN IF NOT EXISTS patrimonio text NOT NULL DEFAULT '';
ALTER TABLE emprestimo.ferramenta DROP CONSTRAINT IF EXISTS ferramenta_codigo_compra_check;
ALTER TABLE emprestimo.ferramenta ADD CONSTRAINT ferramenta_codigo_compra_check CHECK (length(codigo_compra) <= 60);
ALTER TABLE emprestimo.ferramenta DROP CONSTRAINT IF EXISTS ferramenta_patrimonio_check;
ALTER TABLE emprestimo.ferramenta ADD CONSTRAINT ferramenta_patrimonio_check CHECK (length(patrimonio) <= 80);

-- RLS e permissões: as tabelas já têm as policies de leitura da 40 e a role da API só tem SELECT nelas (o GRANT de
-- tabela cobre as colunas novas). Escrita continua só por emprestimo.executar(); nenhuma policy nova é necessária.
COMMIT;
