// Contrato de /api/terminal/* (server/src/routes/terminal.js da V5; migration 49: só empréstimo, CAMM, finalidade,
// prazo do fim do turno, termo e dupla confirmação). A retirada (RM) antiga só aparece no histórico.

export type Modulo = 'emprestimo' | 'retirada';

/** OM, CAPEX, TPM, empresa terceira ou outra (as antigas sm, manutencao e consumo só nos já gravados). */
export type Finalidade = 'om' | 'capex' | 'tpm' | 'terceira' | 'outro';

/** Dupla confirmação da entrega (49): aguardando_colaborador = o terminal pede "Confirmar recebimento". */
export type Entrega =
  'nao_exigida' | 'aguardando_colaborador' | 'aguardando_almoxarife' | 'sem_almoxarife' | 'confirmada';

export interface Colaborador {
  nome?: string;
  matricula?: string;
  setor?: string;
}

export interface Saldo {
  disponivel?: number;
  emprestada?: number;
  emConferencia?: number;
  manutencao?: number;
  total?: number;
  baixada?: number;
}

export interface Unidade {
  id: string;
  identificador: string;
}

export interface Ferramenta {
  id: string;
  codigo: string;
  nome: string;
  descricao?: string;
  categoria?: string;
  marca?: string;
  modelo?: string;
  controle: 'individual' | 'quantidade';
  localizacao?: string;
  saldo?: Saldo;
  /** CAMM onde a ferramenta fica ('' = ainda sem CAMM). */
  camm?: string;
  unidadesDisponiveis?: Unidade[];
  foto?: { id: string } | null;
}

export interface ItemEmprestimo {
  id: string;
  tipo?: string;
  codigo: string;
  descricao: string;
  quantidade: number;
  devolvida?: number;
  emConferencia?: number;
  baixa?: number;
  pendente?: number;
  unidadeId?: string | null;
  ferramentaId?: string | null;
}

export type StatusEmprestimo =
  | 'em_andamento'
  | 'parcialmente_devolvido'
  | 'aguardando_conferencia'
  | 'aguardando_baixa'
  | 'devolvido'
  | 'encerrado'
  | 'estornado';

export interface Emprestimo {
  id: string;
  numero: string;
  modalidade?: Modulo;
  status: StatusEmprestimo | string;
  criadoEm: string;
  prazo?: string | null;
  encerradoEm?: string | null;
  atrasado?: boolean;
  pendente?: number;
  emConferencia?: number;
  itensLista?: ItemEmprestimo[];
  camm?: string;
  finalidade?: string;
  finalidadeRef?: string;
  entrega?: Entrega | string;
  entregaEm?: string | null;
  recebimentoEm?: string | null;
}

/** Item separado para o empréstimo (a "bandeja"). */
export interface Separado {
  ferramentaId: string;
  unidadeId: string | null;
  identificador: string;
  quantidade: number;
  codigo: string;
  nome: string;
  localizacao?: string;
  camm?: string;
  /** Categoria da ferramenta (o mesmo ícone do catálogo na revisão). */
  categoria?: string;
  /** Quanto dá para separar desta linha (o disponível na hora de separar; 1 para etiqueta). */
  maximo: number;
}

export interface Sessao {
  colaborador: Colaborador;
  inatividade: number;
}

/** Prazo de um empréstimo feito agora (fim do turno, calculado no servidor) e o texto do termo de responsabilidade. */
export interface Turno {
  prazo: string | null;
  termo: string;
}
