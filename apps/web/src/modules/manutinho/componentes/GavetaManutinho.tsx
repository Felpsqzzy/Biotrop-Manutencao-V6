/**
 * Gaveta lateral do Manutinho: a ÚNICA superfície com desfoque deste módulo (bm-vidro). Abre e fecha só com transform e
 * opacity (200 ms); o fundo escurece sem desfoque. Esc ou clique fora fecha; o foco vai para o botão de fechar ao abrir.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';

const DURACAO = 0.2;
const CURVA = [0.22, 1, 0.36, 1] as const;

export function GavetaManutinho({
  aberta,
  onFechar,
  titulo,
  children,
}: {
  aberta: boolean;
  onFechar: () => void;
  titulo: string;
  children: ReactNode;
}) {
  const fechar = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!aberta) return;
    fechar.current?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFechar();
    };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, [aberta, onFechar]);

  return (
    <AnimatePresence>
      {aberta ? (
        <div className="manu-camada">
          <m.div
            className="manu-fundo"
            aria-hidden="true"
            onClick={onFechar}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURACAO }}
          />
          <m.aside
            role="dialog"
            aria-modal="true"
            aria-label={titulo}
            className="bm-vidro manu-gaveta"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: DURACAO, ease: CURVA }}
          >
            <header className="manu-gaveta-topo">
              <h2 className="manu-h2">{titulo}</h2>
              <button
                ref={fechar}
                type="button"
                className="bm-botao"
                onClick={onFechar}
                aria-label="Fechar o Manutinho"
              >
                Fechar
              </button>
            </header>
            <div className="manu-gaveta-corpo">{children}</div>
          </m.aside>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
