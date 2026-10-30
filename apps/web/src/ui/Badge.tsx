import type { HTMLAttributes } from 'react';

export type TomBadge = 'neutro' | 'acao' | 'ok' | 'info' | 'aviso' | 'alerta' | 'ruim';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tom?: TomBadge;
}

/** Selo curto (situação, contagem). A cor nunca é a única pista: o texto diz o estado. */
export function Badge({ tom = 'neutro', className = '', ...resto }: BadgeProps) {
  return <span className={['bm-selo', `bm-selo--${tom}`, className].filter(Boolean).join(' ')} {...resto} />;
}
