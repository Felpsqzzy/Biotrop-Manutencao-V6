/**
 * Diálogo e gaveta: camada modal num portal (document.body), com foco preso dentro, Esc fecha, o foco volta para quem
 * abriu e a página de trás não rola. Vidro (backdrop-filter) só na folha; o fundo escurece sem desfoque.
 * Entrada e saída por Motion (opacity/transform, 200 ms); quem pede menos movimento não vê animação (MotionConfig).
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { Icone } from './Icone';
import { MOVIMENTO } from './movimento';

const FOCAVEIS =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface CamadaProps {
  aberto: boolean;
  aoFechar: () => void;
  titulo: string;
  descricao?: ReactNode;
  children: ReactNode;
  rodape?: ReactNode;
  /** false: clicar fora e Esc não fecham (ex.: códigos de recuperação ainda não guardados). */
  fechavel?: boolean;
  tipo: 'dialogo' | 'gaveta';
  className?: string;
}

function Camada({
  aberto,
  aoFechar,
  titulo,
  descricao,
  children,
  rodape,
  fechavel = true,
  tipo,
  className,
}: CamadaProps) {
  const idTitulo = useId();
  const idDesc = useId();
  const folha = useRef<HTMLDivElement>(null);
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;

  useEffect(() => {
    if (!aberto) return;
    const antes = document.activeElement as HTMLElement | null;
    const raiz = document.documentElement;
    const overflow = raiz.style.overflow;
    raiz.style.overflow = 'hidden';
    const primeiro = folha.current?.querySelector<HTMLElement>('[data-autofocus]') ?? folha.current;
    primeiro?.focus();
    return () => {
      raiz.style.overflow = overflow;
      antes?.focus?.();
    };
  }, [aberto]);

  function teclar(e: KeyboardEvent) {
    if (e.key === 'Escape' && fechavel) {
      e.stopPropagation();
      fechar.current();
      return;
    }
    if (e.key !== 'Tab' || !folha.current) return;
    const itens = [...folha.current.querySelectorAll<HTMLElement>(FOCAVEIS)];
    const primeiro = itens[0];
    const ultimo = itens[itens.length - 1];
    if (!primeiro || !ultimo) {
      e.preventDefault();
      return;
    }
    if (e.shiftKey && (document.activeElement === primeiro || document.activeElement === folha.current)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  }

  const gaveta = tipo === 'gaveta';
  return createPortal(
    <AnimatePresence>
      {aberto && (
        <m.div
          key="camada"
          className={gaveta ? 'bm-camada bm-camada--gaveta' : 'bm-camada'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: MOVIMENTO.medio, ease: MOVIMENTO.curva }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && fechavel) fechar.current();
          }}
          onKeyDown={teclar}
        >
          <m.div
            ref={folha}
            role="dialog"
            aria-modal="true"
            aria-labelledby={idTitulo}
            aria-describedby={descricao ? idDesc : undefined}
            tabIndex={-1}
            className={['bm-vidro', gaveta ? 'bm-gaveta' : 'bm-dialogo', className].filter(Boolean).join(' ')}
            initial={gaveta ? { x: '-100%' } : { opacity: 0, y: 12, scale: 0.98 }}
            animate={gaveta ? { x: 0 } : { opacity: 1, y: 0, scale: 1 }}
            exit={gaveta ? { x: '-100%' } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: MOVIMENTO.lento, ease: MOVIMENTO.curva }}
          >
            <header className="bm-dialogo__cabeca">
              <h2 id={idTitulo} className="bm-dialogo__titulo">
                {titulo}
              </h2>
              {fechavel && (
                <button type="button" className="bm-icone-botao" aria-label="Fechar" onClick={() => fechar.current()}>
                  <Icone nome="fechar" />
                </button>
              )}
            </header>
            {descricao && (
              <p id={idDesc} className="bm-dialogo__desc">
                {descricao}
              </p>
            )}
            <div className="bm-dialogo__corpo">{children}</div>
            {rodape && <footer className="bm-dialogo__rodape">{rodape}</footer>}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export interface DialogProps extends Omit<CamadaProps, 'tipo'> {
  largo?: boolean;
}

export function Dialog({ largo, className, ...p }: DialogProps) {
  return <Camada tipo="dialogo" className={[largo ? 'bm-dialogo--largo' : '', className].join(' ')} {...p} />;
}

export type DrawerProps = Omit<CamadaProps, 'tipo'>;

/** Gaveta lateral (menu do celular). */
export function Drawer(p: DrawerProps) {
  return <Camada tipo="gaveta" {...p} />;
}
