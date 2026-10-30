/**
 * Indicador: rótulo, valor, o que ele mede (legenda) e a variação contra o período anterior.
 * Valor 0 nunca aparece como número solto: mostra o texto `vazio` ("nenhuma SCM aberta neste período").
 * Valor null = sem dado para calcular (mostra `vazio` também). O número conta de 0 até o valor só na primeira exibição.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icone, type NomeIcone } from './Icone';
import { Sparkline } from './graficos';
import { useContagem } from './useContagem';

export interface Variacao {
  /** Diferença relativa (0,25 = +25%); null quando o período anterior foi 0. */
  relativa: number | null;
  /** Texto curto: "+25% vs. mês anterior", "novo neste período". */
  texto: string;
  /** A mudança é boa para a operação (verde) ou ruim (vermelho); null = neutra. */
  boa: boolean | null;
}

export interface KpiProps {
  /** Chave estável para a contagem só na primeira exibição. */
  id: string;
  rotulo: string;
  valor: number | null;
  /** Formata o número (padrão: inteiro pt-BR). */
  formato?: (n: number) => string;
  legenda: ReactNode;
  vazio: string;
  variacao?: Variacao | null;
  icone: NomeIcone;
  /** Cor de apoio do ícone e da linha (variável CSS). */
  cor?: string;
  serie?: readonly number[];
  para?: string;
}

const inteiro = (n: number) => Math.round(n).toLocaleString('pt-BR');

export function Kpi({
  id,
  rotulo,
  valor,
  formato = inteiro,
  legenda,
  vazio,
  variacao,
  icone,
  cor,
  serie,
  para,
}: KpiProps) {
  const temValor = valor !== null && valor !== 0;
  const mostrado = useContagem(temValor ? valor : 0, id);
  const corpo = (
    <>
      <div className="bm-kpi__topo">
        <span className="bm-kpi__icone" style={cor ? { color: cor } : undefined}>
          <Icone nome={icone} tamanho={16} />
        </span>
        <span className="bm-kpi__rotulo">{rotulo}</span>
      </div>
      {temValor ? (
        <p className="bm-kpi__valor">
          <span className="bm-sr">{formato(valor)}</span>
          <span aria-hidden="true">{formato(mostrado)}</span>
        </p>
      ) : (
        <p className="bm-kpi__vazio">{vazio}</p>
      )}
      <p className="bm-kpi__legenda">{legenda}</p>
      {temValor && variacao && (
        <p
          className={[
            'bm-kpi__variacao',
            variacao.boa === true ? 'bm-kpi__variacao--boa' : variacao.boa === false ? 'bm-kpi__variacao--ruim' : '',
          ].join(' ')}
        >
          {variacao.relativa !== null && variacao.relativa !== 0 && (
            <Icone nome={variacao.relativa > 0 ? 'sobe' : 'desce'} tamanho={13} />
          )}
          {variacao.texto}
        </p>
      )}
      {temValor && serie && serie.some((n) => n > 0) && (
        <Sparkline valores={serie} cor={cor} className="bm-kpi__spark" />
      )}
    </>
  );
  return para ? (
    <Link to={para} className="bm-painel bm-kpi bm-kpi--link">
      {corpo}
    </Link>
  ) : (
    <div className="bm-painel bm-kpi">{corpo}</div>
  );
}
