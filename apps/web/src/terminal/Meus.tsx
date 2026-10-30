/**
 * Meus empréstimos (EM: em aberto e histórico) e Minhas retiradas (RM: aguardando baixa e baixadas). A API devolve até
 * 200 registros; passou disso ("cortado"), a tela avisa que os mais antigos ficaram de fora. Mais de 100 na aba, a
 * lista é virtualizada (só os registros à vista vão para o DOM).
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Badge, Botao, EmptyState, Icone, type TomBadge } from '../ui';
import { erroDe, lista } from './api';
import { CabecalhoTela, Carregando, Segmento, useMargemLista } from './comum';
import { LinhaPrazo } from './Devolver';
import { useTerminal } from './estado';
import { IconeTm } from './icones';
import { aberto, dataHora, devolviveis, ehRM, estadoItem, plural, textoStatus, tomStatus } from './regras';
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

function Registro({ e, aoDevolver }: { e: Emprestimo; aoDevolver?: () => void }) {
  const rm = ehRM(e);
  return (
    <article className="bm-painel tm-registro" aria-label={e.numero}>
      <div className="tm-registro__cabeca">
        <Badge tom={rm ? 'info' : 'acao'}>{rm ? 'RM' : 'EM'}</Badge>
        <b>{e.numero}</b>
        <Badge tom={TOM[tomStatus(e)]}>{textoStatus(e)}</Badge>
        <small>{dataHora(e.criadoEm)}</small>
      </div>
      {!rm && aberto(e) && <LinhaPrazo e={e} />}
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
  const { modulo, chamar, ir, setDev } = useTerminal();
  const rm = modulo === 'retirada';
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

  const doModulo = (rows ?? []).filter((e) => ehRM(e) === rm);
  const abertos = doModulo.filter(aberto);
  const fechados = doModulo.filter((e) => !aberto(e));
  const mostrados = aba === 'abertos' ? abertos : fechados;
  const registro = (e: Emprestimo) => (
    <Registro
      e={e}
      aoDevolver={
        !rm && aberto(e) && devolviveis(e).length
          ? () => {
              setDev({ id: e.id, sel: {}, de: 'meus' });
              ir('devolver-itens');
            }
          : undefined
      }
    />
  );
  const rotulos = rm
    ? { abertos: 'Aguardando baixa', fechados: 'Baixadas' }
    : { abertos: 'Em aberto', fechados: 'Histórico' };

  return (
    <section className="tm-tela">
      <div ref={acima} className="tm-tela__topo">
        <CabecalhoTela
          titulo={rm ? 'Minhas retiradas' : 'Meus empréstimos'}
          sub={rm ? 'Retiradas (RM) não voltam: o almoxarifado dá a baixa.' : 'Prazos e o que ainda está com você.'}
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
          titulo={
            aba === 'abertos'
              ? rm
                ? 'Nenhuma retirada aguardando baixa'
                : 'Nenhum empréstimo em aberto'
              : rm
                ? 'Nenhuma retirada baixada ainda'
                : 'Nada no histórico ainda'
          }
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
