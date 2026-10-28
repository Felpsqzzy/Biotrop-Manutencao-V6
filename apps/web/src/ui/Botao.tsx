import type { ButtonHTMLAttributes } from 'react';

export interface BotaoProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** acao = verde BIOTROP (a ação principal da tela); padrao = neutro. */
  variante?: 'padrao' | 'acao';
}

export function Botao({ variante = 'padrao', className = '', type = 'button', ...resto }: BotaoProps) {
  const classe = ['bm-botao', variante === 'acao' ? 'bm-botao--acao' : '', className].filter(Boolean).join(' ');
  return <button type={type} className={classe} {...resto} />;
}
