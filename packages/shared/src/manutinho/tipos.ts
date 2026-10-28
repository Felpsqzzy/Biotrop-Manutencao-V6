/**
 * Manutinho · tipos dos contratos (GET /api/manutinho/resumo e /relatorio-preventivas, POST /cobrar).
 * O Manutinho não usa IA: as regras deste pacote transformam o que o banco já liberou (RLS + escopo) em avisos.
 */

export type NivelManutinho = 'critico' | 'atencao' | 'info';

/** Fontes do resumo. Cada uma só entra se o perfil passa na mesma checagem da rota de origem. */
export type ModuloManutinho =
  'preventivas' | 'valvulas' | 'bateladas' | 'solicitacoes' | 'aprovacoes' | 'medidores' | 'treinamentos';

export interface ItemManutinho {
  nivel: NivelManutinho;
  modulo: ModuloManutinho;
  titulo: string;
  detalhe: string;
  /** Rota do front onde a pessoa resolve o aviso. */
  rota: string;
}

export interface RespostaResumoManutinho {
  ok: true;
  hoje: string;
  /** Fontes que o perfil pode ver (as outras nem foram consultadas). */
  fontes: ModuloManutinho[];
  itens: ItemManutinho[];
  contagem: Record<NivelManutinho, number>;
}

/* ------------------------------------------------------------------ preventivas */

export type SituacaoManutinho = 'atrasada' | 'em_dia' | 'sem_programacao';

/** Folha aberta (status aberta ou em execução). */
export interface FolhaManutinho {
  id: string;
  ativoId: string;
  numeroOm: string | null;
  dataPrevista: string;
  status: 'aberta' | 'em_execucao';
}

export interface EquipamentoManutinho {
  id: string;
  codigo: string;
  nome: string;
  camm: string;
  local: string;
  ultimaConcluida: string | null;
}

export interface EquipamentoRelatorioManutinho extends EquipamentoManutinho {
  setor: string;
  situacao: SituacaoManutinho;
  folhas: (FolhaManutinho & { atrasoDias: number })[];
  /** Data da folha aberta mais antiga (atrasada) ou da próxima (em dia). */
  proxima: string | null;
  /** Dias de atraso da folha mais antiga (0 se em dia ou sem programação). */
  atrasoDias: number;
}

export interface ContagemManutinho {
  atrasadas: number;
  emDia: number;
  semProgramacao: number;
  total: number;
}

export interface RelatorioPreventivasManutinho {
  hoje: string;
  totais: ContagemManutinho & { folhasAtrasadas: number; folhasEmDia: number };
  equipamentos: EquipamentoRelatorioManutinho[];
  porSetor: (ContagemManutinho & { setor: string })[];
  porCamm: (ContagemManutinho & { camm: string })[];
}

export interface RespostaRelatorioManutinho extends RelatorioPreventivasManutinho {
  ok: true;
}

/* ------------------------------------------------------------------ demais fontes */

/** Válvula na última avaliação (pcm-preventivas: estado = vida, ou 4 se o diafragma foi trocado). */
export interface ValvulaManutinho {
  ativoCodigo: string;
  tag: string;
  estado: number;
}

/** Tanque do painel de bateladas (faixa calculada em bateladas-calculo.js). */
export interface TanqueManutinho {
  codigo: string;
  faixa: 'ok' | 'atencao' | 'alerta' | 'vencido';
  desdePreventiva: number;
  frequencia: number | null;
}

/** SCI/SCM lida de app.sync_registro (só campos em claro). */
export interface SolicitacaoManutinho {
  namespace: 'sci' | 'scm';
  recordId: string;
  status: string;
  atualizadoEm: string;
}

export interface MedidorManutinho {
  id: string;
  nome: string;
  ativo: boolean;
}

export interface LeituraManutinho {
  medidorId: string;
  /** Dia local (YYYY-MM-DD) da leitura. */
  dia: string;
}

/** Curso (lms_courses) com os campos que a regra de prazo usa. */
export interface CursoManutinho {
  id: string;
  titulo: string;
  obrigatorio: boolean;
  publicado: boolean;
  publicadoEm: string | null;
  prazoDias: number | null;
  revisaoVersao: number | null;
  revisaoEm: string | null;
  publicoGrupos: string[];
  publicoPessoas: string[];
}

export interface PessoaManutinho {
  id: string;
  nome: string;
  grupoId: string | null;
}

/** Progresso (lms_progress) de uma pessoa num curso. */
export interface ProgressoManutinho {
  usuarioId: string;
  cursoId: string;
  concluidoEm: string | null;
  inscritoEm: string | null;
  versao: number | null;
  expiraEm: string | null;
}

export interface TreinamentoVencidoManutinho {
  pessoaId: string;
  pessoa: string;
  cursoId: string;
  curso: string;
  /** ISO (data e hora) do prazo que venceu. */
  prazo: string;
  refazer: boolean;
}

/** POST /api/manutinho/cobrar */
export interface PedidoCobrancaManutinho {
  itens: { pessoaId: string; cursos: string[] }[];
}

export interface RespostaCobrancaManutinho {
  ok: true;
  enviados: number;
  resultado: { pessoaId: string; resultado: string }[];
  avisos: string[];
}
