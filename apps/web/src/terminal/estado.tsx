/**
 * Estado do terminal (só na memória desta página; some ao sair): sessão, tela, módulo (EM × RM), bandejas, chaves de
 * operação, resultados e as regras de segurança da V5 — 401 encerra, resposta de sessão antiga é ignorada (geração),
 * inatividade (aviso nos últimos 15 s, depois POST /sair e tela inicial), digitação sem sessão (e a saída
 * administrativa aberta) some depois de 1 min, saída administrativa escondida e recarga quando a versão publicada muda
 * (parado na tela inicial). Durante um envio (ocupado), a navegação fica parada.
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
import { chamar as chamarApi, lista, type Json, type Metodo, type Resposta } from './api';
import { assinatura, novaChave, primeiroNome, texto } from './regras';
import type { Emprestimo, Modulo, Separado, Sessao } from './tipos';
import { conferirVersao } from './versao';

export type Tela =
  | 'entrada'
  | 'primeiro'
  | 'modulos'
  | 'inicio'
  | 'catalogo'
  | 'revisao'
  | 'sucesso'
  | 'devolver'
  | 'devolver-itens'
  | 'devolver-revisao'
  | 'devolver-ok'
  | 'meus';

export interface ResultadoRetirada {
  id: string;
  numero: string;
  modalidade: Modulo;
  repetido: boolean;
  itens: Separado[];
  prazo: string | null;
  prazoFalhou: boolean;
  outros: boolean;
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
  numero: string;
  repetido: boolean;
  itens: ItemDevolvido[];
  outra: boolean;
}

const AVISO_S = 15;
const PING_MS = 8000;
const MARGEM_MS = 2000;
const LIMPA_MS = 60000;
const ESPERA_MS = 20000;
const VERSAO_MS = 300000;
export const SAIDA_MS = 1400;
const TELAS_PUBLICAS: Tela[] = ['entrada', 'primeiro'];

interface Contexto {
  sessao: Sessao | null;
  tela: Tela;
  modulo: Modulo | null;
  ir: (tela: Tela, modulo?: Modulo) => void;
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
  /** Chave da operação do módulo: a mesma até o servidor confirmar. */
  chaveDe: (m: Modulo) => string;
  concluirRetirada: (j: Json, itens: Separado[], modalidade: Modulo) => void;
  resultado: ResultadoRetirada | null;
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
  /** Envio em andamento (confirmar o pedido): ir() não troca de tela nem de módulo até a resposta. */
  ocupado: boolean;
  setOcupado: (v: boolean) => void;
  saindo: { motivo: 'logout' | 'inatividade'; nome: string } | null;
  fecharSaindo: () => void;
}

const Ctx = createContext<Contexto | null>(null);

export function useTerminal(): Contexto {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTerminal fora do TerminalProvider.');
  return c;
}

const vazio = (): Record<Modulo, Separado[]> => ({ emprestimo: [], retirada: [] });

export function TerminalProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [tela, setTela] = useState<Tela>('entrada');
  const [modulo, setModulo] = useState<Modulo | null>(null);
  const [recado, setRecado] = useState<Contexto['recado']>(null);
  const [geracaoEntrada, setGeracaoEntrada] = useState(0);
  const [bandejas, setBandejas] = useState(vazio);
  const [resultado, setResultado] = useState<ResultadoRetirada | null>(null);
  const [abertos, setAbertos] = useState<Emprestimo[] | null>(null);
  const [abertosErro, setAbertosErro] = useState('');
  const [dev, setDev] = useState<Devolucao | null>(null);
  const [resultadoDev, setResultadoDev] = useState<ResultadoDevolucao | null>(null);
  const [avisoResta, setAvisoResta] = useState<number | null>(null);
  const [adminAberto, setAdminAberto] = useState(false);
  const [ocupado, setOcupadoEstado] = useState(false);
  const [saindo, setSaindo] = useState<Contexto['saindo']>(null);

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
  const chaves = useRef<Record<Modulo, string | null>>({ emprestimo: null, retirada: null });
  const chavesDev = useRef<Record<string, { chave: string; incerto: string | null }>>({});
  const seqAbertos = useRef(0);
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
    chaves.current = { emprestimo: null, retirada: null };
    chavesDev.current = {};
    sujo.current = false;
    ocupadoRef.current = false;
    setOcupadoEstado(false);
    setAdminAberto(false);
    setSessao(null);
    setTela('entrada');
    setModulo(null);
    setBandejas(vazio());
    setResultado(null);
    setAbertos(null);
    setAbertosErro('');
    setDev(null);
    setResultadoDev(null);
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

  const ir = useCallback(
    (nova: Tela, m?: Modulo) => {
      if (ocupadoRef.current) return; // envio em andamento: a tela fica até a resposta
      if (!sessaoRef.current && !TELAS_PUBLICAS.includes(nova)) nova = 'entrada';
      if (m) setModulo(m);
      if (nova === 'modulos') setModulo(null);
      if (nova === 'modulos' || nova === 'inicio' || nova === 'devolver') carregarAbertos();
      setTela(nova);
      if (sessaoRef.current) setRecado(null);
      try {
        window.scrollTo(0, 0);
      } catch {
        /* jsdom */
      }
    },
    [carregarAbertos],
  );

  const abrirSessao = useCallback(
    (j: Json, msg?: string) => {
      const c = j.colaborador && typeof j.colaborador === 'object' ? (j.colaborador as Sessao['colaborador']) : {};
      const s: Sessao = {
        colaborador: c,
        inatividade: Math.min(Math.max(Number(j.inatividadeSegundos) || 90, 20), 3600),
        prazoPadraoHoras: Number(j.prazoPadraoHoras) > 0 ? Number(j.prazoPadraoHoras) : null,
      };
      sessaoRef.current = s;
      ultimoContato.current = ultimaAtividade.current = Date.now();
      setSessao(s);
      setRecado(null);
      if (msg) toast.mostrar({ texto: msg, tom: 'ok' });
      ir('modulos');
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
  }, [sair, voltarInicio]);

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

  const mudarBandeja = useCallback(
    (fn: (b: Separado[]) => Separado[]) => {
      if (!modulo) return;
      setBandejas((t) => ({ ...t, [modulo]: fn(t[modulo]) }));
    },
    [modulo],
  );

  const chaveDe = useCallback((m: Modulo) => {
    const atual = chaves.current[m];
    if (atual) return atual;
    const nova = novaChave();
    chaves.current[m] = nova;
    return nova;
  }, []);

  const concluirRetirada = useCallback(
    (j: Json, itens: Separado[], modalidade: Modulo) => {
      const res: ResultadoRetirada = {
        id: texto(j.id),
        numero: texto(j.numero),
        repetido: j.repetido === true,
        itens,
        prazo: null,
        prazoFalhou: false,
        outros: false,
        modalidade: j.modalidade === 'retirada' || j.modalidade === 'emprestimo' ? j.modalidade : modalidade,
      };
      // só agora a chave troca: o servidor confirmou
      chaves.current[modalidade] = null;
      setBandejas((t) => ({ ...t, [modalidade]: [] }));
      setAbertos(null);
      setResultado(res);
      setTela('sucesso');
      void chamar('GET', `/emprestimos/${encodeURIComponent(res.id)}`).then((d) => {
        if (d.velho) return;
        const emp =
          d.ok && d.json.emprestimo && typeof d.json.emprestimo === 'object' ? (d.json.emprestimo as Emprestimo) : null;
        const novo = { ...res };
        if (emp?.prazo) novo.prazo = emp.prazo;
        else novo.prazoFalhou = true;
        if (emp?.modalidade === 'retirada' || emp?.modalidade === 'emprestimo') novo.modalidade = emp.modalidade;
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
          if (reg.length && (assinatura(reg) !== assinatura(itens) || novo.modalidade !== modalidade)) {
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
      modulo,
      ir,
      chamar,
      aguardarLimpeza: () => limpeza.current,
      abrirSessao,
      sair,
      voltarInicio,
      recado,
      geracaoEntrada,
      bandeja: modulo ? bandejas[modulo] : [],
      mudarBandeja,
      chaveDe,
      concluirRetirada,
      resultado,
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
        manterSessao();
      },
      adminAberto,
      setAdminAberto,
      ocupado,
      setOcupado,
      saindo,
      fecharSaindo: () => setSaindo(null),
    }),
    [
      sessao,
      tela,
      modulo,
      ir,
      chamar,
      abrirSessao,
      sair,
      voltarInicio,
      recado,
      geracaoEntrada,
      bandejas,
      mudarBandeja,
      chaveDe,
      concluirRetirada,
      resultado,
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
    ],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}
