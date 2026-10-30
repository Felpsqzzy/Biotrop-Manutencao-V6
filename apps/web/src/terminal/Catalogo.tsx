/**
 * Catálogo único (sem "por quantidade" × "por patrimônio" à vista): busca, chips de categoria e peças iguais agrupadas.
 * Um botão por item: "Separar". Por quantidade, cada toque soma um (vira contador − n +); por etiqueta (unidade de
 * patrimônio/série ou peça de um grupo FMNT), "Separar" abre a folha para escolher a etiqueta. Vista em cartões ou em
 * lista (lembrada neste navegador); mais de 100 itens, a lista é virtualizada. Retirada pede ao servidor só os
 * retiráveis (?modalidade=retirada); o servidor manda até 1000 e, passou disso, "cortado" pede para refinar a busca.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual';
import { Badge, Botao, Dialog, EmptyState, Icone, MOVIMENTO, useToast } from '../ui';
import { erroDe, lista } from './api';
import { CabecalhoTela, Carregando, Contador, Segmento, useMargemLista } from './comum';
import { useTerminal } from './estado';
import { iconeCategoria, IconeTm } from './icones';
import {
  agrupar,
  alternarEtiqueta,
  categoriaDe,
  categorias,
  disponivel,
  MAX_ITENS,
  mudarQuantidade,
  num,
  plural,
  resumoEntrada,
  texto,
  totalSeparado,
  type Entrada,
} from './regras';
import type { Ferramenta } from './tipos';

export type Vista = 'cards' | 'lista';
const CHAVE_VISTA = 'tm-vista';
export const LIMITE_VIRTUAL = 100;

export function lerVista(): Vista {
  try {
    return localStorage.getItem(CHAVE_VISTA) === 'lista' ? 'lista' : 'cards';
  } catch {
    return 'cards';
  }
}
function gravarVista(v: Vista) {
  try {
    localStorage.setItem(CHAVE_VISTA, v);
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

/** Etiquetas que dá para escolher na folha: unidades livres (patrimônio/série) ou peças do grupo. */
function opcoesDaFolha(
  e: Entrada,
): { f: Ferramenta; unidade?: { id: string; identificador: string }; rotulo: string; local: string; livre: boolean }[] {
  if (e.tipo === 'grupo')
    return e.itens.map((f) => ({ f, rotulo: f.codigo, local: texto(f.localizacao), livre: disponivel(f) > 0 }));
  return (e.f.unidadesDisponiveis ?? []).map((u) => ({
    f: e.f,
    unidade: u,
    rotulo: u.identificador,
    local: texto(e.f.localizacao),
    livre: true,
  }));
}

type OpcaoFolha = ReturnType<typeof opcoesDaFolha>[number];

function BotaoEtiqueta({ o }: { o: OpcaoFolha }) {
  const { bandeja, mudarBandeja } = useTerminal();
  const toast = useToast();
  const marcado = bandeja.some((x) => x.ferramentaId === o.f.id && (x.unidadeId ?? null) === (o.unidade?.id ?? null));
  return (
    <button
      type="button"
      className={`tm-etiqueta${marcado ? ' is-marcado' : ''}`}
      aria-pressed={marcado}
      disabled={!o.livre && !marcado}
      onClick={() => {
        if (!marcado && bandeja.length >= MAX_ITENS)
          return toast.mostrar({ texto: `Até ${MAX_ITENS} itens por pedido.`, tom: 'ruim' });
        mudarBandeja((b) => alternarEtiqueta(b, o.f, o.unidade));
      }}
    >
      <IconeTm nome="etiqueta" tamanho={22} />
      <span className="tm-etiqueta__textos">
        <b>{o.rotulo}</b>
        <small>{o.livre ? o.local || 'Disponível' : 'Indisponível'}</small>
      </span>
      <span className="tm-etiqueta__marca" aria-hidden="true">
        {marcado && (
          <m.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            <Icone nome="check" tamanho={18} />
          </m.span>
        )}
      </span>
    </button>
  );
}

/** Mais de 100 etiquetas na folha: só as linhas à vista (rolagem da própria grade, dentro do diálogo). */
function EtiquetasVirtual({ opcoes }: { opcoes: OpcaoFolha[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [colunas, setColunas] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const w = e?.contentRect.width ?? 0;
      setColunas(Math.max(1, Math.floor((w + 8) / (200 + 8))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const v = useVirtualizer({
    count: Math.ceil(opcoes.length / colunas),
    getScrollElement: () => ref.current,
    estimateSize: () => 72,
    overscan: 4,
    initialRect: { width: 600, height: 440 },
  });
  return (
    <div ref={ref} className="tm-etiquetas tm-etiquetas--virtual">
      <ul className="tm-virtual" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((linha) => (
          <li
            key={linha.key}
            data-index={linha.index}
            ref={v.measureElement}
            className="tm-virtual__linha tm-etiquetas__linha"
            style={{
              transform: `translateY(${linha.start}px)`,
              gridTemplateColumns: `repeat(${colunas}, minmax(0, 1fr))`,
            }}
          >
            {opcoes.slice(linha.index * colunas, linha.index * colunas + colunas).map((o) => (
              <BotaoEtiqueta key={o.unidade?.id ?? o.f.id} o={o} />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FolhaEtiqueta({ entrada, aoFechar }: { entrada: Entrada | null; aoFechar: () => void }) {
  const { bandeja } = useTerminal();
  const nome = entrada ? (entrada.tipo === 'grupo' ? entrada.nome : entrada.f.nome) : '';
  const opcoes = entrada ? opcoesDaFolha(entrada) : [];
  const n = entrada ? resumoEntrada(entrada, bandeja).separados : 0;
  return (
    <Dialog
      aberto={!!entrada}
      aoFechar={aoFechar}
      titulo={nome}
      descricao="Escolha pela etiqueta da peça (patrimônio, série ou código)."
      className="tm-folha"
      rodape={
        <Botao variante="acao" className="tm-botao-grande" onClick={aoFechar}>
          <Icone nome="check" tamanho={22} /> {n ? `Pronto · ${plural(n, 'separada', 'separadas')}` : 'Pronto'}
        </Botao>
      }
    >
      {opcoes.length === 0 ? (
        <EmptyState titulo="Nenhuma unidade livre agora" texto="Todas estão emprestadas ou em conferência." compacto />
      ) : opcoes.length > LIMITE_VIRTUAL ? (
        <EtiquetasVirtual opcoes={opcoes} />
      ) : (
        <ul className="tm-etiquetas">
          {opcoes.map((o) => (
            <li key={o.unidade?.id ?? o.f.id}>
              <BotaoEtiqueta o={o} />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function ItemCatalogo({
  entrada,
  vista,
  indice,
  animar,
  aoEtiqueta,
}: {
  entrada: Entrada;
  vista: Vista;
  indice: number;
  animar: boolean;
  aoEtiqueta: (e: Entrada) => void;
}) {
  const { bandeja, mudarBandeja } = useTerminal();
  const toast = useToast();
  const r = resumoEntrada(entrada, bandeja);
  const f = entrada.tipo === 'unica' ? entrada.f : null;
  const separado = r.separados > 0;
  const cheio = () => {
    toast.mostrar({ texto: `Até ${MAX_ITENS} itens por pedido.`, tom: 'ruim' });
  };
  const somar = () => {
    if (r.porEtiqueta) return aoEtiqueta(entrada);
    if (!f) return;
    if (!separado && bandeja.length >= MAX_ITENS) return cheio();
    mudarBandeja((b) => mudarQuantidade(b, f, 1));
  };
  const tirar = () => {
    if (r.porEtiqueta) {
      const ids = entrada.tipo === 'grupo' ? entrada.itens.map((x) => x.id) : [entrada.f.id];
      mudarBandeja((b) => {
        let ultimo = -1;
        b.forEach((x, k) => {
          if (ids.includes(x.ferramentaId)) ultimo = k;
        });
        return ultimo < 0 ? b : b.filter((_, k) => k !== ultimo);
      });
      return;
    }
    if (f) mudarBandeja((b) => mudarQuantidade(b, f, -1));
  };
  const livresTxt = r.porEtiqueta
    ? entrada.tipo === 'grupo'
      ? `${num(r.livres)} de ${r.codigo} livres`
      : plural(r.livres, 'unidade livre', 'unidades livres')
    : `${num(r.livres)} disponíveis`;
  const Raiz = animar ? m.article : 'article';
  const anim = animar
    ? {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: MOVIMENTO.medio, delay: Math.min(indice, 10) * 0.025, ease: MOVIMENTO.curva },
      }
    : {};
  return (
    <Raiz
      className={`bm-painel tm-item tm-item--${vista}${separado ? ' is-separado' : ''}${r.livres <= 0 && !separado ? ' is-indisponivel' : ''}`}
      aria-label={r.nome}
      {...anim}
    >
      <span className="tm-item__icone" aria-hidden="true">
        <IconeTm nome={iconeCategoria(r.categoria)} tamanho={vista === 'cards' ? 30 : 24} />
      </span>
      <div className="tm-item__textos">
        <div className="tm-item__linha">
          <span className="tm-cod">{r.codigo}</span>
          {separado && (
            <Badge tom="acao" className="tm-item__selo">
              <IconeTm nome="separado" tamanho={14} /> Separado
            </Badge>
          )}
        </div>
        <h3 className="tm-item__nome">{r.nome}</h3>
        <p className="tm-item__meta">
          <span className={r.livres > 0 ? 'tm-item__livres' : 'tm-item__livres is-zero'}>{livresTxt}</span>
          {r.local && (
            <span className="tm-item__local">
              <IconeTm nome="local" tamanho={15} /> {r.local}
            </span>
          )}
        </p>
      </div>
      <div className="tm-item__acao">
        {separado ? (
          <Contador
            valor={r.separados}
            rotulo={r.nome}
            aoMenos={tirar}
            aoMais={somar}
            podeMais={r.separados < r.livres}
          />
        ) : (
          <Botao variante="acao" className="tm-separar" disabled={r.livres <= 0} onClick={somar}>
            {r.livres > 0 ? (
              <>
                <IconeTm nome="separar" tamanho={20} /> Separar
              </>
            ) : (
              'Indisponível'
            )}
          </Botao>
        )}
      </div>
    </Raiz>
  );
}

/** Mais de 100 itens: só as linhas à vista vão para o DOM (rolagem da própria página). */
function ListaVirtual({
  entradas,
  vista,
  acima,
  aoEtiqueta,
}: {
  entradas: Entrada[];
  vista: Vista;
  acima: RefObject<HTMLDivElement | null>;
  aoEtiqueta: (e: Entrada) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const margem = useMargemLista(ref, acima);
  const [colunas, setColunas] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (vista !== 'cards' || typeof ResizeObserver === 'undefined') return setColunas(1);
    const ro = new ResizeObserver(([e]) => {
      const w = e?.contentRect.width ?? 0;
      setColunas(Math.max(1, Math.floor((w + 14) / (230 + 14))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [vista]);
  const linhas = Math.ceil(entradas.length / colunas);
  const v = useWindowVirtualizer({
    count: linhas,
    estimateSize: () => (vista === 'cards' ? 236 : 104),
    overscan: 4,
    scrollMargin: margem,
  });
  return (
    <div ref={ref} className="tm-virtual" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((linha) => (
        <div
          key={linha.key}
          data-index={linha.index}
          ref={v.measureElement}
          className={vista === 'cards' ? 'tm-virtual__linha tm-grade' : 'tm-virtual__linha tm-lista'}
          style={{
            transform: `translateY(${linha.start - v.options.scrollMargin}px)`,
            gridTemplateColumns: vista === 'cards' ? `repeat(${colunas}, minmax(0, 1fr))` : undefined,
          }}
        >
          {entradas.slice(linha.index * colunas, linha.index * colunas + colunas).map((e) => (
            <ItemCatalogo key={e.chave} entrada={e} vista={vista} indice={0} animar={false} aoEtiqueta={aoEtiqueta} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function TelaCatalogo() {
  const { modulo, chamar, ir } = useTerminal();
  const rm = modulo === 'retirada';
  const [busca, setBusca] = useState('');
  const [cat, setCat] = useState('');
  const [rows, setRows] = useState<Ferramenta[] | null>(null);
  const [cortado, setCortado] = useState(false);
  const [erro, setErro] = useState('');
  const acima = useRef<HTMLDivElement>(null);
  const [vista, setVista] = useState<Vista>(lerVista);
  const [folha, setFolha] = useState<Entrada | null>(null);
  const seq = useRef(0);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    const n = ++seq.current;
    const q = texto(busca).slice(0, 80);
    const t = setTimeout(
      () => {
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        if (rm) p.set('modalidade', 'retirada');
        const qs = p.toString();
        void chamar('GET', `/ferramentas${qs ? `?${qs}` : ''}`).then((r) => {
          if (r.velho || n !== seq.current) return;
          if (!r.ok) return setErro(erroDe(r));
          setErro('');
          setRows(lista<Ferramenta>(r.json.rows));
          setCortado(r.json.cortado === true);
        });
      },
      q ? 300 : 0,
    );
    return () => clearTimeout(t);
  }, [busca, chamar, recarga, rm]);

  // Retirada (RM): o servidor já manda só o que foi liberado para sair do estoque (filtro no banco, antes do limite)
  const visiveis = useMemo(() => rows ?? [], [rows]);
  const cats = useMemo(() => categorias(visiveis), [visiveis]);
  const entradas = useMemo(
    () => agrupar(cat ? visiveis.filter((f) => categoriaDe(f) === cat) : visiveis),
    [visiveis, cat],
  );
  // a folha acompanha a lista nova (unidades livres mudam depois de uma busca)
  const folhaAtual = folha ? (entradas.find((e) => e.chave === folha.chave) ?? folha) : null;

  function mudarVista(v: Vista) {
    setVista(v);
    gravarVista(v);
  }

  const virtual = entradas.length > LIMITE_VIRTUAL;
  return (
    <section className="tm-tela tm-catalogo">
      <div ref={acima} className="tm-catalogo__topo">
        <CabecalhoTela
          titulo={rm ? 'Retirar' : 'Pegar ferramentas'}
          sub={
            rm
              ? 'Só aparecem os itens liberados para retirada. Eles não voltam ao almoxarifado.'
              : 'Toque em Separar. Depois, revise e confirme o empréstimo.'
          }
          voltar={() => ir('inicio')}
          extra={
            <Segmento<Vista>
              rotulo="Mostrar como"
              valor={vista}
              aoMudar={mudarVista}
              compacto
              opcoes={[
                { id: 'cards', texto: 'Cartões', icone: <IconeTm nome="grade" tamanho={20} /> },
                { id: 'lista', texto: 'Lista', icone: <IconeTm nome="lista" tamanho={20} /> },
              ]}
            />
          }
        />
        <div className="tm-busca">
          <Icone nome="buscar" tamanho={22} />
          <input
            type="search"
            className="tm-busca__campo"
            placeholder={rm ? 'Buscar item para retirar' : 'Buscar por nome ou código'}
            aria-label="Buscar ferramenta"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={80}
            value={busca}
            onChange={(e) => setBusca(e.currentTarget.value)}
          />
          {busca && (
            <button type="button" className="tm-busca__limpar" aria-label="Limpar a busca" onClick={() => setBusca('')}>
              <Icone nome="fechar" tamanho={20} />
            </button>
          )}
        </div>
        {cats.length > 1 && (
          <div className="tm-chips" role="group" aria-label="Categorias">
            <button
              type="button"
              className={`tm-chip${!cat ? ' is-ativo' : ''}`}
              aria-pressed={!cat}
              onClick={() => setCat('')}
            >
              Todas <small>{num(visiveis.length)}</small>
            </button>
            {cats.map(([c, n]) => (
              <button
                key={c}
                type="button"
                className={`tm-chip${cat === c ? ' is-ativo' : ''}`}
                aria-pressed={cat === c}
                onClick={() => setCat(cat === c ? '' : c)}
              >
                <IconeTm nome={iconeCategoria(c)} tamanho={16} /> {c} <small>{num(n)}</small>
              </button>
            ))}
          </div>
        )}
        {cortado && !erro && (
          <p className="tm-faixa tm-faixa--aviso" role="status">
            <Icone nome="info" tamanho={20} /> Muitos itens: refine a busca. Aparecem só os primeiros{' '}
            {num(visiveis.length)}.
          </p>
        )}
      </div>
      {erro ? (
        <EmptyState
          titulo="Não deu para buscar as ferramentas"
          texto={erro}
          icone="alerta"
          acao={<Botao onClick={() => setRecarga((n) => n + 1)}>Tentar de novo</Botao>}
        />
      ) : rows === null ? (
        <Carregando texto="Buscando as ferramentas…" />
      ) : entradas.length === 0 ? (
        rm && !busca && !cat ? (
          <EmptyState
            titulo="Nenhum item liberado para retirada agora"
            texto="Para levar e devolver depois, use o Empréstimo."
            acao={<Botao onClick={() => ir('catalogo', 'emprestimo')}>Fazer um empréstimo</Botao>}
          />
        ) : (
          <EmptyState
            titulo="Nada encontrado"
            texto={busca ? `Nenhum item com "${texto(busca)}".` : 'Nenhum item nesta categoria.'}
            icone="buscar"
          />
        )
      ) : virtual ? (
        <ListaVirtual key={vista} entradas={entradas} vista={vista} acima={acima} aoEtiqueta={setFolha} />
      ) : (
        <div className={vista === 'cards' ? 'tm-grade' : 'tm-lista'}>
          {entradas.map((e, i) => (
            <ItemCatalogo key={e.chave} entrada={e} vista={vista} indice={i} animar aoEtiqueta={setFolha} />
          ))}
        </div>
      )}
      <FolhaEtiqueta entrada={folhaAtual} aoFechar={() => setFolha(null)} />
    </section>
  );
}

/** Bandeja fixa embaixo: "N itens separados · Revisar". Fora do contêiner animado da tela (position: fixed). */
export function Bandeja() {
  const { bandeja, ir, tela, modulo } = useTerminal();
  const visivel = tela === 'catalogo' && bandeja.length > 0;
  const total = totalSeparado(bandeja);
  return (
    <AnimatePresence>
      {visivel && (
        <m.div
          key="bandeja"
          className="bm-vidro tm-bandeja"
          initial={{ y: 120, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 120, opacity: 0 }}
          transition={{ duration: MOVIMENTO.lento, ease: MOVIMENTO.curva }}
        >
          <span className="tm-bandeja__icone" aria-hidden="true">
            <IconeTm nome="bandeja" tamanho={26} />
          </span>
          <span className="tm-bandeja__texto">
            <b>{plural(total, 'item separado', 'itens separados')}</b>
            <small>{modulo === 'retirada' ? 'Retirada (RM)' : 'Empréstimo (EM)'}</small>
          </span>
          <Botao variante="acao" className="tm-bandeja__revisar" onClick={() => ir('revisao')}>
            Revisar <Icone nome="direita" tamanho={22} />
          </Botao>
        </m.div>
      )}
    </AnimatePresence>
  );
}
