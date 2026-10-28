import type { HTMLAttributes } from 'react';

export interface SuperficieProps extends HTMLAttributes<HTMLElement> {
  /**
   * vidro = backdrop-filter. SÓ para as superfícies fixas (menu, topo, gaveta, Manutinho, diálogo e no máximo um
   * painel por tela). Item repetido (linha, cartão de lista) usa o padrão, sem desfoque. Ver src/ui/README.md.
   */
  vidro?: boolean;
  como?: 'section' | 'div' | 'aside' | 'header' | 'nav';
}

export function Superficie({ vidro = false, como: Tag = 'section', className = '', ...resto }: SuperficieProps) {
  const classe = [vidro ? 'bm-vidro' : 'bm-painel', className].filter(Boolean).join(' ');
  return <Tag className={classe} {...resto} />;
}
