// Contrato de /api/terminal/* (server/src/routes/terminal.js da V5; migration 49: só empréstimo, CAMM, finalidade,
// prazo do fim do turno, termo e dupla confirmação; migration 50: conta de terceiro e autorização do líder, fotos,
// co-assinatura do almoxarife, recebimento conferido ou com divergência). A retirada (RM) antiga só aparece no histórico.

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
  /** 'terceiro' = conta do terminal de uma empresa terceira (50): pega só com autorização do líder. */
  tipo?: 'interno' | 'terceiro';
  /** Empresa da conta de terceiro (fixa no pedido). */
  empresa?: string;
  centroCusto?: string;
  cargo?: string;
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
  /** Como a entrega foi confirmada (50): no balcão, no tablet (co-assinatura) ou depois, no site. */
  entregaVia?: EntregaVia;
  /** Nome de quem entregou (almoxarife da co-assinatura ou do balcão). */
  entreguePor?: string;
  semAlmoxarife?: boolean;
  recebimentoSituacao?: RecebimentoSituacao;
  divergencias?: Divergencia[];
  /** Conta de terceiro: a pessoa que retirou e a autorização usada. */
  terceiroPessoa?: string;
  autorizacaoId?: string | null;
  autorizacaoNumero?: string;
  divergenciasAbertas?: number;
}

export type EntregaVia = '' | 'painel' | 'tablet' | 'site_posterior';
export type RecebimentoSituacao = '' | 'ok' | 'divergencia';
export type TipoDivergencia = 'danificado' | 'quantidade_divergente' | 'incompleto' | 'outra';

export interface Divergencia {
  id: string;
  itemId?: string | null;
  etapa: 'retirada' | 'devolucao';
  tipo: TipoDivergencia | string;
  descricao: string;
  quantidade?: number | null;
  status: 'aberta' | 'resolvida' | string;
}

/** Divergência ainda não enviada (recebimento, conferência): fotos já salvas como rascunho no servidor. */
export interface DivergenciaNova {
  itemId?: string;
  tipo: TipoDivergencia;
  descricao: string;
  quantidade?: number;
  fotoIds: string[];
}

/** Foto enviada (rascunho no servidor até o registro anexar) e a miniatura para mostrar na tela. */
export interface FotoEnviada {
  fotoId: string;
  miniatura: string;
}
export type EtapaFoto = 'entrega' | 'devolucao' | 'divergencia' | 'conferencia';

/** Foto já anexada a um empréstimo (GET /emprestimos/:id/fotos). miniatura (data URL) só no demo. */
export interface FotoRegistro {
  id: string;
  etapa: EtapaFoto | string;
  v?: string;
  miniatura?: string;
}

/** Matrícula + PIN do almoxarife conferidos no servidor, sem abrir sessão (vale 3 min, uso único). */
export interface Coassinatura {
  coassinaturaId: string;
  nome: string;
  expiraEm: string;
}

export type StatusAutorizacao = 'pendente' | 'aprovada' | 'recusada' | 'cancelada' | 'expirada' | 'utilizada';

export interface ItemAutorizacao {
  ferramentaId: string;
  unidadeId?: string | null;
  codigo: string;
  descricao: string;
  quantidade: number;
}

/** Pedido de autorização da conta de terceiro ao líder (o snapshot dos itens não muda depois de enviado). */
export interface Autorizacao {
  id: string;
  numero: string;
  status: StatusAutorizacao | string;
  terceiroEmpresa?: string;
  terceiroPessoa?: string;
  liderNome?: string;
  itens: ItemAutorizacao[];
  expiraEm?: string | null;
  decididoEm?: string | null;
  decisaoJustificativa?: string | null;
  camm?: string;
  finalidadeRef?: string;
  criadoEm?: string;
  emprestimoId?: string | null;
}

export interface Lider {
  id: string;
  nome: string;
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
