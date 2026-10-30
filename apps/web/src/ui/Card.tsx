/**
 * Cartão (bm-cartao): painel comum, SEM desfoque (vale para item repetido). GlassPanel é o único com vidro, no máximo
 * um por tela. Cabeçalho opcional com ícone, título, subtítulo e uma ação à direita (link "Abrir", seletor etc.).
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { Icone, type NomeIcone } from './Icone';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  titulo?: ReactNode;
  subtitulo?: ReactNode;
  icone?: NomeIcone;
  acao?: ReactNode;
  como?: 'section' | 'article' | 'div';
}

export function Card({
  titulo,
  subtitulo,
  icone,
  acao,
  como: Tag = 'section',
  className = '',
  children,
  ...resto
}: CardProps) {
  return (
    <Tag className={['bm-painel bm-cartao', className].filter(Boolean).join(' ')} {...resto}>
      {(titulo || acao) && (
        <header className="bm-cartao__cabeca">
          {icone && (
            <span className="bm-cartao__icone">
              <Icone nome={icone} tamanho={16} />
            </span>
          )}
          <div className="bm-cartao__titulos">
            {titulo && <h2 className="bm-cartao__titulo">{titulo}</h2>}
            {subtitulo && <p className="bm-cartao__sub">{subtitulo}</p>}
          </div>
          {acao && <div className="bm-cartao__acao">{acao}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}

export interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  como?: 'section' | 'div' | 'header';
}

/** Painel de vidro (backdrop-filter): NO MÁXIMO UM por tela, nunca em lista. Ver src/ui/README.md. */
export function GlassPanel({ como: Tag = 'section', className = '', ...resto }: GlassPanelProps) {
  return <Tag className={['bm-vidro bm-vidro-painel', className].filter(Boolean).join(' ')} {...resto} />;
}
