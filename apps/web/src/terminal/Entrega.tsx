/**
 * Entrega no tablet (migration 50), depois da revisão (ou da autorização aprovada, com a bandeja travada no que o líder
 * aprovou): 1) fotos das ferramentas como saem (1 a 5); 2) o almoxarife confirma a entrega com matrícula + PIN dele
 * (co-assinatura) ou "Sem almoxarife no turno" (outro almoxarife confirma depois, no site); 3) quem retira declara
 * "Recebi, conferi a quantidade e estão em boas condições" com o termo, ou registra a divergência (tipo, descrição e
 * foto). Tudo vai num POST /emprestimos só, com a chave de operação da revisão (reenvio não duplica). O recebimento
 * (Recebimento e FormDivergencia) também serve à confirmação do que foi entregue no balcão (Receber.tsx).
 */
import { useState } from 'react';
import { Badge, Botao, Icone } from '../ui';
import { erroDe } from './api';
import { Coassinatura } from './Coassinatura';
import { Aceite, CabecalhoTela, Carregando, Segmento } from './comum';
import { useTerminal, type EscolhaRecebimento, type RascunhoEntrega } from './estado';
import { Fotos } from './Fotos';
import { IconeTm } from './icones';
import {
  dataCurta,
  MAX_FOTOS_DIVERGENCIA,
  num,
  plural,
  texto,
  textoTipoDivergencia,
  TIPOS_DIVERGENCIA,
} from './regras';
import { MensagemErro } from './teclado';
import type { DivergenciaNova, FotoEnviada, TipoDivergencia } from './tipos';

/** Item que pode ter divergência (da bandeja ou do empréstimo). */
export interface ItemConferido {
  id?: string;
  codigo: string;
  descricao: string;
  quantidade: number;
}

export const RECEBI = 'Recebi, conferi a quantidade e estão em boas condições';

/** O que falta no recebimento ('' = pronto). termoSempre: na retirada o termo vale também com divergência. */
export function faltaRecebimento(r: EscolhaRecebimento, termoSempre: boolean): string {
  if (r.modo === 'divergencia') {
    if (!r.divergencias.length) return 'Registre a divergência (tipo, descrição e foto) ou volte ao "recebi".';
    if (termoSempre && !r.termo) return 'Aceite o termo de responsabilidade para retirar.';
    return '';
  }
  if (r.modo !== 'ok') return `Marque "${RECEBI}" ou registre a divergência.`;
  if (!r.termo) return 'Aceite o termo de responsabilidade.';
  return '';
}

/** Uma divergência nova: item (se houver mais de um), tipo, descrição, quantidade (se for o caso) e 1 a 3 fotos. */
export function FormDivergencia({
  itens,
  aoAdicionar,
  aoCancelar,
  etapaFoto = 'divergencia',
}: {
  itens: ItemConferido[];
  aoAdicionar: (d: DivergenciaNova) => void;
  aoCancelar: () => void;
  etapaFoto?: 'divergencia' | 'conferencia';
}) {
  const comId = itens.filter((i) => i.id);
  const [itemId, setItemId] = useState(comId.length === 1 ? comId[0]!.id! : '');
  const [tipo, setTipo] = useState<TipoDivergencia | ''>('');
  const [descricao, setDescricao] = useState('');
  const [quantidade, setQuantidade] = useState('');
  const [fotos, setFotos] = useState<FotoEnviada[]>([]);
  const [erro, setErro] = useState('');

  function adicionar() {
    if (!tipo) return setErro('Escolha o tipo da divergência.');
    const d = texto(descricao);
    if (d.length < 5) return setErro('Descreva a divergência (pelo menos 5 caracteres).');
    const q = Number(quantidade);
    if (tipo === 'quantidade_divergente' && !(Number.isInteger(q) && q > 0))
      return setErro('Informe quantas peças têm problema ou faltam.');
    if (!fotos.length) return setErro('Tire pelo menos uma foto da divergência.');
    aoAdicionar({
      ...(itemId ? { itemId } : {}),
      tipo,
      descricao: d.slice(0, 1000),
      ...(tipo === 'quantidade_divergente' ? { quantidade: q } : {}),
      fotoIds: fotos.map((f) => f.fotoId),
    });
  }

  return (
    <div className="bm-painel tm-divergencia" role="group" aria-label="Nova divergência">
      {comId.length > 1 && (
        <label className="tm-campo-bloco">
          <span className="tm-rotulo">Qual ferramenta?</span>
          <select className="tm-campo" value={itemId} onChange={(e) => setItemId(e.currentTarget.value)}>
            <option value="">Todas / o conjunto</option>
            {comId.map((i) => (
              <option key={i.id} value={i.id}>
                {i.codigo} · {i.descricao}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="tm-campo-bloco">
        <span className="tm-rotulo">Tipo da divergência</span>
        <Segmento<TipoDivergencia | ''>
          rotulo="Tipo da divergência"
          valor={tipo}
          aoMudar={(t) => {
            setErro('');
            setTipo(t);
          }}
          opcoes={TIPOS_DIVERGENCIA}
        />
      </div>
      <label className="tm-campo-bloco">
        <span className="tm-rotulo">O que está diferente?</span>
        <textarea
          className="tm-campo tm-campo--texto"
          maxLength={1000}
          rows={2}
          value={descricao}
          onChange={(e) => {
            setErro('');
            setDescricao(e.currentTarget.value);
          }}
        />
      </label>
      {tipo === 'quantidade_divergente' && (
        <label className="tm-campo-bloco">
          <span className="tm-rotulo">Quantas peças têm problema ou faltam?</span>
          <input
            className="tm-campo"
            inputMode="numeric"
            maxLength={4}
            value={quantidade}
            onChange={(e) => setQuantidade(e.currentTarget.value.replace(/\D/g, ''))}
          />
        </label>
      )}
      <Fotos
        etapa={etapaFoto}
        rotulo="Fotos da divergência"
        max={MAX_FOTOS_DIVERGENCIA}
        fotos={fotos}
        aoAdicionar={(f) => {
          setErro('');
          setFotos((l) => [...l, f]);
        }}
        aoRemover={(id) => setFotos((l) => l.filter((f) => f.fotoId !== id))}
      />
      <MensagemErro texto={erro} />
      <div className="tm-acoes">
        <Botao className="tm-botao-grande" onClick={aoCancelar}>
          Cancelar
        </Botao>
        <Botao variante="acao" className="tm-botao-grande" onClick={adicionar}>
          <Icone nome="check" tamanho={22} /> Adicionar divergência
        </Botao>
      </div>
    </div>
  );
}

/**
 * "Recebi, conferi…" ou divergências. bloqueioOk: há divergência aberta (o "recebi" só depois que o almoxarifado
 * resolver); termo: o texto do termo de responsabilidade.
 */
export function Recebimento({
  itens,
  valor,
  aoMudar,
  termo,
  bloqueioOk,
  desligado,
}: {
  itens: ItemConferido[];
  valor: EscolhaRecebimento;
  aoMudar: (fn: (r: EscolhaRecebimento) => EscolhaRecebimento) => void;
  termo: string;
  bloqueioOk?: string;
  desligado?: boolean;
}) {
  const [novo, setNovo] = useState(false);
  const nomeItem = (id?: string) => itens.find((i) => i.id && i.id === id)?.descricao ?? '';
  return (
    <div className="tm-recebimento">
      {bloqueioOk ? (
        <p className="tm-faixa tm-faixa--aviso" role="status">
          <Icone nome="alerta" tamanho={20} /> {bloqueioOk}
        </p>
      ) : (
        <Aceite
          marcado={valor.modo === 'ok'}
          desligado={desligado || novo || valor.divergencias.length > 0}
          aoMudar={(v) => aoMudar((r) => ({ ...r, modo: v ? 'ok' : '' }))}
        >
          <b>{RECEBI}</b>
          <small>Confira cada ferramenta e a quantidade antes de marcar.</small>
        </Aceite>
      )}
      {valor.divergencias.length > 0 && (
        <ul className="tm-linhas" aria-label="Divergências registradas">
          {valor.divergencias.map((d, k) => (
            <li key={k} className="bm-painel tm-linha">
              <span className="tm-linha__icone" aria-hidden="true">
                <Icone nome="alerta" tamanho={22} />
              </span>
              <span className="tm-linha__textos">
                <b>
                  {textoTipoDivergencia(d.tipo)}
                  {d.itemId ? ` · ${nomeItem(d.itemId)}` : ''}
                </b>
                <small>
                  {d.descricao}
                  {d.quantidade != null ? ` · ${num(d.quantidade)} com problema ou faltando` : ''} ·{' '}
                  {plural(d.fotoIds.length, 'foto', 'fotos')}
                </small>
              </span>
              <button
                type="button"
                className="tm-tirar"
                disabled={desligado}
                aria-label={`Remover a divergência ${k + 1}`}
                onClick={() =>
                  aoMudar((r) => {
                    const divergencias = r.divergencias.filter((_, i) => i !== k);
                    return { ...r, divergencias, modo: divergencias.length ? 'divergencia' : '' };
                  })
                }
              >
                <IconeTm nome="lixo" tamanho={20} /> Tirar
              </button>
            </li>
          ))}
        </ul>
      )}
      {novo ? (
        <FormDivergencia
          itens={itens}
          aoCancelar={() => {
            setNovo(false);
            aoMudar((r) => (r.divergencias.length ? r : { ...r, modo: '' }));
          }}
          aoAdicionar={(d) => {
            setNovo(false);
            aoMudar((r) => ({ ...r, modo: 'divergencia', divergencias: [...r.divergencias, d] }));
          }}
        />
      ) : (
        <Botao
          className="tm-botao-grande"
          disabled={desligado}
          onClick={() => {
            // divergência aberta na tela: o "recebi" sai e fica travado (Confirmar só com a divergência adicionada)
            setNovo(true);
            aoMudar((r) => ({ ...r, modo: 'divergencia' }));
          }}
        >
          <Icone nome="alerta" tamanho={22} /> Registrar divergência
        </Botao>
      )}
      <Aceite marcado={valor.termo} desligado={desligado} aoMudar={(v) => aoMudar((r) => ({ ...r, termo: v }))}>
        <b>Termo de responsabilidade</b>
        <small>{termo}</small>
      </Aceite>
    </div>
  );
}

const PASSOS: { id: RascunhoEntrega['passo']; texto: string }[] = [
  { id: 'fotos', texto: 'Fotos' },
  { id: 'almoxarife', texto: 'Almoxarife' },
  { id: 'recebimento', texto: 'Recebimento' },
];

export function TelaEntrega() {
  const { entrega, setEntrega, ir, chamar, chave, concluirEmprestimo, setOcupado, turno, turnoErro, carregarTurno } =
    useTerminal();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  if (!entrega) return null;
  const { pedido, passo } = entrega;
  const mudar = (fn: (e: RascunhoEntrega) => RascunhoEntrega) => {
    setErro('');
    setEntrega((e) => (e ? fn(e) : e));
  };
  const irPasso = (p: RascunhoEntrega['passo']) => mudar((e) => ({ ...e, passo: p }));
  const voltar = () => {
    if (passo === 'recebimento') return irPasso('almoxarife');
    if (passo === 'almoxarife') return irPasso('fotos');
    ir(pedido.autorizacaoId ? 'autorizacoes' : 'revisao');
  };
  const itens = pedido.itens.map((s) => ({
    codigo: s.identificador || s.codigo,
    descricao: s.nome,
    quantidade: s.quantidade,
  }));

  async function confirmar() {
    if (enviando || !entrega) return;
    const e = entrega;
    if (!e.fotos.length) return irPasso('fotos');
    const c = e.coassinatura;
    if (c && Date.parse(c.expiraEm) <= Date.now()) {
      mudar((x) => ({ ...x, coassinatura: null, passo: 'almoxarife' }));
      return setErro('A confirmação do almoxarife venceu (3 minutos). Peça para ele digitar de novo.');
    }
    if (!c && !e.semAlmoxarife) return irPasso('almoxarife');
    const falta = faltaRecebimento(e.recebimento, true);
    if (falta) return setErro(falta);
    const p = e.pedido;
    const corpo = {
      chave: chave(),
      itens: p.itens.map((s) =>
        s.unidadeId
          ? { ferramentaId: s.ferramentaId, unidadeId: s.unidadeId, quantidade: 1 }
          : { ferramentaId: s.ferramentaId, quantidade: s.quantidade },
      ),
      finalidade: p.finalidade,
      finalidadeRef: p.finalidade === 'capex' ? '' : texto(p.finalidadeRef).slice(0, 60),
      camm: p.camm,
      termoAceito: true,
      ...(p.autorizacaoId ? { autorizacaoId: p.autorizacaoId } : {}),
      fotosEntrega: e.fotos.map((f) => f.fotoId),
      ...(c ? { coassinaturaId: c.coassinaturaId } : { semAlmoxarife: true }),
      recebimento:
        e.recebimento.modo === 'divergencia' ? { divergencias: e.recebimento.divergencias } : { conferido: true },
    };
    setErro('');
    setEnviando(true);
    setOcupado(true);
    const r = await chamar('POST', '/emprestimos', corpo);
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok) return setErro(erroDe(r));
    concluirEmprestimo(r.json, p.itens, {
      entreguePor: c?.nome ?? '',
      divergencia: e.recebimento.modo === 'divergencia',
    });
  }

  const i = PASSOS.findIndex((x) => x.id === passo);
  return (
    <section className="tm-tela tm-entrega">
      <CabecalhoTela
        titulo={pedido.autorizacaoNumero ? `Retirada da ${pedido.autorizacaoNumero}` : 'Entrega das ferramentas'}
        sub={`${plural(pedido.itens.length, 'item', 'itens')} · passo ${i + 1} de 3`}
        voltar={voltar}
        bloqueado={enviando}
      />
      <ol className="tm-etapas" aria-label="Passos da entrega">
        {PASSOS.map((x, k) => (
          <li
            key={x.id}
            className={`tm-etapas__passo${k === i ? ' is-atual' : ''}${k < i ? ' is-feito' : ''}`}
            aria-current={k === i ? 'step' : undefined}
          >
            <b>{k < i ? <Icone nome="check" tamanho={16} /> : k + 1}</b> {x.texto}
          </li>
        ))}
      </ol>

      {passo === 'fotos' && (
        <>
          <p className="tm-lead">Fotografe as ferramentas como estão saindo do balcão (de 1 a 5 fotos).</p>
          <Fotos
            etapa="entrega"
            rotulo="Fotos da entrega"
            fotos={entrega.fotos}
            aoAdicionar={(f) => mudar((x) => ({ ...x, fotos: [...x.fotos, f] }))}
            aoRemover={(id) => mudar((x) => ({ ...x, fotos: x.fotos.filter((f) => f.fotoId !== id) }))}
          />
          <MensagemErro texto={erro} />
          <div className="tm-acoes">
            <Botao
              variante="acao"
              className="tm-botao-grande"
              onClick={() =>
                entrega.fotos.length ? irPasso('almoxarife') : setErro('Tire pelo menos uma foto das ferramentas.')
              }
            >
              Continuar <Icone nome="direita" tamanho={22} />
            </Botao>
          </div>
        </>
      )}

      {passo === 'almoxarife' && (
        <>
          {entrega.coassinatura ? (
            <p className="tm-faixa tm-faixa--ok" role="status">
              <IconeTm nome="assinar" tamanho={20} /> Entrega confirmada por {entrega.coassinatura.nome || 'almoxarife'}
              .
            </p>
          ) : (
            <Coassinatura
              finalidade="entrega"
              aoConfirmar={(c) => mudar((x) => ({ ...x, coassinatura: c, semAlmoxarife: false, passo: 'recebimento' }))}
            />
          )}
          <MensagemErro texto={erro} />
          <div className="tm-acoes">
            {entrega.coassinatura ? (
              <>
                <Botao className="tm-botao-grande" onClick={() => mudar((x) => ({ ...x, coassinatura: null }))}>
                  Outro almoxarife
                </Botao>
                <Botao variante="acao" className="tm-botao-grande" onClick={() => irPasso('recebimento')}>
                  Continuar <Icone nome="direita" tamanho={22} />
                </Botao>
              </>
            ) : (
              <Botao
                className="tm-botao-grande"
                onClick={() => mudar((x) => ({ ...x, semAlmoxarife: true, passo: 'recebimento' }))}
              >
                <Icone nome="relogio" tamanho={22} /> Sem almoxarife no turno
              </Botao>
            )}
          </div>
        </>
      )}

      {passo === 'recebimento' && (
        <>
          <p className={`tm-faixa ${entrega.coassinatura ? 'tm-faixa--ok' : 'tm-faixa--info'}`} role="status">
            <IconeTm nome="assinar" tamanho={20} />
            {entrega.coassinatura
              ? `Entrega confirmada por ${entrega.coassinatura.nome || 'almoxarife'}.`
              : 'Sem almoxarife no turno: o próximo almoxarife confirma a entrega no site.'}
          </p>
          <ul className="tm-linhas">
            {pedido.itens.map((s) => (
              <li key={`${s.ferramentaId}:${s.unidadeId ?? ''}`} className="bm-painel tm-linha">
                <span className="tm-linha__textos">
                  <b>{s.nome}</b>
                  <small>
                    <span className="tm-cod">{s.identificador || s.codigo}</span>
                  </small>
                </span>
                <span className="tm-linha__qtd">× {num(s.quantidade)}</span>
              </li>
            ))}
          </ul>
          {turnoErro ? (
            <div className="tm-prazo tm-prazo--ruim">
              <Icone nome="alerta" tamanho={22} /> {turnoErro} <Botao onClick={carregarTurno}>Tentar de novo</Botao>
            </div>
          ) : !turno ? (
            <Carregando texto="Buscando o termo…" />
          ) : (
            <>
              {turno.prazo && (
                <p className="tm-prazo tm-prazo--ok">
                  <Icone nome="relogio" tamanho={22} /> Devolver até {dataCurta(turno.prazo)} (fim do turno).
                </p>
              )}
              <Recebimento
                itens={itens}
                valor={entrega.recebimento}
                aoMudar={(fn) => mudar((x) => ({ ...x, recebimento: fn(x.recebimento) }))}
                termo={turno.termo}
                desligado={enviando}
              />
            </>
          )}
          <MensagemErro texto={erro} />
          <div className="tm-acoes">
            <Botao
              variante="acao"
              className="tm-botao-grande"
              disabled={enviando || !turno || !!faltaRecebimento(entrega.recebimento, true)}
              aria-busy={enviando}
              onClick={() => void confirmar()}
            >
              {enviando ? (
                <>
                  <span className="tm-giro" aria-hidden="true" /> Registrando…
                </>
              ) : (
                <>
                  <Icone nome="check" tamanho={22} /> Confirmar empréstimo
                </>
              )}
            </Botao>
          </div>
          {pedido.autorizacaoNumero && (
            <p className="tm-registro__meta">
              <Badge tom="ok">{pedido.autorizacaoNumero}</Badge> Itens travados no que o líder aprovou.
            </p>
          )}
        </>
      )}
    </section>
  );
}
