/**
 * Meus empréstimos (em aberto e histórico; as retiradas RM antigas aparecem junto, com o selo RM). Cada registro mostra
 * a finalidade, a CAMM e o estado da entrega (dupla confirmação, 49): o que espera o "recebi" leva a "Confirmar
 * recebimento". A API devolve até 200 registros; passou disso ("cortado"), a tela avisa que os mais antigos ficaram de fora. Mais de 100 na aba, a
 * lista é virtualizada (só os registros à vista vão para o DOM).
 * Migration 50: quem entregou (tablet ou site), o recebimento com divergência, as divergências (abertas e resolvidas),
 * a autorização usada e, na conta de terceiro, a pessoa que retirou em cada registro.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Badge, Botao, EmptyState, Icone, type TomBadge } from '../ui';
import { erroDe, lista } from './api';
import { CabecalhoTela, Carregando, Segmento, useMargemLista } from './comum';
import { LinhaPrazo } from './Devolver';
import { useTerminal } from './estado';
import { IconeTm } from './icones';
import {
  aberto,
  dataHora,
  devolviveis,
  ehRM,
  estadoItem,
  pedeRecebimento,
  plural,
  textoEntrega,
  textoFinalidade,
  textoRecebimento,
  textoStatus,
  textoTipoDivergencia,
  tomStatus,
} from './regras';
import type { Emprestimo } from './tipos';

type Aba = 'abertos' | 'fechados';
const LIMITE_VIRTUAL = 100;
const TOM: Record<ReturnType<typeof tomStatus>, TomBadge> = {
  ok: 'ok',
  info: 'info',
  aviso: 'aviso',
  neutro: 'neutro',
  ruim: 'ruim',
};

function Registro({ e, aoDevolver, aoReceber }: { e: Emprestimo; aoDevolver?: () => void; aoReceber?: () => void }) {
  const rm = ehRM(e);
  const meta = [textoFinalidade(e.finalidade, e.finalidadeRef), e.camm].filter(Boolean).join(' · ');
  const entrega = aberto(e) || e.entrega === 'confirmada' ? textoEntrega(e) : '';
  const recebimento = aberto(e) ? textoRecebimento(e) : '';
  const quem = [e.terceiroPessoa && `Retirou: ${e.terceiroPessoa}`, e.autorizacaoNumero].filter(Boolean).join(' · ');
  return (
    <article className="bm-painel tm-registro" aria-label={e.numero}>
      <div className="tm-registro__cabeca">
        <Badge tom={rm ? 'info' : 'acao'}>{rm ? 'RM' : 'EM'}</Badge>
        <b>{e.numero}</b>
        <Badge tom={TOM[tomStatus(e)]}>{textoStatus(e)}</Badge>
        <small>{dataHora(e.criadoEm)}</small>
      </div>
      {!rm && meta && <p className="tm-registro__meta">{meta}</p>}
      {quem && <p className="tm-registro__meta">{quem}</p>}
      {!rm && aberto(e) && <LinhaPrazo e={e} />}
      {!rm && entrega && (
        <p className="tm-prazo tm-prazo--info">
          <Icone nome="info" tamanho={20} /> {entrega}
        </p>
      )}
      {recebimento && (
        <p className="tm-prazo tm-prazo--aviso">
          <Icone nome="alerta" tamanho={20} /> {recebimento}
        </p>
      )}
      {!!e.divergencias?.length && (
        <ul className="tm-registro__lista" aria-label="Divergências">
          {e.divergencias.map((d) => (
            <li key={d.id}>
              <span>
                <b>{textoTipoDivergencia(d.tipo)}</b> {d.descricao}
              </span>
              <small>
                {d.etapa === 'devolucao' ? 'Devolução' : 'Retirada'} · {d.status === 'aberta' ? 'Aberta' : 'Resolvida'}
              </small>
            </li>
          ))}
        </ul>
      )}
      {rm && e.status === 'aguardando_baixa' && (
        <p className="tm-prazo tm-prazo--info">
          <IconeTm nome="saida" tamanho={20} /> Não precisa devolver.
        </p>
      )}
      <ul className="tm-registro__lista">
        {(e.itensLista ?? []).map((i) => (
          <li key={i.id}>
            <span>
              <span className="tm-cod">{i.codigo}</span> {i.descricao}
            </span>
            <small>{estadoItem(i, e)}</small>
          </li>
        ))}
      </ul>
      {aoReceber && (
        <Botao variante="acao" className="tm-botao-grande" onClick={aoReceber}>
          <Icone nome="check" tamanho={22} /> Confirmar recebimento
        </Botao>
      )}
      {aoDevolver && (
        <Botao variante="acao" className="tm-botao-grande" onClick={aoDevolver}>
          <IconeTm nome="devolver" tamanho={22} /> Devolver
        </Botao>
      )}
    </article>
  );
}

/** Mais de 100 registros: só os à vista (rolagem da página; a altura de cada um é medida). */
function RegistrosVirtual({
  itens,
  acima,
  render,
}: {
  itens: Emprestimo[];
  acima: RefObject<HTMLDivElement | null>;
  render: (e: Emprestimo) => ReactNode;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const margem = useMargemLista(ref, acima);
  const v = useWindowVirtualizer({ count: itens.length, estimateSize: () => 220, overscan: 4, scrollMargin: margem });
  return (
    <ul ref={ref} className="tm-linhas tm-virtual" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((linha) => (
        <li
          key={itens[linha.index]!.id}
          data-index={linha.index}
          ref={v.measureElement}
          className="tm-virtual__linha tm-virtual__linha--registro"
          style={{ transform: `translateY(${linha.start - v.options.scrollMargin}px)` }}
        >
          {render(itens[linha.index]!)}
        </li>
      ))}
    </ul>
  );
}

export function TelaMeus() {
  const { chamar, ir, setDev } = useTerminal();
  const [rows, setRows] = useState<Emprestimo[] | null>(null);
  const [cortado, setCortado] = useState(false);
  const [erro, setErro] = useState('');
  const [aba, setAba] = useState<Aba>('abertos');
  const [recarga, setRecarga] = useState(0);
  const seq = useRef(0);
  const acima = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const n = ++seq.current;
    setErro('');
    void chamar('GET', '/emprestimos?situacao=todos').then((r) => {
      if (r.velho || n !== seq.current) return;
      if (!r.ok) return setErro(erroDe(r));
      setRows(lista<Emprestimo>(r.json.rows));
      setCortado(r.json.cortado === true);
    });
  }, [chamar, recarga]);

  const abertos = (rows ?? []).filter(aberto);
  const fechados = (rows ?? []).filter((e) => !aberto(e));
  const mostrados = aba === 'abertos' ? abertos : fechados;
  const registro = (e: Emprestimo) => (
    <Registro
      e={e}
      aoReceber={pedeRecebimento(e) ? () => ir('receber') : undefined}
      aoDevolver={
        aberto(e) && devolviveis(e).length
          ? () => {
              setDev({ id: e.id, sel: {}, de: 'meus', fotos: [] });
              ir('devolver-itens');
            }
          : undefined
      }
    />
  );
  const rotulos = { abertos: 'Em aberto', fechados: 'Histórico' };

  return (
    <section className="tm-tela">
      <div ref={acima} className="tm-tela__topo">
        <CabecalhoTela
          titulo="Meus empréstimos"
          sub="Prazos e o que ainda está com você."
          voltar={() => ir('inicio')}
        />
        <Segmento<Aba>
          rotulo="Mostrar"
          valor={aba}
          aoMudar={setAba}
          opcoes={[
            { id: 'abertos', texto: `${rotulos.abertos}${rows ? ` (${abertos.length})` : ''}` },
            { id: 'fechados', texto: `${rotulos.fechados}${rows ? ` (${fechados.length})` : ''}` },
          ]}
        />
        {cortado && (
          <p className="tm-faixa tm-faixa--aviso" role="status">
            <Icone nome="info" tamanho={20} /> Mostrando só os 200 registros mais recentes. Os mais antigos ficaram de
            fora: peça ao almoxarifado se precisar deles.
          </p>
        )}
      </div>
      {erro ? (
        <EmptyState
          titulo="Não deu para buscar seus registros"
          texto={erro}
          icone="alerta"
          acao={<Botao onClick={() => setRecarga((x) => x + 1)}>Tentar de novo</Botao>}
        />
      ) : !rows ? (
        <Carregando texto="Buscando seus registros…" />
      ) : !mostrados.length ? (
        <EmptyState
          titulo={aba === 'abertos' ? 'Nenhum empréstimo em aberto' : 'Nada no histórico ainda'}
          icone="check"
          compacto
        />
      ) : (
        <>
          <p className="bm-sr" role="status">
            {plural(mostrados.length, 'registro', 'registros')}
          </p>
          {mostrados.length > LIMITE_VIRTUAL ? (
            <RegistrosVirtual key={aba} itens={mostrados} acima={acima} render={registro} />
          ) : (
            <ul className="tm-linhas">
              {mostrados.map((e) => (
                <li key={e.id}>{registro(e)}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
