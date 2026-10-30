/**
 * Tabelas. Table: semântica (<table>), para listas curtas. VirtualTable: mais de 100 linhas, só desenha o que aparece
 * (@tanstack/react-virtual), com papéis ARIA de tabela. As duas usam as mesmas colunas.
 */
import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface Coluna<L> {
  chave: string;
  titulo: ReactNode;
  /** Conteúdo da célula; sem ele, mostra linha[chave]. */
  render?: (linha: L) => ReactNode;
  alinhar?: 'esquerda' | 'direita' | 'centro';
  /** Largura na VirtualTable (grid), ex.: '2fr', '120px'. Padrão 1fr. */
  largura?: string;
}

export interface TableProps<L> {
  colunas: Coluna<L>[];
  linhas: readonly L[];
  chaveLinha: (linha: L) => string;
  rotulo: string;
  vazio?: ReactNode;
}

function celula<L>(c: Coluna<L>, l: L): ReactNode {
  return c.render ? c.render(l) : String((l as Record<string, unknown>)[c.chave] ?? '');
}
const alinhamento = (a?: Coluna<unknown>['alinhar']) =>
  a === 'direita' ? 'bm-tabela__dir' : a === 'centro' ? 'bm-tabela__centro' : undefined;

export function Table<L>({ colunas, linhas, chaveLinha, rotulo, vazio }: TableProps<L>) {
  if (!linhas.length && vazio) return <>{vazio}</>;
  return (
    <div className="bm-tabela-rolagem">
      <table className="bm-tabela" aria-label={rotulo}>
        <thead>
          <tr>
            {colunas.map((c) => (
              <th key={c.chave} scope="col" className={alinhamento(c.alinhar)}>
                {c.titulo}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={chaveLinha(l)}>
              {colunas.map((c) => (
                <td key={c.chave} className={alinhamento(c.alinhar)}>
                  {celula(c, l)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface VirtualTableProps<L> extends TableProps<L> {
  /** Altura da área rolável (CSS). */
  altura?: string;
  alturaLinha?: number;
}

export function VirtualTable<L>({
  colunas,
  linhas,
  chaveLinha,
  rotulo,
  vazio,
  altura = '480px',
  alturaLinha = 44,
}: VirtualTableProps<L>) {
  const rolagem = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: linhas.length,
    getScrollElement: () => rolagem.current,
    estimateSize: () => alturaLinha,
    overscan: 8,
    // sem medida (teste, primeira pintura): supõe uma área visível, para não começar vazio
    initialRect: { width: 800, height: 480 },
  });
  if (!linhas.length && vazio) return <>{vazio}</>;
  const grade = colunas.map((c) => c.largura ?? 'minmax(0,1fr)').join(' ');
  return (
    <div
      ref={rolagem}
      className="bm-tabela-virtual"
      style={{ height: altura }}
      role="table"
      aria-label={rotulo}
      aria-rowcount={linhas.length + 1}
    >
      <div role="rowgroup" className="bm-tabela-virtual__cabeca">
        <div role="row" aria-rowindex={1} className="bm-tabela-virtual__linha" style={{ gridTemplateColumns: grade }}>
          {colunas.map((c) => (
            <div key={c.chave} role="columnheader" className={alinhamento(c.alinhar)}>
              {c.titulo}
            </div>
          ))}
        </div>
      </div>
      <div role="rowgroup" style={{ height: virt.getTotalSize(), position: 'relative' }}>
        {virt.getVirtualItems().map((v) => {
          const l = linhas[v.index] as L;
          return (
            <div
              key={chaveLinha(l)}
              role="row"
              aria-rowindex={v.index + 2}
              className="bm-tabela-virtual__linha bm-tabela-virtual__linha--corpo"
              style={{ gridTemplateColumns: grade, height: v.size, transform: `translateY(${v.start}px)` }}
            >
              {colunas.map((c) => (
                <div key={c.chave} role="cell" className={alinhamento(c.alinhar)}>
                  {celula(c, l)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
