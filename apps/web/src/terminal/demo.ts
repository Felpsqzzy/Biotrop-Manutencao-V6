/**
 * Demonstração do terminal (só no build `--mode demo`, via import() em ./api.ts; também usada nos testes): responde
 * /api/terminal/* em memória, com o contrato da rota real (mesmos campos, status e mensagens principais).
 * Tudo FICTÍCIO: pessoas com [DEMO], PINs e código do autenticador de demonstração, ferramentas com código D.
 * Cobre: ferramentas por quantidade, por unidade (patrimônio/série), peças iguais (FMNT), retiráveis (mais de 100,
 * para a lista virtualizada), empréstimos abertos e atrasados, uma retirada aguardando baixa e uma baixada.
 * O estado vive só nesta página (recarregar volta ao começo).
 */
import { problemaPin } from './regras';
import type { Emprestimo, Ferramenta, ItemEmprestimo, Modulo } from './tipos';

interface Pessoa {
  id: string;
  nome: string;
  matricula: string;
  setor: string;
  perfil: 'tecnico' | 'almoxarife' | 'admin';
  pin: string | null;
  convite?: string;
  codigo2fa?: string;
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
      retiravel: false,
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
  // peças iguais (códigos FMNT, uma peça por código): aparecem num grupo só e a pessoa escolhe a etiqueta
  for (let i = 1; i <= 6; i++)
    nova(
      `FMNT-D20${i}`,
      'Jogo de chaves Allen 1,5-10 mm',
      'Manual',
      i <= 3 ? 'Armário E, CAMM 1' : 'Armário E, CAMM 2',
      1,
    );
  // retiráveis (RM): saem e não voltam; mais de 100 para a lista virtualizada
  nova('FMNT-D001', 'Disco de corte 4 1/2"', 'Consumíveis', 'Armário F, CAMM 1', 40, { retiravel: true });
  nova('FMNT-D002', 'Fita isolante 19 mm', 'Elétrica', 'Armário F, CAMM 2', 30, { retiravel: true });
  nova('FMNT-D003', 'Luva de vaqueta (par)', 'Acesso e segurança', 'Armário F, CAMM 3', 25, { retiravel: true });
  const familias: [string, string, (i: number) => string][] = [
    ['BR', 'Broca HSS', (i) => `${(1 + i * 0.5).toFixed(1).replace('.', ',')} mm`],
    ['LX', "Lixa d'água grão", (i) => String(80 + i * 40)],
    ['AB', 'Abraçadeira de nylon', (i) => `${100 + i * 20} mm (pacote)`],
    [
      'RB',
      'Rebite pop',
      (i) => `${(3 + (i % 4) * 0.8).toFixed(1).replace('.', ',')} x ${8 + Math.floor(i / 4) * 2} mm`,
    ],
    ['PF', 'Parafuso sextavado', (i) => `M${6 + (i % 6) * 2} x ${20 + Math.floor(i / 6) * 10} mm`],
  ];
  familias.forEach(([sigla, nome, medida], k) => {
    for (let i = 0; i < 22; i++)
      nova(
        `CNS-D${sigla}${String(i + 1).padStart(2, '0')}`,
        `${nome} ${medida(i)}`,
        'Consumíveis',
        `Armário G, gaveta ${k + 1}`,
        5 + ((i * 7) % 20),
        {
          retiravel: true,
        },
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
  registrar('p1', 'emprestimo', agora - 9 * DIA, [['FER-D004', 1, 'SN-D-MD01']]);
  registrar('p1', 'retirada', agora - 3 * H, [['FMNT-D001', 2]]);
  registrar('p1', 'retirada', agora - 5 * DIA, [['FMNT-D002', 1]], { status: 'encerrado', quando: agora - 4 * DIA });
  registrar('p1', 'emprestimo', agora - 12 * DIA, [['FER-D011', 1]], {
    status: 'devolvido',
    quando: agora - 11 * DIA,
    devolvida: true,
  });
  registrar('p2', 'emprestimo', agora - 2 * DIA, [['FER-D012', 1]]);
  return { pessoas, ferramentas, unidades, emprestimos, seq: () => id('x') };
}

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
  const colaborador = (p: Pessoa) => ({ nome: p.nome, matricula: p.matricula, setor: p.setor });
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
      retiravel: f.retiravel,
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
    };
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
      return ok(200, { colaborador: colaborador(eu), inatividadeSegundos: INATIVIDADE, prazoPadraoHoras: PRAZO_HORAS });
    if (metodo === 'GET' && caminho === 'ferramentas') {
      // como a rota: retirada filtra as retiráveis antes do limite; ordem por nome; passou do limite, "cortado"
      const q = semAcento(u.searchParams.get('q')).trim();
      const rm = u.searchParams.get('modalidade') === 'retirada';
      const achados = s.ferramentas
        .filter((f) => (!rm || f.retiravel) && (!q || semAcento(`${f.codigo} ${f.nome} ${f.categoria}`).includes(q)))
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
    if (metodo === 'POST' && caminho === 'emprestimos') {
      const chave = String(b.chave ?? '');
      if (!CHAVE_OP.test(chave)) return falha(400, 'Chave de operação inválida.');
      const rep = s.emprestimos.find((e) => e.colaboradorId === eu.id && e.chave === chave);
      if (rep) return ok(200, { id: rep.id, numero: rep.numero, modalidade: rep.modalidade, repetido: true });
      const modalidade: Modulo = b.modalidade === 'retirada' ? 'retirada' : 'emprestimo';
      const itens = Array.isArray(b.itens) ? (b.itens as Record<string, unknown>[]) : [];
      if (!itens.length) return falha(400, 'Escolha pelo menos uma ferramenta.');
      if (itens.length > 30) return falha(400, 'Até 30 ferramentas por retirada.');
      for (const it of itens) {
        const f = s.ferramentas.find((x) => x.id === it.ferramentaId);
        if (!f) return falha(400, 'Ferramenta não encontrada.');
        if (modalidade === 'retirada' && !f.retiravel)
          return falha(400, `${f.nome} não pode ser retirada, só emprestada.`);
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
        modalidade,
        status: modalidade === 'retirada' ? 'aguardando_baixa' : 'em_andamento',
        criadoEm: new Date(agora).toISOString(),
        prazo: modalidade === 'retirada' ? null : new Date(agora + PRAZO_HORAS * H).toISOString(),
        encerradoEm: null,
        colaboradorId: eu.id,
        chave,
        itensLista: [],
        devolucoes: [],
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
      return ok(201, { id: e.id, numero: e.numero, modalidade });
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
        papel: p.perfil === 'tecnico' ? 'Colaborador' : p.perfil === 'admin' ? 'Administração' : 'Almoxarifado',
        convite: p.convite,
        codigo2fa: p.codigo2fa,
      }));
    },
    reset() {
      s = estadoInicial(relogio());
      sessao = null;
    },
  };
}

export const demoTerminal = criarDemo();
