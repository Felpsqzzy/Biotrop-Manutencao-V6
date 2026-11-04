/**
 * Minhas autorizações (conta de terceiro, migration 50): os pedidos ao líder com o número AUT, o status, a pessoa, o
 * líder, os itens e a validade (fim do turno). Pendente: espera (relê a cada 15 s por até 5 min, segurando a sessão;
 * depois, "Atualizar") e "Cancelar pedido" com justificativa. Aprovada e no prazo: "Retirar agora" abre a entrega com a
 * bandeja travada no que o líder aprovou. Recusada mostra a justificativa do líder. Ninguém aprova pelo tablet.
 */
import { useEffect, useRef, useState } from 'react';
import { Badge, Botao, EmptyState, Icone, useToast } from '../ui';
import { erroDe } from './api';
import { CabecalhoTela, Carregando } from './comum';
import { ESPERA_LONGA_MS, useSegurarSessao, useTerminal } from './estado';
import { IconeTm } from './icones';
import {
  autorizacaoVigente,
  dataCurta,
  dataHora,
  num,
  separadosDaAutorizacao,
  texto,
  textoStatusAut,
  tomStatusAut,
} from './regras';
import { MensagemErro } from './teclado';
import type { Autorizacao } from './tipos';

const RELE_MS = 15000;

/** Status que a pessoa vê: pendente ou aprovada com a validade vencida já conta como expirada. */
const statusVisto = (a: Autorizacao): Autorizacao =>
  (a.status === 'pendente' || a.status === 'aprovada') && !autorizacaoVigente(a) ? { ...a, status: 'expirada' } : a;

function CartaoAutorizacao({ a, foco }: { a: Autorizacao; foco: boolean }) {
  const { chamar, carregarAutorizacoes, iniciarEntrega, setOcupado } = useTerminal();
  const toast = useToast();
  const [cancelando, setCancelando] = useState(false);
  const [justificativa, setJustificativa] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const v = statusVisto(a);

  async function cancelar() {
    if (enviando) return;
    const j = texto(justificativa);
    if (j.length < 5) return setErro('Diga por que está cancelando (pelo menos 5 caracteres).');
    setErro('');
    setEnviando(true);
    setOcupado(true);
    const r = await chamar('POST', `/autorizacoes/${encodeURIComponent(a.id)}/cancelar`, { justificativa: j });
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok) {
      setErro(erroDe(r));
      if (r.status === 409) carregarAutorizacoes();
      return;
    }
    toast.mostrar({ texto: `Pedido ${a.numero} cancelado.`, tom: 'ok' });
    carregarAutorizacoes();
  }

  return (
    <article className={`bm-painel tm-registro${foco ? ' tm-registro--foco' : ''}`} aria-label={a.numero}>
      <div className="tm-registro__cabeca">
        <Badge tom="acao">AUT</Badge>
        <b>{a.numero}</b>
        <Badge tom={tomStatusAut(v)}>{textoStatusAut(v)}</Badge>
      </div>
      <p className="tm-registro__meta">
        {[
          texto(a.terceiroPessoa) && `Retira: ${texto(a.terceiroPessoa)}`,
          texto(a.liderNome) && `Líder: ${a.liderNome}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <ul className="tm-registro__lista">
        {a.itens.map((i, k) => (
          <li key={`${i.ferramentaId}:${i.unidadeId ?? ''}:${k}`}>
            <span>
              <span className="tm-cod">{i.codigo}</span> {i.descricao}
            </span>
            <small>Qtd {num(i.quantidade)}</small>
          </li>
        ))}
      </ul>
      {v.status === 'pendente' && (
        <p className="tm-prazo tm-prazo--aviso" role="status">
          <span className="tm-giro" aria-hidden="true" /> Aguardando o líder aprovar no site
          {a.expiraEm ? ` (vale até ${dataCurta(a.expiraEm)})` : ''}.
        </p>
      )}
      {v.status === 'aprovada' && (
        <p className="tm-prazo tm-prazo--ok">
          <Icone nome="check" tamanho={20} /> Aprovada{a.decididoEm ? ` em ${dataHora(a.decididoEm)}` : ''}. Retire até{' '}
          {dataCurta(a.expiraEm)} (fim do turno).
        </p>
      )}
      {v.status === 'recusada' && (
        <p className="tm-prazo tm-prazo--ruim">
          <Icone nome="alerta" tamanho={20} /> Recusada pelo líder: {texto(a.decisaoJustificativa) || 'sem motivo.'}
        </p>
      )}
      {v.status === 'expirada' && (
        <p className="tm-prazo tm-prazo--neutro">
          <Icone nome="relogio" tamanho={20} /> Venceu no fim do turno. Faça um novo pedido.
        </p>
      )}
      {v.status === 'aprovada' && (
        <Botao
          variante="acao"
          className="tm-botao-grande"
          onClick={() =>
            iniciarEntrega({
              itens: separadosDaAutorizacao(a),
              finalidade: 'terceira',
              finalidadeRef: texto(a.finalidadeRef),
              camm: texto(a.camm),
              autorizacaoId: a.id,
              autorizacaoNumero: a.numero,
            })
          }
        >
          <IconeTm nome="separar" tamanho={22} /> Retirar agora
        </Botao>
      )}
      {v.status === 'pendente' &&
        (cancelando ? (
          <div className="tm-campo-bloco">
            <label className="tm-campo-bloco">
              <span className="tm-rotulo">Por que cancelar?</span>
              <textarea
                className="tm-campo tm-campo--texto"
                maxLength={1000}
                rows={2}
                value={justificativa}
                onChange={(e) => {
                  setErro('');
                  setJustificativa(e.currentTarget.value);
                }}
              />
            </label>
            <MensagemErro texto={erro} />
            <div className="tm-acoes">
              <Botao className="tm-botao-grande" disabled={enviando} onClick={() => setCancelando(false)}>
                Manter o pedido
              </Botao>
              <Botao
                variante="acao"
                className="tm-botao-grande"
                disabled={enviando}
                aria-busy={enviando}
                onClick={() => void cancelar()}
              >
                Cancelar pedido
              </Botao>
            </div>
          </div>
        ) : (
          <Botao className="tm-botao-grande" onClick={() => setCancelando(true)}>
            Cancelar pedido
          </Botao>
        ))}
    </article>
  );
}

export function TelaAutorizacoes() {
  const { autorizacoes, autorizacoesErro, carregarAutorizacoes, ir, autFoco, ocupado } = useTerminal();
  const desde = useRef(Date.now());
  const [agora, setAgora] = useState(() => Date.now());
  const lista = (autorizacoes ?? []).slice().sort((x, y) => (x.id === autFoco ? -1 : y.id === autFoco ? 1 : 0));
  const pendente = lista.some((a) => statusVisto(a).status === 'pendente');
  const esperando = pendente && agora - desde.current < ESPERA_LONGA_MS;
  useSegurarSessao(esperando);

  // espera do líder: relê a cada 15 s por até 5 min (cada leitura renova a sessão, por isso tem fim)
  useEffect(() => {
    if (!esperando) return;
    const id = setInterval(() => {
      setAgora(Date.now());
      if (Date.now() - desde.current < ESPERA_LONGA_MS) carregarAutorizacoes();
    }, RELE_MS);
    return () => clearInterval(id);
  }, [esperando, carregarAutorizacoes]);

  return (
    <section className="tm-tela">
      <CabecalhoTela
        titulo="Minhas autorizações"
        sub="Pedidos ao líder. A autorização vale até o fim do turno."
        voltar={() => ir('inicio')}
        bloqueado={ocupado}
        extra={
          <Botao
            onClick={() => {
              desde.current = Date.now();
              setAgora(Date.now());
              carregarAutorizacoes();
            }}
          >
            <IconeTm nome="volta" tamanho={20} /> Atualizar
          </Botao>
        }
      />
      {autorizacoesErro ? (
        <EmptyState
          titulo="Não deu para buscar as autorizações"
          texto={autorizacoesErro}
          icone="alerta"
          acao={<Botao onClick={carregarAutorizacoes}>Tentar de novo</Botao>}
        />
      ) : !autorizacoes ? (
        <Carregando texto="Buscando as autorizações…" />
      ) : !lista.length ? (
        <EmptyState
          titulo="Nenhum pedido de autorização"
          texto="Separe as ferramentas e envie o pedido ao líder."
          acao={<Botao onClick={() => ir('catalogo')}>Pegar ferramentas</Botao>}
        />
      ) : (
        <ul className="tm-linhas">
          {lista.map((a) => (
            <li key={a.id}>
              <CartaoAutorizacao a={a} foco={a.id === autFoco} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
