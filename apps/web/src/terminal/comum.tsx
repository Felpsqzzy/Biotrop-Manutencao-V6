// Peças pequenas usadas por várias telas do terminal: cabeçalho, contador − n +, check desenhado e a trava de toque.
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { m } from 'motion/react';
import { Icone, MOVIMENTO } from '../ui';
import { IconeTm } from './icones';
import { num } from './regras';

/** Tela de fim recém-aberta: o 2º toque de um toque duplo em "Confirmar" cairia no botão do mesmo lugar. */
export const TOQUE_FIM_MS = 700;

/** Envolve um clique: nos primeiros 700 ms da tela, o toque é ignorado. */
export function useToqueProtegido() {
  const desde = useRef(Date.now());
  return useCallback(
    (fn: () => void) => () => {
      if (Date.now() - desde.current < TOQUE_FIM_MS) return;
      fn();
    },
    [],
  );
}

export function CabecalhoTela({
  titulo,
  sub,
  voltar,
  extra,
  bloqueado,
}: {
  titulo: string;
  sub?: ReactNode;
  voltar?: () => void;
  extra?: ReactNode;
  /** Envio em andamento: o Voltar fica desligado. */
  bloqueado?: boolean;
}) {
  return (
    <div className="tm-cabecalho">
      {voltar && (
        <button type="button" className="tm-voltar" disabled={bloqueado} onClick={voltar}>
          <Icone nome="esquerda" tamanho={22} /> Voltar
        </button>
      )}
      <div className="tm-cabecalho__textos">
        <h1 className="tm-titulo">{titulo}</h1>
        {sub && <p className="tm-sub">{sub}</p>}
      </div>
      {extra && <div className="tm-cabecalho__extra">{extra}</div>}
    </div>
  );
}

export function Contador({
  valor,
  rotulo,
  aoMenos,
  aoMais,
  podeMais,
}: {
  valor: number;
  rotulo: string;
  aoMenos: () => void;
  aoMais: () => void;
  podeMais: boolean;
}) {
  return (
    <div className="tm-contador" role="group" aria-label={`Quantidade de ${rotulo}`}>
      <button type="button" className="tm-contador__botao" aria-label={`Tirar um de ${rotulo}`} onClick={aoMenos}>
        <IconeTm nome="menos" tamanho={22} />
      </button>
      <m.output
        key={valor}
        className="tm-contador__valor"
        aria-live="polite"
        initial={{ scale: 1.35, opacity: 0.6 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: MOVIMENTO.medio, ease: MOVIMENTO.curva }}
      >
        {num(valor)}
      </m.output>
      <button
        type="button"
        className="tm-contador__botao"
        aria-label={`Mais um de ${rotulo}`}
        disabled={!podeMais}
        onClick={aoMais}
      >
        <IconeTm nome="mais" tamanho={22} />
      </button>
    </div>
  );
}

/** Círculo e check desenhados (pathLength), só na confirmação. */
export function CheckDesenhado() {
  return (
    <svg className="tm-check" viewBox="0 0 96 96" width="96" height="96" aria-hidden="true" focusable="false">
      <m.circle
        cx="48"
        cy="48"
        r="42"
        fill="none"
        strokeWidth="5"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: MOVIMENTO.lento, ease: MOVIMENTO.curva }}
      />
      <m.path
        d="M30 49.5 42.5 62 66 36"
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: MOVIMENTO.lento, delay: MOVIMENTO.medio, ease: MOVIMENTO.curva }}
      />
    </svg>
  );
}

export function Carregando({ texto = 'Carregando…' }: { texto?: string }) {
  return (
    <p className="tm-carregando" role="status">
      <span className="tm-giro" aria-hidden="true" /> {texto}
    </p>
  );
}

/** Botões alternáveis (um ligado por vez): vista, condição, abas do histórico. */
export function Segmento<T extends string>({
  rotulo,
  valor,
  opcoes,
  aoMudar,
  compacto,
}: {
  rotulo: string;
  valor: T;
  opcoes: { id: T; texto: string; icone?: ReactNode }[];
  aoMudar: (v: T) => void;
  compacto?: boolean;
}) {
  return (
    <div className={`tm-segmento${compacto ? ' tm-segmento--compacto' : ''}`} role="group" aria-label={rotulo}>
      {opcoes.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`tm-segmento__botao${o.id === valor ? ' is-ativo' : ''}`}
          aria-pressed={o.id === valor}
          onClick={() => aoMudar(o.id)}
        >
          {o.icone}
          <span>{o.texto}</span>
        </button>
      ))}
    </div>
  );
}

/** Distância do elemento ao topo do documento pelos offsets (a animação de entrada da tela, um transform, não conta). */
function topoNoDocumento(el: HTMLElement): number {
  let y = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
  return y;
}

/**
 * scrollMargin de uma lista virtualizada na rolagem da página: medido na montagem e de novo sempre que a área acima
 * dela muda de altura (ResizeObserver no elemento acima: chips que aparecem ou somem, faixa de aviso).
 */
export function useMargemLista(lista: RefObject<HTMLElement | null>, acima: RefObject<HTMLElement | null>): number {
  const [margem, setMargem] = useState(0);
  useLayoutEffect(() => {
    const medir = () => {
      if (lista.current) setMargem(topoNoDocumento(lista.current));
    };
    medir();
    const alvo = acima.current;
    if (!alvo || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(medir);
    ro.observe(alvo);
    return () => ro.disconnect();
  }, [lista, acima]);
  return margem;
}
