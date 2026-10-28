/** Lista de avisos do Manutinho (item repetido: painel sem desfoque). Cada aviso leva à tela onde se resolve. */
import { Link } from 'react-router-dom';
import type { ItemManutinho, NivelManutinho } from '@biomanut/shared';

export const ROTULO_NIVEL: Record<NivelManutinho, string> = {
  critico: 'Crítico',
  atencao: 'Atenção',
  info: 'Informação',
};

export function SeloNivel({ nivel }: { nivel: NivelManutinho }) {
  return <span className={`manu-selo manu-selo--${nivel}`}>{ROTULO_NIVEL[nivel]}</span>;
}

export interface ListaAvisosProps {
  itens: ItemManutinho[];
  /** Mostra no máximo N (o resto vira "e mais N na tela do Manutinho"). */
  limite?: number;
  vazio?: string;
  onNavegar?: () => void;
}

export function ListaAvisos({ itens, limite, vazio = 'Nenhum aviso agora.', onNavegar }: ListaAvisosProps) {
  if (!itens.length) return <p className="manu-vazio">{vazio}</p>;
  const visiveis = limite ? itens.slice(0, limite) : itens;
  return (
    <>
      <ul className="manu-avisos" aria-label="Avisos do Manutinho">
        {visiveis.map((i) => (
          <li key={`${i.modulo}:${i.titulo}`} className={`manu-aviso manu-aviso--${i.nivel}`}>
            <div className="manu-aviso-topo">
              <SeloNivel nivel={i.nivel} />
              <Link to={i.rota} className="manu-aviso-titulo" onClick={onNavegar}>
                {i.titulo}
              </Link>
            </div>
            {i.detalhe ? <p className="manu-aviso-detalhe">{i.detalhe}</p> : null}
          </li>
        ))}
      </ul>
      {limite && itens.length > limite ? (
        <p className="manu-mais">
          e mais {itens.length - limite} {itens.length - limite === 1 ? 'aviso' : 'avisos'}
        </p>
      ) : null}
    </>
  );
}
