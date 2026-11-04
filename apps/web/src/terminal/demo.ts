/**
 * Demonstração do terminal (só no build `--mode demo`, via import() em ./api.ts; também usada nos testes): responde
 * /api/terminal/* em memória, com o contrato da rota real (mesmos campos, status e mensagens principais).
 * Tudo FICTÍCIO: pessoas com [DEMO], PINs e código do autenticador de demonstração, ferramentas com código D.
 * Cobre (migration 49: só empréstimo): ferramentas por quantidade, por unidade (patrimônio/série), peças iguais (FMNT),
 * mais de 100 ferramentas (lista virtualizada), a CAMM de cada uma (?camm= filtra), finalidade, termo, prazo do fim do
 * turno (/prazo), dupla confirmação (um empréstimo do balcão esperando o "recebi"; /recebimento), "sem almoxarife no
 * turno", empréstimos abertos e atrasados e uma retirada (RM) antiga, só no histórico.
 * Migration 50: conta de terceiro (empresa fictícia) com autorização do líder (/lideres, /autorizacoes; decidir() e
 * expirar() fazem o papel do site nos testes), fotos (/fotos, rascunho até anexar), co-assinatura do almoxarife
 * (/coassinatura, 3 min, uso único, nunca o tomador), recebimento conferido ou com divergência (bloqueia o "recebi"
 * até resolverDivergencias()), devolução com fotos e conferência no ato.
 * O estado vive só nesta página (recarregar volta ao começo).
 */
import { problemaPin } from './regras';
import type {
  Autorizacao,
  Divergencia,
  Emprestimo,
  Entrega,
  EntregaVia,
  Ferramenta,
  ItemEmprestimo,
  Modulo,
  RecebimentoSituacao,
} from './tipos';

interface Pessoa {
  id: string;
  nome: string;
  matricula: string;
  setor: string;
  perfil: 'tecnico' | 'almoxarife' | 'admin' | 'lider' | 'gestor' | 'terceiro';
  pin: string | null;
  convite?: string;
  codigo2fa?: string;
  empresa?: string;
}
interface AutDemo extends Autorizacao {
  solicitanteId: string;
  liderId: string;
  chave: string;
}
interface FotoDemo {
  id: string;
  dono: string;
  etapa: string;
  miniatura: string;
  emprestimoId: string | null;
}
interface CoassDemo {
  id: string;
  nome: string;
  tomadorId: string;
  finalidade: string;
  expira: number;
  usada: boolean;
}
interface FerrDemo extends Omit<Ferramenta, 'saldo' | 'unidadesDisponiveis'> {
  total: number;
  emprestada: number;
  emConferencia: number;
  manutencao: number;
  baixada: number;
}
interface UnidadeDemo {
  id: string;
  ferramentaId: string;
  identificador: string;
  estado: 'disponivel' | 'emprestada' | 'em_conferencia';
}
interface EmpDemo extends Emprestimo {
  colaboradorId: string;
  chave: string;
  itensLista: ItemEmprestimo[];
  devolucoes: string[];
  /** Nasceu com a dupla confirmação (49); os anteriores ficam false. */
  duplaConfirmacao: boolean;
  semAlmoxarife: boolean;
  entregaVia?: EntregaVia;
  entreguePor?: string;
  recebimentoSituacao?: RecebimentoSituacao;
  divergencias: Divergencia[];
  conferencias: string[];
}

export interface CredencialDemo {
  matricula: string;
  pin: string | null;
  nome: string;
  papel: string;
  convite?: string;
  codigo2fa?: string;
}

const H = 3600e3;
const DIA = 24 * H;
const PRAZO_HORAS = 168;
const INATIVIDADE = 120;
const CHAVE_OP = /^[A-Za-z0-9_-]{8,80}$/;
const CAMMS = ['CAMM 1', 'CAMM 2', 'CAMM 3', 'C. LOG'];
const TERMO =
  'Declaro que recebi as ferramentas em boas condições e me responsabilizo por devolvê-las no prazo; avarias serão apuradas.';
const FINALIDADES = ['om', 'capex', 'tpm', 'terceira', 'outro'];

/** emprestimo.prazo_turno (migration 49), hora de Brasília: 07:00–17:59 → 18:00 do dia; 18:00–23:59 → 07:00 do dia
 *  seguinte; 00:00–06:59 (turno da noite) → 07:00 do mesmo dia. */
export function prazoTurno(t: number): number {
  const l = new Date(t - 3 * H);
  const [y, m, d] = [l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()];
  const hr = l.getUTCHours();
  return hr < 7 ? Date.UTC(y, m, d, 10) : hr < 18 ? Date.UTC(y, m, d, 21) : Date.UTC(y, m, d + 1, 10);
}
/** entregaDe() da rota: o que falta na dupla confirmação. */
function entregaDe(e: EmpDemo): Entrega {
  if (!e.duplaConfirmacao || e.modalidade === 'retirada' || e.status === 'estornado') return 'nao_exigida';
  if (e.entregaEm && e.recebimentoEm) return 'confirmada';
  if (!e.recebimentoEm) return 'aguardando_colaborador';
  return e.semAlmoxarife ? 'sem_almoxarife' : 'aguardando_almoxarife';
}
const semAcento = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function estadoInicial(agora: number) {
  let seq = 0;
  const id = (p: string) => `${p}-${(++seq).toString(36).padStart(4, '0')}`;
  const pessoas: Pessoa[] = [
    {
      id: 'p1',
      nome: '[DEMO] Ana Ribeiro',
      matricula: '10421',
      setor: 'Manutenção mecânica',
      perfil: 'tecnico',
      pin: '480256',
    },
    {
      id: 'p2',
      nome: '[DEMO] Diego Martins',
      matricula: '10433',
      setor: 'Manutenção elétrica',
      perfil: 'tecnico',
      pin: '613947',
    },
    {
      id: 'p3',
      nome: '[DEMO] Caio Nunes',
      matricula: '10477',
      setor: 'Utilidades',
      perfil: 'tecnico',
      pin: null,
      convite: 'DEMO-CAIO',
    },
    {
      id: 'p4',
      nome: '[DEMO] Bruno Teles',
      matricula: '30205',
      setor: 'Almoxarifado',
      perfil: 'almoxarife',
      pin: '519274',
      codigo2fa: '246802',
    },
    {
      id: 'p5',
      nome: '[DEMO] Helena Prado',
      matricula: '90001',
      setor: 'Administração',
      perfil: 'admin',
      pin: '847362',
      codigo2fa: '135790',
    },
    {
      id: 'p6',
      nome: '[DEMO] Montagens Fictícias Ltda',
      matricula: 'T9001',
      setor: 'Empresa terceira',
      perfil: 'terceiro',
      pin: '362918',
      empresa: '[DEMO] Montagens Fictícias Ltda',
    },
    { id: 'p7', nome: '[DEMO] Lúcia Campos', matricula: '20110', setor: 'Liderança', perfil: 'lider', pin: '705318' },
    { id: 'p8', nome: '[DEMO] Rafael Gomes', matricula: '20120', setor: 'Gestão', perfil: 'gestor', pin: '904127' },
  ];
  const ferramentas: FerrDemo[] = [];
  const unidades: UnidadeDemo[] = [];
  const nova = (
    codigo: string,
    nome: string,
    categoria: string,
    localizacao: string,
    qtd: number | string[],
    extra: Partial<FerrDemo> = {},
  ) => {
    const individual = Array.isArray(qtd);
    const f: FerrDemo = {
      id: id('f'),
      codigo,
      nome,
      categoria,
      localizacao,
      descricao: '[DEMO] Ferramenta fictícia.',
      controle: individual ? 'individual' : 'quantidade',
      total: individual ? qtd.length : qtd,
      emprestada: 0,
      emConferencia: 0,
      manutencao: 0,
      baixada: 0,
      camm: CAMMS[ferramentas.length % CAMMS.length] ?? '',
      foto: null,
      ...extra,
    };
    ferramentas.push(f);
    if (individual)
      for (const ident of qtd)
        unidades.push({ id: id('u'), ferramentaId: f.id, identificador: ident, estado: 'disponivel' });
    return f;
  };
  nova('FER-D001', 'Furadeira de impacto 650 W', 'Elétrica', 'Armário A, prateleira 2', [
    'PAT-D1001',
    'PAT-D1002',
    'PAT-D1003',
  ]);
  nova('FER-D002', 'Esmerilhadeira angular 4 1/2"', 'Elétrica', 'Armário A, prateleira 3', ['PAT-D1011', 'PAT-D1012']);
  nova('FER-D003', 'Parafusadeira a bateria 12 V', 'Elétrica', 'Armário A, prateleira 1', [
    'PAT-D1021',
    'PAT-D1022',
    'PAT-D1023',
  ]);
  nova('FER-D004', 'Multímetro digital CAT III', 'Medição', 'Armário C, gaveta 1', ['SN-D-MD01', 'SN-D-MD02']);
  nova('FER-D005', 'Alicate amperímetro', 'Medição', 'Armário C, gaveta 2', ['SN-D-AA01']);
  nova('FER-D006', 'Torquímetro de estalo 1/2"', 'Manual', 'Armário B, gaveta 4', ['SN-D-TQ01']);
  nova('FER-D007', 'Jogo de chaves combinadas 6-22 mm', 'Manual', 'Armário B, prateleira 1', 6);
  nova('FER-D008', 'Chave de fenda 1/4" x 6"', 'Manual', 'Armário B, prateleira 2', 12);
  nova('FER-D009', 'Alicate universal 8"', 'Manual', 'Armário B, prateleira 2', 10);
  nova('FER-D010', 'Martelo de borracha 500 g', 'Manual', 'Armário B, prateleira 3', 4);
  nova('FER-D011', 'Trena 5 m', 'Medição', 'Armário C, gaveta 3', 8);
  nova('FER-D012', 'Lanterna LED recarregável', 'Iluminação', 'Armário D, prateleira 1', 5);
  nova('FER-D013', 'Escada de alumínio 7 degraus', 'Acesso e segurança', 'Corredor do almoxarifado', 2);
  nova('FER-D014', 'Serra tico-tico', 'Elétrica', 'Armário A, prateleira 4', 1, { manutencao: 1 });
  nova('FER-D015', 'Paquímetro digital 150 mm', 'Medição', 'Armário C, gaveta 4', 2, { camm: '' });
  // peças iguais (códigos FMNT, uma peça por código): aparecem num grupo só e a pessoa escolhe a etiqueta
  for (let i = 1; i <= 6; i++)
    nova(`FMNT-D20${i}`, 'Jogo de chaves Allen 1,5-10 mm', 'Manual', 'Armário E', 1, {
      camm: i <= 3 ? 'CAMM 1' : 'CAMM 2',
    });
  // jogos e medidas (mais de 100 ferramentas no catálogo, para a lista virtualizada)
  const familias: [string, string, (i: number) => string][] = [
    ['CC', 'Chave combinada', (i) => `${6 + i} mm`],
    ['SQ', 'Soquete 1/2"', (i) => `${8 + i} mm`],
    ['CA', 'Chave Allen', (i) => `${(1.5 + i * 0.5).toFixed(1).replace('.', ',')} mm`],
    ['CF', 'Chave de fenda', (i) => `${(i % 4) + 1}/8" x ${3 + Math.floor(i / 4)}"`],
    ['CH', 'Chave Philips', (i) => `PH${i % 4} x ${3 + Math.floor(i / 4)}"`],
  ];
  familias.forEach(([sigla, nome, medida], k) => {
    for (let i = 0; i < 22; i++)
      nova(
        `FER-D${sigla}${String(i + 1).padStart(2, '0')}`,
        `${nome} ${medida(i)}`,
        'Manual',
        `Armário H, gaveta ${k + 1}`,
        1 + ((i * 7) % 4),
      );
  });

  const emprestimos: EmpDemo[] = [];
  const porCodigo = (c: string) => ferramentas.find((f) => f.codigo === c)!;
  const registrar = (
    pessoa: string,
    modalidade: Modulo,
    criado: number,
    itens: [string, number, string?][],
    fim?: { status: string; quando: number; devolvida?: boolean },
    extra: Partial<EmpDemo> = {},
  ) => {
    const e: EmpDemo = {
      id: id('e'),
      numero: `EMP-D${String(emprestimos.length + 1).padStart(5, '0')}`,
      modalidade,
      status: modalidade === 'retirada' ? 'aguardando_baixa' : 'em_andamento',
      criadoEm: new Date(criado).toISOString(),
      prazo: modalidade === 'retirada' ? null : new Date(criado + PRAZO_HORAS * H).toISOString(),
      encerradoEm: null,
      colaboradorId: pessoa,
      chave: `demo-${seq}-inicial`,
      itensLista: [],
      devolucoes: [],
      divergencias: [],
      conferencias: [],
      // do terminal, com a dupla confirmação: recebido na hora e entregue (confirmado pelo almoxarife)
      duplaConfirmacao: modalidade === 'emprestimo',
      semAlmoxarife: false,
      finalidade: 'om',
      finalidadeRef: '40125',
      camm: 'CAMM 1',
      entregaEm: new Date(criado).toISOString(),
      recebimentoEm: new Date(criado).toISOString(),
      ...extra,
    };
    for (const [codigo, q, ident] of itens) {
      const f = porCodigo(codigo);
      const u = ident ? unidades.find((x) => x.identificador === ident) : undefined;
      // encerrado antes do começo da demo (devolvido ou baixado): o saldo de hoje já não conta com ele
      if (!fim) {
        f.emprestada += q;
        if (u) u.estado = 'emprestada';
      }
      e.itensLista.push({
        id: id('i'),
        tipo: 'ferramenta',
        codigo: f.codigo,
        descricao: ident ? `${f.nome} (${ident})` : f.nome,
        quantidade: q,
        devolvida: fim?.devolvida ? q : 0,
        emConferencia: 0,
        baixa: fim && modalidade === 'retirada' ? q : 0,
        pendente: fim ? 0 : q,
        unidadeId: u?.id ?? null,
        ferramentaId: f.id,
      });
    }
    if (fim) {
      e.status = fim.status;
      e.encerradoEm = new Date(fim.quando).toISOString();
    }
    emprestimos.push(e);
    return e;
  };
  registrar('p1', 'emprestimo', agora - 1 * DIA, [
    ['FER-D001', 1, 'PAT-D1001'],
    ['FER-D008', 2],
  ]);
  // anterior à dupla confirmação (e atrasado)
  registrar('p1', 'emprestimo', agora - 9 * DIA, [['FER-D004', 1, 'SN-D-MD01']], undefined, {
    duplaConfirmacao: false,
    finalidade: 'manutencao',
    finalidadeRef: '',
    camm: '',
  });
  // registrado no balcão: o almoxarife entregou e falta o "recebi" do colaborador (com o termo)
  registrar('p1', 'emprestimo', agora - 2 * H, [['FER-D009', 1]], undefined, {
    finalidade: 'capex',
    finalidadeRef: '',
    camm: 'CAMM 2',
    recebimentoEm: null,
    entregaVia: 'painel',
    entreguePor: '[DEMO] Bruno Teles',
  });
  // retirada (RM) antiga: só no histórico
  registrar('p1', 'retirada', agora - 5 * DIA, [['FER-D010', 1]], { status: 'encerrado', quando: agora - 4 * DIA });
  registrar('p1', 'emprestimo', agora - 12 * DIA, [['FER-D011', 1]], {
    status: 'devolvido',
    quando: agora - 11 * DIA,
    devolvida: true,
  });
  registrar('p2', 'emprestimo', agora - 2 * DIA, [['FER-D012', 1]]);
  // conta de terceiro: uma autorização aprovada (retirar agora) e uma recusada, com o líder fictício
  const trena = porCodigo('FER-D011');
  const autorizacoes: AutDemo[] = [
    {
      id: id('a'),
      numero: 'AUT-D00001',
      status: 'aprovada',
      solicitanteId: 'p6',
      liderId: 'p7',
      chave: 'demo-aut-1',
      terceiroEmpresa: '[DEMO] Montagens Fictícias Ltda',
      terceiroPessoa: '[DEMO] Marcos Lima',
      liderNome: '[DEMO] Lúcia Campos',
      camm: 'CAMM 3',
      finalidadeRef: '',
      itens: [{ ferramentaId: trena.id, unidadeId: null, codigo: trena.codigo, descricao: trena.nome, quantidade: 1 }],
      expiraEm: new Date(prazoTurno(agora)).toISOString(),
      decididoEm: new Date(agora - H / 2).toISOString(),
      decisaoJustificativa: null,
    },
    {
      id: id('a'),
      numero: 'AUT-D00002',
      status: 'recusada',
      solicitanteId: 'p6',
      liderId: 'p7',
      chave: 'demo-aut-2',
      terceiroEmpresa: '[DEMO] Montagens Fictícias Ltda',
      terceiroPessoa: '[DEMO] Paula Souza',
      liderNome: '[DEMO] Lúcia Campos',
      camm: 'CAMM 1',
      finalidadeRef: '',
      itens: [{ ferramentaId: trena.id, unidadeId: null, codigo: trena.codigo, descricao: trena.nome, quantidade: 2 }],
      expiraEm: new Date(prazoTurno(agora)).toISOString(),
      decididoEm: new Date(agora - H).toISOString(),
      decisaoJustificativa: 'Serviço não programado para hoje.',
    },
  ];
  const fotos: FotoDemo[] = [];
  const coassinaturas: CoassDemo[] = [];
  return { pessoas, ferramentas, unidades, emprestimos, autorizacoes, fotos, coassinaturas, seq: () => id('x') };
}

/** Miniatura fictícia (1 px) das fotos já anexadas no demo. */
const MINI_DEMO = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const TIPOS_DIV = ['danificado', 'quantidade_divergente', 'incompleto', 'outra'];

const ok = (status: number, json: Record<string, unknown> = {}) => ({ status, json: { ok: true, ...json } });
const falha = (status: number, erro: string) => ({ status, json: { ok: false, erro } });

/** Limite do catálogo do tablet (o da rota: MAX_CATALOGO em server/src/routes/terminal.js). */
export const MAX_CATALOGO = 1000;

export function criarDemo(opc: { atraso?: number; agora?: () => number; maxCatalogo?: number } = {}) {
  const maxCatalogo = opc.maxCatalogo ?? MAX_CATALOGO;
  const relogio = opc.agora ?? (() => Date.now());
  let s = estadoInicial(relogio());
  let sessao: string | null = null;

  const pessoa = (m: unknown) =>
    s.pessoas.find(
      (p) =>
        p.matricula.toUpperCase() ===
        String(m ?? '')
          .trim()
          .toUpperCase(),
    );
  const colaborador = (p: Pessoa) => ({
    nome: p.nome,
    matricula: p.matricula,
    setor: p.setor,
    tipo: p.perfil === 'terceiro' ? 'terceiro' : 'interno',
    ...(p.empresa ? { empresa: p.empresa } : {}),
  });
  const abrir = (p: Pessoa) => {
    sessao = p.id;
    return ok(200, { colaborador: colaborador(p), inatividadeSegundos: INATIVIDADE, prazoPadraoHoras: PRAZO_HORAS });
  };
  const linhaFerr = (f: FerrDemo): Ferramenta => {
    const disponivel = Math.max(0, f.total - f.emprestada - f.emConferencia - f.manutencao - f.baixada);
    const o: Ferramenta = {
      id: f.id,
      codigo: f.codigo,
      nome: f.nome,
      descricao: f.descricao,
      categoria: f.categoria,
      controle: f.controle,
      localizacao: f.localizacao,
      camm: f.camm,
      foto: null,
      saldo: {
        disponivel,
        emprestada: f.emprestada,
        emConferencia: f.emConferencia,
        manutencao: f.manutencao,
        total: f.total,
        baixada: f.baixada,
      },
    };
    if (f.controle === 'individual')
      o.unidadesDisponiveis = s.unidades
        .filter((u) => u.ferramentaId === f.id && u.estado === 'disponivel')
        .map((u) => ({ id: u.id, identificador: u.identificador }));
    return o;
  };
  const recalcular = (e: EmpDemo, agora: number) => {
    if (e.modalidade === 'retirada') return;
    const pend = e.itensLista.reduce((n, i) => n + Number(i.pendente), 0);
    const conf = e.itensLista.reduce((n, i) => n + Number(i.emConferencia), 0);
    e.pendente = pend;
    e.emConferencia = conf;
    if (pend === 0 && conf === 0) {
      e.status = 'devolvido';
      e.encerradoEm = new Date(agora).toISOString();
    } else if (pend === 0) e.status = 'aguardando_conferencia';
    else if (e.itensLista.some((i) => Number(i.devolvida) + Number(i.emConferencia) > 0))
      e.status = 'parcialmente_devolvido';
  };
  const linhaEmp = (e: EmpDemo, agora: number): Emprestimo => {
    recalcular(e, agora);
    const aberto = ['em_andamento', 'parcialmente_devolvido', 'aguardando_conferencia', 'aguardando_baixa'].includes(
      e.status,
    );
    return {
      id: e.id,
      numero: e.numero,
      modalidade: e.modalidade,
      status: e.status,
      criadoEm: e.criadoEm,
      prazo: e.prazo,
      encerradoEm: e.encerradoEm,
      atrasado:
        e.modalidade !== 'retirada' && aberto && !!e.prazo && Date.parse(e.prazo) < agora && Number(e.pendente) > 0,
      pendente: e.itensLista.reduce((n, i) => n + Number(i.pendente), 0),
      emConferencia: e.itensLista.reduce((n, i) => n + Number(i.emConferencia), 0),
      itensLista: e.itensLista.map((i) => ({ ...i })),
      camm: e.camm,
      finalidade: e.finalidade,
      finalidadeRef: e.finalidadeRef,
      entrega: entregaDe(e),
      entregaEm: e.entregaEm,
      recebimentoEm: e.recebimentoEm,
      entregaVia: e.entregaVia ?? '',
      entreguePor: e.entreguePor ?? '',
      semAlmoxarife: e.semAlmoxarife,
      recebimentoSituacao: e.recebimentoSituacao ?? (e.recebimentoEm ? 'ok' : ''),
      divergencias: e.divergencias.map((d) => ({ ...d })),
      terceiroPessoa: e.terceiroPessoa,
      autorizacaoId: e.autorizacaoId ?? null,
      autorizacaoNumero: e.autorizacaoNumero,
      divergenciasAbertas: e.divergencias.filter((d) => d.status === 'aberta').length,
    };
  };
  /** Autorização vista pela conta: pendente/aprovada vencida vira expirada (como a expiração preguiçosa do banco). */
  const expirarVencidas = (agora: number) => {
    for (const a of s.autorizacoes)
      if ((a.status === 'pendente' || a.status === 'aprovada') && Date.parse(String(a.expiraEm)) <= agora)
        a.status = 'expirada';
  };
  const linhaAut = (a: AutDemo): Autorizacao => ({
    id: a.id,
    numero: a.numero,
    status: a.status,
    terceiroEmpresa: a.terceiroEmpresa,
    terceiroPessoa: a.terceiroPessoa,
    liderNome: a.liderNome,
    itens: a.itens.map((i) => ({ ...i })),
    expiraEm: a.expiraEm,
    decididoEm: a.decididoEm,
    decisaoJustificativa: a.decisaoJustificativa,
    criadoEm: a.criadoEm,
    emprestimoId: a.emprestimoId ?? null,
    camm: a.camm,
    finalidadeRef: a.finalidadeRef,
  });
  /** Rascunhos de foto do próprio colaborador, da etapa, ainda não anexados: os ids ou o erro. */
  const fotosRascunho = (dono: string, ids: unknown, etapas: string[], min: number, max: number) => {
    const l = Array.isArray(ids) ? ids.map(String) : [];
    if (l.length < min || l.length > max || new Set(l).size !== l.length) return null;
    const achadas = l.map((fid) =>
      s.fotos.find((f) => f.id === fid && f.dono === dono && etapas.includes(f.etapa) && !f.emprestimoId),
    );
    return achadas.every(Boolean) ? (achadas as FotoDemo[]) : null;
  };
  /** Divergências do corpo (tipo, descrição 5..1000, 1 a 3 fotos): a lista pronta ou a mensagem de erro. */
  const lerDivergencias = (
    dono: string,
    v: unknown,
    etapa: Divergencia['etapa'],
  ): { erro: string } | { lista: { d: Divergencia; fotos: FotoDemo[] }[] } => {
    const l = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    if (!l.length) return { erro: 'Registre pelo menos uma divergência.' };
    const out: { d: Divergencia; fotos: FotoDemo[] }[] = [];
    for (const x of l) {
      if (!TIPOS_DIV.includes(String(x.tipo))) return { erro: 'Tipo de divergência inválido.' };
      const descricao = String(x.descricao ?? '').trim();
      if (descricao.length < 5 || descricao.length > 1000)
        return { erro: 'Descreva a divergência (pelo menos 5 caracteres).' };
      if (x.quantidade != null && !(Number.isInteger(Number(x.quantidade)) && Number(x.quantidade) > 0))
        return { erro: 'Informe quantas peças têm problema ou faltam.' };
      const f = fotosRascunho(dono, x.fotoIds, ['divergencia', 'conferencia'], 1, 3);
      if (!f) return { erro: 'Cada divergência precisa de 1 a 3 fotos.' };
      out.push({
        d: {
          id: s.seq(),
          itemId: x.itemId ? String(x.itemId) : null,
          etapa,
          tipo: String(x.tipo),
          descricao,
          quantidade: x.quantidade == null ? null : Number(x.quantidade),
          status: 'aberta',
        },
        fotos: f,
      });
    }
    return { lista: out };
  };
  const anexar = (fs: FotoDemo[], e: EmpDemo) => {
    for (const f of fs) f.emprestimoId = e.id;
  };

  function rota(metodo: string, url: string, b: Record<string, unknown>) {
    const agora = relogio();
    const u = new URL(url, 'http://demo.invalid');
    const caminho = u.pathname.replace(/^\/api\/terminal\/?/, '');
    const partes = caminho.split('/').filter(Boolean);
    if (metodo === 'POST' && caminho === 'entrar') {
      const p = pessoa(b.matricula);
      if (!p || !p.pin || String(b.senha ?? '') !== p.pin) return falha(401, 'Matrícula ou PIN incorretos.');
      return abrir(p);
    }
    if (metodo === 'POST' && caminho === 'primeiro-acesso') {
      const fraca = problemaPin(String(b.senha ?? ''), String(b.matricula ?? ''));
      if (fraca) return falha(400, fraca);
      const p = pessoa(b.matricula);
      const codigo = String(b.codigo ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      if (!p || !p.convite || p.convite.replace(/[^A-Z0-9]/g, '') !== codigo)
        return falha(400, 'Código inválido, já usado ou vencido. Peça um novo ao almoxarifado.');
      p.pin = String(b.senha);
      p.convite = undefined;
      return abrir(p);
    }
    if (metodo === 'POST' && caminho === 'sair') {
      sessao = null;
      return ok(200);
    }
    if (metodo === 'POST' && caminho === 'saida-admin') {
      const p = pessoa(b.matricula);
      sessao = null;
      if (
        !p ||
        p.perfil === 'tecnico' ||
        !p.pin ||
        p.pin !== String(b.senha ?? '') ||
        p.codigo2fa !== String(b.codigo ?? '')
      )
        return falha(401, 'Não foi possível liberar a saída. Confira os dados.');
      return ok(200, { liberado: true });
    }

    const eu = s.pessoas.find((p) => p.id === sessao);
    if (!eu) return falha(401, 'Sessão do terminal encerrada.');
    if (metodo === 'GET' && caminho === 'eu')
      return ok(200, {
        colaborador: colaborador(eu),
        inatividadeSegundos: INATIVIDADE,
        prazoPadraoHoras: PRAZO_HORAS,
        prazoPrevisto: new Date(prazoTurno(agora)).toISOString(),
        termo: TERMO,
        camms: CAMMS,
      });
    if (metodo === 'GET' && caminho === 'prazo')
      return ok(200, { prazo: new Date(prazoTurno(agora)).toISOString(), termo: TERMO });
    if (metodo === 'GET' && caminho === 'ferramentas') {
      // como a rota: todas as ativas; ?camm= filtra antes do limite; ordem por nome; passou do limite, "cortado"
      const q = semAcento(u.searchParams.get('q')).trim();
      const camm = u.searchParams.get('camm') ?? '';
      if (camm && !CAMMS.includes(camm)) return falha(400, 'CAMM inválida: use CAMM 1, CAMM 2, CAMM 3 ou C. LOG.');
      const achados = s.ferramentas
        .filter(
          (f) => (!camm || f.camm === camm) && (!q || semAcento(`${f.codigo} ${f.nome} ${f.categoria}`).includes(q)),
        )
        .sort((x, z) => x.nome.localeCompare(z.nome, 'pt-BR') || x.codigo.localeCompare(z.codigo));
      return ok(200, { rows: achados.slice(0, maxCatalogo).map(linhaFerr), cortado: achados.length > maxCatalogo });
    }
    if (metodo === 'GET' && caminho === 'emprestimos') {
      const todos = u.searchParams.get('situacao') === 'todos';
      const rows = s.emprestimos
        .filter((e) => e.colaboradorId === eu.id)
        .map((e) => linhaEmp(e, agora))
        .filter(
          (e) =>
            todos ||
            ['em_andamento', 'parcialmente_devolvido', 'aguardando_conferencia', 'aguardando_baixa'].includes(e.status),
        )
        .sort((a, z) => Date.parse(z.criadoEm) - Date.parse(a.criadoEm));
      return ok(200, { rows, cortado: false });
    }
    if (metodo === 'GET' && partes[0] === 'emprestimos' && partes.length === 2) {
      const e = s.emprestimos.find((x) => x.id === partes[1] && x.colaboradorId === eu.id);
      if (!e) return falha(404, 'Empréstimo não encontrado.');
      return ok(200, { emprestimo: linhaEmp(e, agora) });
    }
    if (metodo === 'GET' && caminho === 'lideres')
      return ok(200, {
        rows: s.pessoas
          .filter((p) => p.perfil === 'lider' || p.perfil === 'gestor')
          .map((p) => ({ id: p.id, nome: p.nome })),
      });
    if (metodo === 'POST' && caminho === 'fotos') {
      const etapa = String(b.etapa ?? '');
      if (!['entrega', 'devolucao', 'divergencia', 'conferencia'].includes(etapa))
        return falha(400, 'Etapa da foto inválida.');
      const img = String(b.imagem ?? '');
      const mini = String(b.miniatura ?? '');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || !/^data:image\/jpeg;base64,/.test(mini))
        return falha(400, 'Foto em formato inválido (use JPG, PNG ou WEBP).');
      if (img.length > 1600040) return falha(400, 'Foto grande demais.');
      const f: FotoDemo = { id: s.seq(), dono: eu.id, etapa, miniatura: mini, emprestimoId: null };
      s.fotos.push(f);
      return ok(201, { fotoId: f.id });
    }
    if (metodo === 'POST' && caminho === 'coassinatura') {
      const fin = String(b.finalidade ?? '');
      if (fin !== 'entrega' && fin !== 'conferencia') return falha(400, 'Finalidade da confirmação inválida.');
      const p = pessoa(b.matricula);
      // 401 genérico: matrícula, PIN, perfil fora (técnico, líder, terceiro) ou o próprio tomador
      if (
        !p ||
        !p.pin ||
        p.pin !== String(b.senha ?? '') ||
        !['almoxarife', 'gestor', 'admin'].includes(p.perfil) ||
        p.id === eu.id
      )
        return falha(401, 'Matrícula ou PIN inválidos.');
      const c: CoassDemo = {
        id: s.seq(),
        nome: p.nome,
        tomadorId: eu.id,
        finalidade: fin,
        expira: agora + 3 * 60e3,
        usada: false,
      };
      s.coassinaturas.push(c);
      return ok(200, { coassinaturaId: c.id, nome: c.nome, expiraEm: new Date(c.expira).toISOString() });
    }
    if (metodo === 'GET' && caminho === 'autorizacoes') {
      expirarVencidas(agora);
      const abertas = u.searchParams.get('situacao') === 'abertas';
      return ok(200, {
        rows: s.autorizacoes
          .filter((a) => a.solicitanteId === eu.id && (!abertas || ['pendente', 'aprovada'].includes(a.status)))
          .slice()
          .reverse()
          .map(linhaAut),
      });
    }
    if (metodo === 'POST' && caminho === 'autorizacoes') {
      const chave = String(b.chave ?? '');
      if (!CHAVE_OP.test(chave)) return falha(400, 'Chave de operação inválida.');
      const rep = s.autorizacoes.find((a) => a.solicitanteId === eu.id && a.chave === chave);
      if (rep)
        return ok(200, { id: rep.id, numero: rep.numero, status: rep.status, expiraEm: rep.expiraEm, repetido: true });
      if (eu.perfil !== 'terceiro') return falha(403, 'Só a conta da empresa terceira pede autorização no tablet.');
      const pessoaT = String(b.terceiroPessoa ?? '').trim();
      if (pessoaT.length < 3 || pessoaT.length > 120) return falha(400, 'Informe o nome de quem vai retirar.');
      const lider = s.pessoas.find((p) => p.id === b.liderId && (p.perfil === 'lider' || p.perfil === 'gestor'));
      if (!lider) return falha(400, 'Escolha um líder válido.');
      const camm = String(b.camm ?? '');
      if (camm && !CAMMS.includes(camm)) return falha(400, 'CAMM inválida: use CAMM 1, CAMM 2, CAMM 3 ou C. LOG.');
      const itens = Array.isArray(b.itens) ? (b.itens as Record<string, unknown>[]) : [];
      if (!itens.length || itens.length > 30) return falha(400, 'Escolha de 1 a 30 ferramentas.');
      const snap: Autorizacao['itens'] = [];
      for (const it of itens) {
        const f = s.ferramentas.find((x) => x.id === it.ferramentaId);
        if (!f) return falha(400, 'Ferramenta não encontrada.');
        const linha = linhaFerr(f);
        const un = f.controle === 'individual' ? linha.unidadesDisponiveis?.find((x) => x.id === it.unidadeId) : null;
        if (f.controle === 'individual' && !un)
          return falha(409, `A unidade escolhida de ${f.nome} não está mais disponível.`);
        const q = un ? 1 : Number(it.quantidade);
        if (!un && (!(q >= 1) || q > Number(linha.saldo?.disponivel)))
          return falha(409, `Saldo insuficiente de ${f.nome}. Confira a lista de novo.`);
        snap.push({
          ferramentaId: f.id,
          unidadeId: un?.id ?? null,
          codigo: f.codigo,
          descricao: un ? `${f.nome} (${un.identificador})` : f.nome,
          quantidade: q,
        });
      }
      const a: AutDemo = {
        id: s.seq(),
        numero: `AUT-D${String(s.autorizacoes.length + 1).padStart(5, '0')}`,
        status: 'pendente',
        solicitanteId: eu.id,
        liderId: lider.id,
        chave,
        terceiroEmpresa: eu.empresa ?? eu.nome,
        terceiroPessoa: pessoaT,
        liderNome: lider.nome,
        camm,
        finalidadeRef: String(b.finalidadeRef ?? '')
          .trim()
          .slice(0, 60),
        itens: snap,
        expiraEm: new Date(prazoTurno(agora)).toISOString(),
        decididoEm: null,
        decisaoJustificativa: null,
        criadoEm: new Date(agora).toISOString(),
        emprestimoId: null,
      };
      s.autorizacoes.push(a);
      return ok(201, { id: a.id, numero: a.numero, status: a.status, expiraEm: a.expiraEm, repetido: false });
    }
    if (metodo === 'POST' && partes[0] === 'autorizacoes' && partes.length === 3 && partes[2] === 'cancelar') {
      expirarVencidas(agora);
      const a = s.autorizacoes.find((x) => x.id === partes[1] && x.solicitanteId === eu.id);
      if (!a) return falha(404, 'Autorização não encontrada.');
      if (String(b.justificativa ?? '').trim().length < 5)
        return falha(400, 'Diga por que está cancelando (pelo menos 5 caracteres).');
      if (a.status !== 'pendente') return falha(409, 'Esta autorização já foi decidida ou venceu.');
      a.status = 'cancelada';
      return ok(200, { id: a.id, status: a.status });
    }
    if (metodo === 'GET' && partes[0] === 'emprestimos' && partes.length === 3 && partes[2] === 'fotos') {
      const e = s.emprestimos.find((x) => x.id === partes[1] && x.colaboradorId === eu.id);
      if (!e) return falha(404, 'Empréstimo não encontrado.');
      return ok(200, {
        rows: s.fotos
          .filter((f) => f.emprestimoId === e.id)
          .map((f) => ({ id: f.id, v: f.id, etapa: f.etapa, miniatura: f.miniatura || MINI_DEMO })),
      });
    }
    if (metodo === 'POST' && partes[0] === 'emprestimos' && partes.length === 3 && partes[2] === 'conferencia-no-ato') {
      const e = s.emprestimos.find((x) => x.id === partes[1] && x.colaboradorId === eu.id);
      if (!e) return falha(404, 'Empréstimo não encontrado.');
      const chave = String(b.chave ?? '');
      if (!CHAVE_OP.test(chave)) return falha(400, 'Chave de operação inválida.');
      if (e.conferencias.includes(chave)) return ok(200, { id: e.id, repetido: true });
      const c = s.coassinaturas.find((x) => x.id === b.coassinaturaId);
      if (!c || c.usada || c.expira <= agora || c.tomadorId !== eu.id || c.finalidade !== 'conferencia')
        return falha(409, 'A confirmação do almoxarife venceu ou já foi usada. Peça para ele digitar de novo.');
      const itens = Array.isArray(b.itens) ? (b.itens as Record<string, unknown>[]) : [];
      if (!itens.length) return falha(400, 'Informe o resultado de cada item.');
      const ruins = itens.filter((v) => v.resultado !== 'boa');
      let divs: { d: Divergencia; fotos: FotoDemo[] }[] = [];
      if (ruins.length) {
        const r = lerDivergencias(eu.id, b.divergencias, 'devolucao');
        if ('erro' in r) return falha(400, `Avaria ou recusa: ${r.erro}`);
        divs = r.lista;
      }
      for (const v of itens) {
        const it = e.itensLista.find((i) => i.id === v.itemId);
        if (!it || !(Number(v.quantidade) >= 1) || Number(v.quantidade) > Number(it.emConferencia))
          return falha(409, 'Quantidade em conferência diferente. Confira de novo.');
        if (v.resultado === 'boa' && e.divergencias.some((d) => d.status === 'aberta' && d.itemId === it.id))
          return falha(409, 'Este item tem divergência aberta: a conferência boa espera a resolução.');
      }
      c.usada = true;
      for (const v of itens) {
        const it = e.itensLista.find((i) => i.id === v.itemId)!;
        const q = Number(v.quantidade);
        it.emConferencia = Number(it.emConferencia) - q;
        it.devolvida = Number(it.devolvida) + q;
        const f = s.ferramentas.find((x) => x.id === it.ferramentaId);
        if (f) f.emConferencia -= q;
        const un = s.unidades.find((x) => x.id === it.unidadeId);
        if (un) un.estado = 'disponivel';
      }
      for (const x of divs) {
        e.divergencias.push(x.d);
        anexar(x.fotos, e);
      }
      e.conferencias.push(chave);
      recalcular(e, agora);
      return ok(200, { id: e.id, repetido: false });
    }
    if (metodo === 'POST' && caminho === 'emprestimos') {
      const chave = String(b.chave ?? '');
      if (!CHAVE_OP.test(chave)) return falha(400, 'Chave de operação inválida.');
      const rep = s.emprestimos.find((e) => e.colaboradorId === eu.id && e.chave === chave);
      if (rep)
        return ok(200, {
          id: rep.id,
          numero: rep.numero,
          itens: rep.itensLista.length,
          prazo: rep.prazo,
          entrega: entregaDe(rep),
          recebimentoSituacao: rep.recebimentoSituacao ?? '',
          repetido: true,
        });
      // como a rota e emprestimo.executar() (49): só empréstimo, finalidade, número em OM e TPM, CAMM e o termo
      if (b.modalidade === 'retirada')
        return falha(400, 'Retirada sem devolução não é mais feita aqui: registre um empréstimo.');
      let itens = Array.isArray(b.itens) ? (b.itens as Record<string, unknown>[]) : [];
      // com autorização e sem itens, vale o snapshot que o líder aprovou
      const autPedida = b.autorizacaoId
        ? s.autorizacoes.find((a) => a.id === b.autorizacaoId && a.solicitanteId === eu.id)
        : undefined;
      if (!itens.length && autPedida) itens = autPedida.itens.map((i) => ({ ...i }));
      if (itens.some((i) => i && (i.materialCodigo != null || !i.ferramentaId)))
        return falha(400, 'O terminal empresta só ferramentas. Material é retirado no balcão do almoxarifado.');
      if (!itens.length) return falha(400, 'Escolha pelo menos uma ferramenta.');
      if (itens.length > 30) return falha(400, 'Até 30 ferramentas por retirada.');
      const fin = String(b.finalidade ?? '');
      // com autorização, CAMM e referência vêm dela
      const ref = String((autPedida ? autPedida.finalidadeRef : b.finalidadeRef) ?? '')
        .trim()
        .slice(0, 60);
      if (!fin) return falha(400, 'Informe a finalidade: OM, CAPEX, TPM, empresa terceira ou outra.');
      if (!FINALIDADES.includes(fin))
        return falha(400, 'Finalidade inválida: use OM, CAPEX, TPM, empresa terceira ou outra.');
      if ((fin === 'om' || fin === 'tpm') && !ref) return falha(400, `Informe o número da ${fin.toUpperCase()}.`);
      const camm = autPedida ? String(autPedida.camm ?? '') : b.camm == null ? '' : String(b.camm);
      if (camm && !CAMMS.includes(camm)) return falha(400, 'CAMM inválida: use CAMM 1, CAMM 2, CAMM 3 ou C. LOG.');
      if (b.termoAceito !== true) return falha(400, 'Aceite o termo de responsabilidade para retirar.');
      // 50: empresa terceira só pela conta da empresa, com a autorização aprovada (itens iguais ao snapshot)
      expirarVencidas(agora);
      let aut: AutDemo | undefined;
      if (eu.perfil === 'terceiro' || fin === 'terceira') {
        if (eu.perfil !== 'terceiro' || fin !== 'terceira')
          return falha(400, 'Empresa terceira só pela conta da empresa, com a autorização do líder.');
        aut = autPedida;
        if (!aut) return falha(409, 'Retirada de terceiro só com autorização aprovada pelo líder.');
        if (aut.status !== 'aprovada')
          return falha(409, `Autorização ${aut.numero} ${aut.status === 'expirada' ? 'venceu' : 'não está aprovada'}.`);
        const snap = (l: { ferramentaId?: unknown; unidadeId?: unknown; quantidade?: unknown }[]) =>
          JSON.stringify(
            l.map((i) => [String(i.ferramentaId ?? ''), String(i.unidadeId ?? ''), Number(i.quantidade) || 0]).sort(),
          );
        if (snap(itens) !== snap(aut.itens)) return falha(409, 'Os itens não são os que o líder aprovou.');
      }
      const fotosEntrega = fotosRascunho(eu.id, b.fotosEntrega, ['entrega'], 1, 5);
      if (!fotosEntrega) return falha(400, 'Tire de 1 a 5 fotos das ferramentas na entrega.');
      let coass: CoassDemo | undefined;
      if (b.coassinaturaId && b.semAlmoxarife === true)
        return falha(400, 'Escolha: confirmação do almoxarife ou "sem almoxarife no turno", não os dois.');
      if (b.coassinaturaId) {
        coass = s.coassinaturas.find((x) => x.id === b.coassinaturaId);
        if (
          !coass ||
          coass.usada ||
          coass.expira <= agora ||
          coass.tomadorId !== eu.id ||
          coass.finalidade !== 'entrega'
        )
          return falha(409, 'A confirmação do almoxarife venceu ou já foi usada. Peça para ele digitar de novo.');
      } else if (b.semAlmoxarife !== true)
        return falha(400, 'Falta a confirmação do almoxarife (ou marque "sem almoxarife no turno").');
      // recebimento opcional: sem ele, fica pendente (o "recebi" depois, em Confirmar recebimento)
      const rec = b.recebimento == null ? null : (b.recebimento as Record<string, unknown>);
      let divs: { d: Divergencia; fotos: FotoDemo[] }[] = [];
      if (rec?.divergencias != null) {
        const r = lerDivergencias(eu.id, rec.divergencias, 'retirada');
        if ('erro' in r) return falha(400, r.erro);
        divs = r.lista;
      } else if (rec && rec.conferido !== true)
        return falha(400, 'Confirme que recebeu e conferiu as ferramentas, ou registre a divergência.');
      const recebido = !!rec && !divs.length;
      for (const it of itens) {
        const f = s.ferramentas.find((x) => x.id === it.ferramentaId);
        if (!f) return falha(400, 'Ferramenta não encontrada.');
        const linha = linhaFerr(f);
        if (f.controle === 'individual') {
          if (!linha.unidadesDisponiveis?.some((x) => x.id === it.unidadeId))
            return falha(409, `A unidade escolhida de ${f.nome} não está mais disponível.`);
        } else if (!(Number(it.quantidade) >= 1) || Number(it.quantidade) > Number(linha.saldo?.disponivel))
          return falha(409, `Saldo insuficiente de ${f.nome}. Confira a lista de novo.`);
      }
      const e: EmpDemo = {
        id: s.seq(),
        numero: `EMP-D${String(s.emprestimos.length + 1).padStart(5, '0')}`,
        modalidade: 'emprestimo',
        status: 'em_andamento',
        criadoEm: new Date(agora).toISOString(),
        // prazo automático: fim do turno (o do pedido é ignorado)
        prazo: new Date(prazoTurno(agora)).toISOString(),
        encerradoEm: null,
        colaboradorId: eu.id,
        chave,
        itensLista: [],
        devolucoes: [],
        finalidade: fin,
        finalidadeRef: fin === 'capex' ? '' : ref,
        camm,
        // 50: entrega pela co-assinatura (ou pendente, sem almoxarife); recebimento declarado ou com divergência
        duplaConfirmacao: true,
        semAlmoxarife: !coass,
        entregaEm: coass ? new Date(agora).toISOString() : null,
        entregaVia: coass ? 'tablet' : '',
        entreguePor: coass?.nome ?? '',
        recebimentoEm: recebido ? new Date(agora).toISOString() : null,
        recebimentoSituacao: divs.length ? 'divergencia' : recebido ? 'ok' : '',
        divergencias: [],
        conferencias: [],
        terceiroPessoa: aut?.terceiroPessoa,
        autorizacaoId: aut?.id,
        autorizacaoNumero: aut?.numero,
      };
      for (const it of itens) {
        const f = s.ferramentas.find((x) => x.id === it.ferramentaId)!;
        const un = f.controle === 'individual' ? s.unidades.find((x) => x.id === it.unidadeId) : undefined;
        const q = un ? 1 : Number(it.quantidade);
        f.emprestada += q;
        if (un) un.estado = 'emprestada';
        e.itensLista.push({
          id: s.seq(),
          tipo: 'ferramenta',
          codigo: f.codigo,
          descricao: un ? `${f.nome} (${un.identificador})` : f.nome,
          quantidade: q,
          devolvida: 0,
          emConferencia: 0,
          baixa: 0,
          pendente: q,
          unidadeId: un?.id ?? null,
          ferramentaId: f.id,
        });
      }
      s.emprestimos.push(e);
      if (coass) coass.usada = true;
      if (aut) {
        aut.status = 'utilizada';
        aut.emprestimoId = e.id;
      }
      anexar(fotosEntrega, e);
      for (const x of divs) {
        e.divergencias.push(x.d);
        anexar(x.fotos, e);
      }
      return ok(201, {
        id: e.id,
        numero: e.numero,
        itens: e.itensLista.length,
        prazo: e.prazo,
        entrega: entregaDe(e),
        recebimentoSituacao: e.recebimentoSituacao,
        repetido: false,
      });
    }
    if (metodo === 'POST' && partes[0] === 'emprestimos' && partes.length === 3 && partes[2] === 'recebimento') {
      const e = s.emprestimos.find((x) => x.id === partes[1] && x.colaboradorId === eu.id);
      if (!e) return falha(404, 'Empréstimo não encontrado.');
      if (e.recebimentoEm)
        return ok(200, { id: e.id, recebimentoSituacao: 'ok', recebimentoEm: e.recebimentoEm, repetido: true });
      if (entregaDe(e) !== 'aguardando_colaborador')
        return falha(409, 'Este empréstimo não pede confirmação de recebimento.');
      if (b.divergencias != null) {
        const r = lerDivergencias(eu.id, b.divergencias, 'retirada');
        if ('erro' in r) return falha(400, r.erro);
        for (const x of r.lista) {
          e.divergencias.push(x.d);
          anexar(x.fotos, e);
        }
        e.recebimentoSituacao = 'divergencia';
        return ok(200, { id: e.id, recebimentoEm: null, recebimentoSituacao: 'divergencia', repetido: false });
      }
      if (b.termoAceito !== true) return falha(400, 'Aceite o termo de responsabilidade para confirmar o recebimento.');
      if (b.conferido !== true) return falha(400, 'Confirme que conferiu a quantidade e as condições.');
      // a entrega ficou sem foto (balcão): o "recebi" leva de 1 a 5
      const semFoto = !s.fotos.some((f) => f.emprestimoId === e.id && f.etapa === 'entrega');
      const fotosRec =
        b.fotoIds == null && !semFoto ? [] : fotosRascunho(eu.id, b.fotoIds, ['entrega'], semFoto ? 1 : 0, 5);
      if (!fotosRec) return falha(400, 'Tire pelo menos uma foto do que recebeu.');
      if (e.divergencias.some((d) => d.status === 'aberta' && d.etapa === 'retirada'))
        return falha(409, 'Há divergência aberta neste empréstimo: aguarde o almoxarifado resolver.');
      e.recebimentoEm = new Date(agora).toISOString();
      e.recebimentoSituacao = 'ok';
      anexar(fotosRec, e);
      return ok(200, { id: e.id, recebimentoSituacao: 'ok', recebimentoEm: e.recebimentoEm, repetido: false });
    }
    if (metodo === 'POST' && partes[0] === 'emprestimos' && partes.length === 3 && partes[2] === 'devolucoes') {
      const chave = String(b.chave ?? '');
      if (!CHAVE_OP.test(chave)) return falha(400, 'Chave de operação inválida.');
      const e = s.emprestimos.find((x) => x.id === partes[1] && x.colaboradorId === eu.id);
      if (!e) return falha(404, 'Empréstimo não encontrado.');
      if (e.modalidade === 'retirada')
        return falha(409, 'Retirada não tem devolução: o almoxarifado confirma ou recusa a baixa.');
      if (e.devolucoes.includes(chave)) return ok(200, { id: e.id, numero: e.numero, repetido: true });
      const itens = Array.isArray(b.itens) ? (b.itens as Record<string, unknown>[]) : [];
      if (!itens.length) return falha(400, 'Marque pelo menos uma ferramenta.');
      const fotosDev = fotosRascunho(eu.id, b.fotoIds, ['devolucao'], 1, 5);
      if (!fotosDev) return falha(400, 'Tire de 1 a 5 fotos do que está devolvendo.');
      for (const v of itens) {
        const it = e.itensLista.find((i) => i.id === v.itemId);
        if (!it) return falha(400, 'Item não encontrado neste empréstimo.');
        if (v.condicao !== 'boa' && v.condicao !== 'avaria')
          return falha(400, 'Informe a condição da ferramenta: boa ou avaria.');
        if (v.condicao === 'avaria' && String(v.observacao ?? '').trim().length < 5)
          return falha(400, 'Descreva a avaria (pelo menos 5 caracteres).');
        if (!(Number(v.quantidade) >= 1) || Number(v.quantidade) > Number(it.pendente))
          return falha(409, 'Quantidade maior que a pendente. Confira de novo.');
      }
      for (const v of itens) {
        const it = e.itensLista.find((i) => i.id === v.itemId)!;
        const q = Number(v.quantidade);
        it.pendente = Number(it.pendente) - q;
        it.emConferencia = Number(it.emConferencia) + q;
        const f = s.ferramentas.find((x) => x.id === it.ferramentaId);
        if (f) {
          f.emprestada -= q;
          f.emConferencia += q;
        }
        const un = s.unidades.find((x) => x.id === it.unidadeId);
        if (un) un.estado = 'em_conferencia';
      }
      e.devolucoes.push(chave);
      anexar(fotosDev, e);
      e.semAlmoxarife = e.semAlmoxarife || b.semAlmoxarife === true;
      recalcular(e, agora);
      return ok(200, { id: e.id, numero: e.numero });
    }
    return falha(404, 'Rota não encontrada.');
  }

  return {
    async handle(metodo: string, url: string, corpo?: unknown) {
      if (opc.atraso ?? 250) await new Promise((r) => setTimeout(r, opc.atraso ?? 250));
      const b = corpo && typeof corpo === 'object' ? (corpo as Record<string, unknown>) : {};
      return rota(metodo, url, b);
    },
    credenciais(): CredencialDemo[] {
      return s.pessoas.map((p) => ({
        matricula: p.matricula,
        pin: p.pin,
        nome: p.nome,
        papel: PAPEL[p.perfil],
        convite: p.convite,
        codigo2fa: p.codigo2fa,
      }));
    },
    reset() {
      s = estadoInicial(relogio());
      sessao = null;
    },
    /** O líder decide no site (só nos testes e no demo). */
    decidir(numero: string, decisao: 'aprovar' | 'recusar', justificativa = '') {
      const a = s.autorizacoes.find((x) => x.numero === numero);
      if (!a || a.status !== 'pendente') return false;
      a.status = decisao === 'aprovar' ? 'aprovada' : 'recusada';
      a.decididoEm = new Date(relogio()).toISOString();
      a.decisaoJustificativa = decisao === 'recusar' ? justificativa : null;
      if (decisao === 'aprovar') a.expiraEm = new Date(prazoTurno(relogio())).toISOString();
      return true;
    },
    /** O turno acabou para esta autorização. */
    expirar(numero: string) {
      const a = s.autorizacoes.find((x) => x.numero === numero);
      if (a) a.expiraEm = new Date(relogio() - 1000).toISOString();
    },
    /** A gestão resolveu as divergências do empréstimo (o "recebi" volta a valer). */
    resolverDivergencias(numero: string) {
      const e = s.emprestimos.find((x) => x.numero === numero);
      for (const d of e?.divergencias ?? []) d.status = 'resolvida';
    },
    numeroDe(id: string) {
      return s.emprestimos.find((x) => x.id === id)?.numero ?? '';
    },
  };
}

const PAPEL: Record<Pessoa['perfil'], string> = {
  tecnico: 'Colaborador',
  admin: 'Administração',
  almoxarife: 'Almoxarifado',
  lider: 'Líder (aprova no site)',
  gestor: 'Gestão',
  terceiro: 'Empresa terceira',
};

export const demoTerminal = criarDemo();
