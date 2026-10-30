import type { ReactNode } from 'react';
import { Icone, type NomeIcone } from './Icone';

export interface EmptyStateProps {
  titulo: string;
  texto?: ReactNode;
  icone?: NomeIcone;
  acao?: ReactNode;
  compacto?: boolean;
}

/** Estado vazio claro: diz o que não há e, quando faz sentido, o que fazer. Nunca uma seção em branco. */
export function EmptyState({ titulo, texto, icone = 'info', acao, compacto = false }: EmptyStateProps) {
  return (
    <div className={compacto ? 'bm-vazio bm-vazio--compacto' : 'bm-vazio'} role="status">
      <span className="bm-vazio__icone">
        <Icone nome={icone} tamanho={compacto ? 18 : 22} />
      </span>
      <p className="bm-vazio__titulo">{titulo}</p>
      {texto && <p className="bm-vazio__texto">{texto}</p>}
      {acao && <div className="bm-vazio__acao">{acao}</div>}
    </div>
  );
}

export interface SkeletonProps {
  largura?: string;
  altura?: string;
  className?: string;
}

/** Bloco de carregamento: parado (sem brilho correndo), para não animar nada enquanto espera. */
export function Skeleton({ largura = '100%', altura = '1rem', className = '' }: SkeletonProps) {
  return (
    <span
      className={['bm-esqueleto', className].filter(Boolean).join(' ')}
      style={{ width: largura, height: altura }}
      aria-hidden="true"
    />
  );
}
