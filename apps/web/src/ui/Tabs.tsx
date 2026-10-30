/**
 * Abas (padrão WAI-ARIA): setas esquerda/direita, Home e End trocam a aba; só a aba ativa entra no Tab.
 * Também serve de seletor segmentado (ex.: período 7/30/90) com `semPainel`.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface Aba<T extends string = string> {
  id: T;
  rotulo: ReactNode;
}

export interface TabsProps<T extends string = string> {
  abas: readonly Aba<T>[];
  ativa: T;
  aoTrocar: (id: T) => void;
  rotulo: string;
  /** Conteúdo da aba ativa (painel). Sem ele, as abas funcionam como seletor. */
  children?: ReactNode;
  className?: string;
}

export function Tabs<T extends string>({ abas, ativa, aoTrocar, rotulo, children, className = '' }: TabsProps<T>) {
  const base = useId();
  const lista = useRef<HTMLDivElement>(null);

  function teclar(e: KeyboardEvent<HTMLDivElement>) {
    const i = abas.findIndex((a) => a.id === ativa);
    const alvo =
      e.key === 'ArrowRight'
        ? (i + 1) % abas.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + abas.length) % abas.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? abas.length - 1
              : -1;
    const aba = abas[alvo];
    if (!aba) return;
    e.preventDefault();
    aoTrocar(aba.id);
    lista.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[alvo]?.focus();
  }

  return (
    <div className={className}>
      <div ref={lista} role="tablist" aria-label={rotulo} className="bm-abas" onKeyDown={teclar}>
        {abas.map((a) => {
          const sel = a.id === ativa;
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              id={`${base}-${a.id}`}
              aria-selected={sel}
              aria-controls={children ? `${base}-painel` : undefined}
              tabIndex={sel ? 0 : -1}
              className="bm-abas__aba"
              onClick={() => aoTrocar(a.id)}
            >
              {a.rotulo}
            </button>
          );
        })}
      </div>
      {children && (
        <div role="tabpanel" id={`${base}-painel`} aria-labelledby={`${base}-${ativa}`} className="bm-abas__painel">
          {children}
        </div>
      )}
    </div>
  );
}
