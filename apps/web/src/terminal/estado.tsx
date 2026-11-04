/**
 * Estado do terminal (só na memória desta página; some ao sair): sessão, tela, bandeja, chaves de operação, prazo do
 * turno e termo, resultados e as regras de segurança da V5 — 401 encerra, resposta de sessão antiga é ignorada (geração),
 * inatividade (aviso nos últimos 15 s, depois POST /sair e tela inicial), digitação sem sessão (e a saída
 * administrativa aberta) some depois de 1 min, saída administrativa escondida e recarga quando a versão publicada muda
 * (parado na tela inicial). Durante um envio (ocupado), a navegação fica parada.
 * Rascunhos por fluxo: a entrega no tablet (fotos, almoxarife, recebimento) e as autorizações da conta de terceiro.
 * Espera longa (câmera aberta, almoxarife a caminho, líder decidindo): segurarSessao() renova a sessão no servidor a cada
 * 30 s por até 5 min; passou disso, volta o aviso de inatividade, e "Continuar usando" retoma a espera.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useToast } from '../ui';
import { chamar as chamarApi, erroDe, lista, type Json, type Metodo, type Resposta } from './api';
import { assinatura, ehTerceiro, novaChave, primeiroNome, texto } from './regras';
import type {
  Autorizacao,
  Coassinatura,
  DivergenciaNova,
  Emprestimo,
  Finalidade,
  FotoEnviada,
  Separado,
  Sessao,
  Turno,
} from './tipos';
import { conferirVersao } from './versao';

export type Tela =
  | 'entrada'
  | 'primeiro'
  | 'inicio'
  | 'catalogo'
  | 'revisao'
  | 'sucesso'
  | 'devolver'
  | 'devolver-itens'
  | 'devolver-revisao'
  | 'devolver-ok'
  | 'receber'
  | 'meus'
  | 'entrega'
  | 'autorizacoes'
  | 'conferencia';

export interface ResultadoEmprestimo {
  id: string;
  numero: string;
  repetido: boolean;
  itens: Separado[];
  prazo: string | null;
  prazoFalhou: boolean;
  outros: boolean;
  /** Quem confirmou a entrega no tablet ('' = sem almoxarife no turno). */
  entreguePor: string;
  divergencia: boolean;
}

/** O que foi pedido na revisão (ou o que o líder aprovou, travado): vai inteiro no POST /emprestimos. */
export interface Pedido {
  itens: Separado[];
  finalidade: Finalidade;
  finalidadeRef: string;
  camm: string;
  autorizacaoId?: string;
  autorizacaoNumero?: string;
}
/** Recebimento: "recebi, conferi e estão em boas condições" ou as divergências (cada uma com foto). */
export interface EscolhaRecebimento {
  modo: '' | 'ok' | 'divergencia';
  divergencias: DivergenciaNova[];
  termo: boolean;
}
export const RECEBIMENTO_VAZIO: EscolhaRecebimento = { modo: '', divergencias: [], termo: false };
/** Rascunho da entrega no tablet: 1 fotos, 2 almoxarife (ou sem almoxarife), 3 recebimento. */
export interface RascunhoEntrega {
  pedido: Pedido;
  passo: 'fotos' | 'almoxarife' | 'recebimento';
  fotos: FotoEnviada[];
  coassinatura: Coassinatura | null;
  semAlmoxarife: boolean;
  recebimento: EscolhaRecebimento;
}
export interface SelDev {
  quantidade: number;
  condicao: 'boa' | 'avaria';
  observacao: string;
}
export interface Devolucao {
  id: string;
  sel: Record<string, SelDev>;
  de: 'devolver' | 'meus';
  /** Fotos da devolução (obrigatórias, 1 a 5), já salvas como rascunho no servidor. */
  fotos: FotoEnviada[];
}
export interface ItemDevolvido {
  itemId: string;
  codigo: string;
  descricao: string;
  quantidade: number;
  condicao: 'boa' | 'avaria';
  observacao: string;
}
export interface ResultadoDevolucao {
  emprestimoId: string;
  numero: string;
  repetido: boolean;
  itens: ItemDevolvido[];
  outra: boolean;
  semAlmoxarife: boolean;
}

const AVISO_S = 15;
const PING_MS = 8000;
const MARGEM_MS = 2000;
const LIMPA_MS = 60000;
const ESPERA_MS = 20000;
const VERSAO_MS = 300000;
export const SAIDA_MS = 1400;
/** Espera longa segurando a sessão (câmera, almoxarife, líder): até 5 min, renovando a cada 30 s. */
export const ESPERA_LONGA_MS = 300000;
const RENOVA_MS = 30000;
const TELAS_PUBLICAS: Tela[] = ['entrada', 'primeiro'];

interface Contexto {
  sessao: Sessao | null;
  tela: Tela;
  ir: (tela: Tela) => void;
  chamar: (metodo: Metodo, caminho: string, corpo?: unknown, publica?: boolean) => Promise<Resposta>;
  /** Espera o POST /sair anterior antes de um novo login. */
  aguardarLimpeza: () => Promise<void>;
  abrirSessao: (j: Json, recado?: string) => void;
  sair: (motivo: 'logout' | 'inatividade') => void;
  voltarInicio: (recado?: string) => void;
  recado: { texto: string; tom: 'ok' | 'info' } | null;
  /** Muda quando a tela inicial deve voltar limpa (remonta o formulário). */
  geracaoEntrada: number;
  bandeja: Separado[];
  mudarBandeja: (fn: (b: Separado[]) => Separado[]) => void;
  /** Chave da operação do empréstimo: a mesma até o servidor confirmar. */
  chave: () => string;
  concluirEmprestimo: (j: Json, itens: Separado[], extra?: { entreguePor?: string; divergencia?: boolean }) => void;
  resultado: ResultadoEmprestimo | null;
  /** Prazo de um empréstimo feito agora e o termo (GET /prazo; muda às 18:00). null = ainda não veio. */
  turno: Turno | null;
  turnoErro: string;
  carregarTurno: () => void;
  abertos: Emprestimo[] | null;
  abertosErro: string;
  carregarAbertos: () => void;
  dev: Devolucao | null;
  setDev: Dispatch<SetStateAction<Devolucao | null>>;
  chavesDev: MutableRefObject<Record<string, { chave: string; incerto: string | null }>>;
  resultadoDev: ResultadoDevolucao | null;
  setResultadoDev: (r: ResultadoDevolucao | null) => void;
  avisoResta: number | null;
  continuarSessao: () => void;
  adminAberto: boolean;
  setAdminAberto: (v: boolean) => void;
  /** Envio em andamento (confirmar o pedido): ir() não troca de tela até a resposta. */
  ocupado: boolean;
  setOcupado: (v: boolean) => void;
  saindo: { motivo: 'logout' | 'inatividade'; nome: string } | null;
  fecharSaindo: () => void;
  entrega: RascunhoEntrega | null;
  setEntrega: Dispatch<SetStateAction<RascunhoEntrega | null>>;
  /** Começa a entrega (fotos, almoxarife, recebimento) do pedido revisado ou da autorização aprovada. */
  iniciarEntrega: (p: Pedido) => void;
  autorizacoes: Autorizacao[] | null;
  autorizacoesErro: string;
  carregarAutorizacoes: () => void;
  /** Autorização em destaque na tela de autorizações (a recém-enviada). */
  autFoco: string | null;
  setAutFoco: (id: string | null) => void;
  /** Espera longa: segura a sessão (renova no servidor) até a função devolvida ser chamada (ou 5 min). */
  segurarSessao: () => () => void;
  /** Pedido de autorização aceito pelo servidor: a chave troca, a bandeja esvazia e a espera abre. */
  concluirAutorizacao: (id: string) => void;
}

const Ctx = createContext<Contexto | null>(null);

export function useTerminal(): Contexto {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTerminal fora do TerminalProvider.');
  return c;
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [tela, setTela] = useState<Tela>('entrada');
  const [recado, setRecado] = useState<Contexto['recado']>(null);
  const [geracaoEntrada, setGeracaoEntrada] = useState(0);
  const [bandeja, setBandeja] = useState<Separado[]>([]);
  const [resultado, setResultado] = useState<ResultadoEmprestimo | null>(null);
  const [turno, setTurno] = useState<Turno | null>(null);
  const [turnoErro, setTurnoErro] = useState('');
  const [abertos, setAbertos] = useState<Emprestimo[] | null>(null);
  const [abertosErro, setAbertosErro] = useState('');
  const [dev, setDev] = useState<Devolucao | null>(null);
  const [resultadoDev, setResultadoDev] = useState<ResultadoDevolucao | null>(null);
  const [avisoResta, setAvisoResta] = useState<number | null>(null);
  const [adminAberto, setAdminAberto] = useState(false);
  const [ocupado, setOcupadoEstado] = useState(false);
  const [saindo, setSaindo] = useState<Contexto['saindo']>(null);
  const [entrega, setEntrega] = useState<RascunhoEntrega | null>(null);
  const [autorizacoes, setAutorizacoes] = useState<Autorizacao[] | null>(null);
  const [autorizacoesErro, setAutorizacoesErro] = useState('');
  const [autFoco, setAutFoco] = useState<string | null>(null);

  // refs: o que os temporizadores e as respostas assíncronas leem sem depender de render
  const geracao = useRef(0);
  const sessaoRef = useRef<Sessao | null>(null);
  sessaoRef.current = sessao;
  const ultimoContato = useRef(0);
  const ultimaAtividade = useRef(Date.now());
  const sujo = useRef(false);
  const emVoo = useRef(0);
  const pingando = useRef(false);
  const limpeza = useRef<Promise<void>>(Promise.resolve());
  const chaveAtual = useRef<string | null>(null);
  const chavesDev = useRef<Record<string, { chave: string; incerto: string | null }>>({});
  const seqAbertos = useRef(0);
  const seqTurno = useRef(0);
  const seqAut = useRef(0);
  const segurando = useRef(0);
  const seguraDesde = useRef(0);
  const versaoConferida = useRef(Date.now());
  const avisoRef = useRef<number | null>(null);
  avisoRef.current = avisoResta;
  const adminRef = useRef(false);
  adminRef.current = adminAberto;
  const ocupadoRef = useRef(false);
  const setOcupado = useCallback((v: boolean) => {
    ocupadoRef.current = v;
    setOcupadoEstado(v);
  }, []);

  const voltarInicio = useCallback((msg?: string, tom: 'ok' | 'info' = 'info') => {
    geracao.current += 1;
    sessaoRef.current = null;
    chaveAtual.current = null;
    chavesDev.current = {};
    sujo.current = false;
    ocupadoRef.current = false;
    setOcupadoEstado(false);
    setAdminAberto(false);
    setSessao(null);
    setTela('entrada');
    setBandeja([]);
    setResultado(null);
    setTurno(null);
    setTurnoErro('');
    setAbertos(null);
    setAbertosErro('');
    setDev(null);
    setResultadoDev(null);
    setEntrega(null);
    setAutorizacoes(null);
    setAutorizacoesErro('');
    setAutFoco(null);
    segurando.current = 0;
    setAvisoResta(null);
    setRecado(msg ? { texto: msg, tom } : null);
    setGeracaoEntrada((g) => g + 1);
  }, []);

  /**
   * Toda chamada passa por aqui. Resposta de uma sessão que já acabou (geração antiga) volta com velho=true. Com sessão
   * aberta, 401 encerra tudo; sucesso marca o último contato (a inatividade do servidor recomeça a cada chamada).
   */
  const chamar = useCallback(
    async (metodo: Metodo, caminho: string, corpo?: unknown, publica = false): Promise<Resposta> => {
      const g = geracao.current;
      const inicio = Date.now();
      emVoo.current += 1;
      const r = await chamarApi(metodo, caminho, corpo);
      emVoo.current -= 1;
      if (g !== geracao.current) return { ...r, velho: true };
      if (sessaoRef.current && !publica) {
        if (r.status === 401) {
          voltarInicio('Sua sessão terminou. Entre de novo para continuar.');
          return { ...r, velho: true };
        }
        if (r.ok) ultimoContato.current = Math.max(ultimoContato.current, inicio);
      }
      return r;
    },
    [voltarInicio],
  );

  const carregarAbertos = useCallback(() => {
    const seq = ++seqAbertos.current;
    setAbertosErro('');
    void chamar('GET', '/emprestimos?situacao=abertos').then((r) => {
      if (r.velho || seq !== seqAbertos.current) return;
      if (!r.ok) setAbertosErro(r.json.erro ? String(r.json.erro) : 'Não foi possível buscar seus registros.');
      else setAbertos(lista<Emprestimo>(r.json.rows));
    });
  }, [chamar]);

  // prazo e termo de um empréstimo feito agora: relidos ao abrir a revisão e o recebimento (o prazo vira às 18:00)
  const carregarTurno = useCallback(() => {
    const seq = ++seqTurno.current;
    setTurnoErro('');
    void chamar('GET', '/prazo').then((r) => {
      if (r.velho || seq !== seqTurno.current) return;
      if (!r.ok || !texto(r.json.termo)) {
        setTurnoErro(r.ok ? 'Não foi possível buscar o termo de responsabilidade.' : erroDe(r));
        return;
      }
      setTurno({ prazo: texto(r.json.prazo) || null, termo: texto(r.json.termo) });
    });
  }, [chamar]);

  // conta de terceiro: os pedidos de autorização ao líder (abertos e os decididos)
  const carregarAutorizacoes = useCallback(() => {
    const seq = ++seqAut.current;
    setAutorizacoesErro('');
    void chamar('GET', '/autorizacoes?situacao=todas').then((r) => {
      if (r.velho || seq !== seqAut.current) return;
      if (!r.ok) setAutorizacoesErro(erroDe(r));
      else setAutorizacoes(lista<Autorizacao>(r.json.rows));
    });
  }, [chamar]);

  const ir = useCallback(
    (nova: Tela) => {
      if (ocupadoRef.current) return; // envio em andamento: a tela fica até a resposta
      if (!sessaoRef.current && !TELAS_PUBLICAS.includes(nova)) nova = 'entrada';
      if (nova === 'inicio' || nova === 'devolver' || nova === 'receber') carregarAbertos();
      if (nova === 'revisao' || nova === 'receber' || nova === 'entrega') carregarTurno();
      if ((nova === 'inicio' && ehTerceiro(sessaoRef.current?.colaborador)) || nova === 'autorizacoes')
        carregarAutorizacoes();
      setTela(nova);
      if (sessaoRef.current) setRecado(null);
      try {
        window.scrollTo(0, 0);
      } catch {
        /* jsdom */
      }
    },
    [carregarAbertos, carregarTurno, carregarAutorizacoes],
  );

  const abrirSessao = useCallback(
    (j: Json, msg?: string) => {
      const c = j.colaborador && typeof j.colaborador === 'object' ? (j.colaborador as Sessao['colaborador']) : {};
      const s: Sessao = {
        colaborador: c,
        inatividade: Math.min(Math.max(Number(j.inatividadeSegundos) || 90, 20), 3600),
      };
      sessaoRef.current = s;
      ultimoContato.current = ultimaAtividade.current = Date.now();
      setSessao(s);
      setRecado(null);
      if (msg) toast.mostrar({ texto: msg, tom: 'ok' });
      ir('inicio');
    },
    [ir, toast],
  );

  const sair = useCallback(
    (motivo: 'logout' | 'inatividade') => {
      // o cookie e a sessão do servidor acabam no POST /sair; o próximo login espera ele voltar
      limpeza.current = chamarApi('POST', '/sair', {}).then(() => undefined);
      const nome = primeiroNome(sessaoRef.current?.colaborador.nome);
      voltarInicio(
        motivo === 'inatividade'
          ? 'Sessão encerrada por inatividade. Entre de novo para continuar.'
          : 'Você saiu do terminal. Até a próxima!',
        motivo === 'inatividade' ? 'info' : 'ok',
      );
      setSaindo({ motivo, nome });
    },
    [voltarInicio],
  );

  const manterSessao = useCallback(() => {
    if (pingando.current || !sessaoRef.current) return;
    pingando.current = true;
    void chamar('GET', '/eu').then((r) => {
      pingando.current = false;
      if (r.velho || !r.ok || !sessaoRef.current) return;
      const atual = sessaoRef.current;
      const ina = Number(r.json.inatividadeSegundos);
      setSessao({
        ...atual,
        colaborador:
          r.json.colaborador && typeof r.json.colaborador === 'object'
            ? (r.json.colaborador as Sessao['colaborador'])
            : atual.colaborador,
        inatividade: ina > 0 ? Math.min(Math.max(ina, 20), 3600) : atual.inatividade,
      });
      setAvisoResta(null);
    });
  }, [chamar]);

  // começa limpo: se ficou uma sessão do terminal neste navegador (página recarregada), ela é encerrada
  useEffect(() => {
    limpeza.current = chamarApi('POST', '/sair', {}).then(() => undefined);
  }, []);

  // toque, tecla, rolagem: conta como uso; com sessão, renova no servidor (no máximo a cada 8 s, ou já com o aviso)
  useEffect(() => {
    const atividade = () => {
      ultimaAtividade.current = Date.now();
      if (!sessaoRef.current) {
        sujo.current = true;
        return;
      }
      if (avisoRef.current != null || Date.now() - ultimoContato.current > PING_MS) manterSessao();
    };
    const eventos = ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart', 'scroll'];
    for (const ev of eventos) document.addEventListener(ev, atividade, { capture: true, passive: true });
    return () => {
      for (const ev of eventos) document.removeEventListener(ev, atividade, { capture: true });
    };
  }, [manterSessao]);

  // relógio da inatividade (0,5 s). O fim conta do último contato com o servidor, que é o que ele usa.
  useEffect(() => {
    const tick = () => {
      const t = Date.now();
      const s = sessaoRef.current;
      if (!s) {
        // digitação largada ou saída administrativa aberta: 1 min sem uso limpa e fecha tudo
        if ((sujo.current || adminRef.current) && t - ultimaAtividade.current > LIMPA_MS) voltarInicio();
        else if (!sujo.current && t - versaoConferida.current > VERSAO_MS && t - ultimaAtividade.current > LIMPA_MS) {
          versaoConferida.current = t;
          void conferirVersao(() => !sessaoRef.current && !sujo.current);
        }
        return;
      }
      // espera longa (câmera, almoxarife, líder): renova a sessão por até 5 min; depois, o aviso de sempre
      if (segurando.current > 0 && t - seguraDesde.current < ESPERA_LONGA_MS) {
        if (t - ultimoContato.current > RENOVA_MS) manterSessao();
        if (avisoRef.current != null) setAvisoResta(null);
        return;
      }
      const fim = ultimoContato.current + s.inatividade * 1000 - MARGEM_MS;
      const resta = Math.ceil((fim - t) / 1000);
      if (resta <= 0) {
        if (emVoo.current > 0 && t < fim + ESPERA_MS) return; // uma chamada ainda volta: ela decide
        sair('inatividade');
        return;
      }
      setAvisoResta(resta <= AVISO_S ? resta : null);
    };
    const id = setInterval(tick, 500);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [sair, voltarInicio, manterSessao]);

  // "Voltar" do navegador não tira ninguém do terminal por engano (a trava de verdade é o modo quiosque)
  useEffect(() => {
    try {
      history.pushState({ terminal: 1 }, '', location.href);
    } catch {
      return;
    }
    const prender = () => {
      try {
        history.pushState({ terminal: 1 }, '', location.href);
      } catch {
        /* ok */
      }
    };
    window.addEventListener('popstate', prender);
    return () => window.removeEventListener('popstate', prender);
  }, []);

  // saída administrativa pelo teclado: Ctrl+Alt+Shift+S
  useEffect(() => {
    const teclas = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && (e.code === 'KeyS' || e.key.toLowerCase() === 's')) {
        e.preventDefault();
        setAdminAberto(true);
      }
    };
    document.addEventListener('keydown', teclas);
    return () => document.removeEventListener('keydown', teclas);
  }, []);

  // tela de "saindo": some sozinha (a memória já foi limpa antes dela)
  useEffect(() => {
    if (!saindo) return;
    const t = setTimeout(() => setSaindo(null), SAIDA_MS);
    return () => clearTimeout(t);
  }, [saindo]);

  const mudarBandeja = useCallback((fn: (b: Separado[]) => Separado[]) => setBandeja(fn), []);

  const segurarSessao = useCallback(() => {
    if (segurando.current++ === 0) seguraDesde.current = Date.now();
    let solto = false;
    return () => {
      if (solto) return;
      solto = true;
      segurando.current = Math.max(0, segurando.current - 1);
      // voltou da câmera (ou o almoxarife chegou): conta como uso e a sessão recomeça do zero
      ultimaAtividade.current = Date.now();
      if (sessaoRef.current && Date.now() - ultimoContato.current > PING_MS) manterSessao();
    };
  }, [manterSessao]);

  const concluirAutorizacao = useCallback(
    (id: string) => {
      chaveAtual.current = null;
      setBandeja([]);
      setAutFoco(id);
      ir('autorizacoes');
    },
    [ir],
  );

  const iniciarEntrega = useCallback(
    (p: Pedido) => {
      setEntrega({
        pedido: p,
        passo: 'fotos',
        fotos: [],
        coassinatura: null,
        semAlmoxarife: false,
        recebimento: RECEBIMENTO_VAZIO,
      });
      ir('entrega');
    },
    [ir],
  );

  const chave = useCallback(() => {
    if (!chaveAtual.current) chaveAtual.current = novaChave();
    return chaveAtual.current;
  }, []);

  const concluirEmprestimo = useCallback(
    (j: Json, itens: Separado[], extra: { entreguePor?: string; divergencia?: boolean } = {}) => {
      const res: ResultadoEmprestimo = {
        id: texto(j.id),
        numero: texto(j.numero),
        repetido: j.repetido === true,
        itens,
        // prazo do fim do turno, calculado pelo servidor (vem na resposta; se não vier, sai do registro abaixo)
        prazo: texto(j.prazo) || null,
        prazoFalhou: false,
        outros: false,
        entreguePor: extra.entreguePor ?? '',
        divergencia: extra.divergencia === true || j.recebimentoSituacao === 'divergencia',
      };
      // só agora a chave troca: o servidor confirmou
      chaveAtual.current = null;
      setBandeja([]);
      setEntrega(null);
      setAutorizacoes(null);
      setAbertos(null);
      setResultado(res);
      setTela('sucesso');
      void chamar('GET', `/emprestimos/${encodeURIComponent(res.id)}`).then((d) => {
        if (d.velho) return;
        const emp =
          d.ok && d.json.emprestimo && typeof d.json.emprestimo === 'object' ? (d.json.emprestimo as Emprestimo) : null;
        const novo = { ...res };
        if (emp?.prazo) novo.prazo = emp.prazo;
        else if (!novo.prazo) novo.prazoFalhou = true;
        // repetido: o servidor devolveu o pedido enviado antes; se os itens não são os desta bandeja, mostra os registrados
        if (emp && res.repetido) {
          const reg: Separado[] = (emp.itensLista ?? [])
            .filter((i) => i.tipo !== 'material')
            .map((i) => ({
              ferramentaId: String(i.ferramentaId ?? ''),
              unidadeId: i.unidadeId ?? null,
              identificador: '',
              quantidade: Number(i.quantidade) || 0,
              codigo: i.codigo,
              nome: i.descricao,
              maximo: Number(i.quantidade) || 0,
            }));
          if (reg.length && assinatura(reg) !== assinatura(itens)) {
            novo.itens = reg;
            novo.outros = true;
          }
        }
        setResultado((atual) => (atual && atual.id === res.id ? novo : atual));
      });
    },
    [chamar],
  );

  const valor = useMemo<Contexto>(
    () => ({
      sessao,
      tela,
      ir,
      chamar,
      aguardarLimpeza: () => limpeza.current,
      abrirSessao,
      sair,
      voltarInicio,
      recado,
      geracaoEntrada,
      bandeja,
      mudarBandeja,
      chave,
      concluirEmprestimo,
      resultado,
      turno,
      turnoErro,
      carregarTurno,
      abertos,
      abertosErro,
      carregarAbertos,
      dev,
      setDev,
      chavesDev,
      resultadoDev,
      setResultadoDev,
      avisoResta,
      continuarSessao: () => {
        setAvisoResta(null);
        // numa espera longa, "Continuar usando" retoma a espera do começo
        if (segurando.current > 0) seguraDesde.current = Date.now();
        manterSessao();
      },
      adminAberto,
      setAdminAberto,
      ocupado,
      setOcupado,
      saindo,
      fecharSaindo: () => setSaindo(null),
      entrega,
      setEntrega,
      iniciarEntrega,
      autorizacoes,
      autorizacoesErro,
      carregarAutorizacoes,
      autFoco,
      setAutFoco,
      segurarSessao,
      concluirAutorizacao,
    }),
    [
      sessao,
      tela,
      ir,
      chamar,
      abrirSessao,
      sair,
      voltarInicio,
      recado,
      geracaoEntrada,
      bandeja,
      mudarBandeja,
      chave,
      concluirEmprestimo,
      resultado,
      turno,
      turnoErro,
      carregarTurno,
      abertos,
      abertosErro,
      carregarAbertos,
      dev,
      resultadoDev,
      avisoResta,
      manterSessao,
      adminAberto,
      ocupado,
      setOcupado,
      saindo,
      entrega,
      iniciarEntrega,
      autorizacoes,
      autorizacoesErro,
      carregarAutorizacoes,
      autFoco,
      segurarSessao,
      concluirAutorizacao,
    ],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

/** Segura a sessão enquanto `ativo` (espera longa: almoxarife a caminho, líder decidindo). */
export function useSegurarSessao(ativo: boolean) {
  const { segurarSessao } = useTerminal();
  useEffect(() => (ativo ? segurarSessao() : undefined), [ativo, segurarSessao]);
}
