/** Abas acessíveis (tablist, setas esquerda/direita). Simples e local ao módulo. */
import { useRef, type KeyboardEvent } from 'react';

export interface AbaManutinho<T extends string> {
  id: T;
  rotulo: string;
  contador?: number;
}

export function Abas<T extends string>({
  abas,
  atual,
  onTrocar,
  idBase,
}: {
  abas: AbaManutinho<T>[];
  atual: T;
  onTrocar: (id: T) => void;
  idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function teclado(e: KeyboardEvent, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + abas.length) % abas.length;
    const alvo = abas[n];
    if (!alvo) return;
    onTrocar(alvo.id);
    refs.current[n]?.focus();
  }
  return (
    <div role="tablist" aria-label="Seções do Manutinho" className="manu-abas">
      {abas.map((a, i) => (
        <button
          key={a.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-aba-${a.id}`}
          aria-selected={a.id === atual}
          aria-controls={`${idBase}-painel-${a.id}`}
          tabIndex={a.id === atual ? 0 : -1}
          className="manu-aba"
          onClick={() => onTrocar(a.id)}
          onKeyDown={(e) => teclado(e, i)}
        >
          {a.rotulo}
          {a.contador ? <span className="manu-aba-contador">{a.contador}</span> : null}
        </button>
      ))}
    </div>
  );
}
