// Contrato de /api/terminal/* (server/src/routes/terminal.js da V5 + migration 44: modalidade e retirável).

export type Modulo = 'emprestimo' | 'retirada';

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
  retiravel?: boolean;
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
}

/** Item separado para o empréstimo ou a retirada (a "bandeja"). */
export interface Separado {
  ferramentaId: string;
  unidadeId: string | null;
  identificador: string;
  quantidade: number;
  codigo: string;
  nome: string;
  localizacao?: string;
  /** Categoria da ferramenta (o mesmo ícone do catálogo na revisão). */
  categoria?: string;
  /** Quanto dá para separar desta linha (o disponível na hora de separar; 1 para etiqueta). */
  maximo: number;
}

export interface Sessao {
  colaborador: Colaborador;
  inatividade: number;
  prazoPadraoHoras: number | null;
}
