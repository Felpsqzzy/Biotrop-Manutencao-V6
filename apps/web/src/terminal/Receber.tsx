/**
 * Dupla confirmação (migration 49): o almoxarife entregou no balcão (empréstimo registrado pelo painel) e o colaborador
 * confirma aqui que recebeu, com o termo de responsabilidade (POST /emprestimos/:id/recebimento, termoAceito: true).
 * Um cartão por empréstimo com entrega 'aguardando_colaborador'; o termo é marcado em cada um. Repetir não duplica
 * (o servidor devolve "repetido"); 409 (já não pede confirmação) relê a lista.
 */
import { useState } from 'react';
import { Badge, Botao, EmptyState, Icone, useToast } from '../ui';
import { erroDe } from './api';
import { Aceite, CabecalhoTela, Carregando } from './comum';
import { useTerminal } from './estado';
import { dataHora, estadoItem, pedeRecebimento, textoFinalidade } from './regras';
import { MensagemErro } from './teclado';
import type { Emprestimo } from './tipos';

function CartaoRecebimento({ e, termo }: { e: Emprestimo; termo: string }) {
  const { chamar, carregarAbertos, setOcupado } = useTerminal();
  const toast = useToast();
  const [aceito, setAceito] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const fin = textoFinalidade(e.finalidade, e.finalidadeRef);

  async function confirmar() {
    if (enviando) return;
    if (!aceito) return setErro('Aceite o termo de responsabilidade para confirmar o recebimento.');
    setErro('');
    setEnviando(true);
    setOcupado(true);
    const r = await chamar('POST', `/emprestimos/${encodeURIComponent(e.id)}/recebimento`, { termoAceito: true });
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok) {
      setErro(erroDe(r));
      if (r.status === 409 || r.status === 404) carregarAbertos();
      return;
    }
    toast.mostrar({ texto: `Recebimento de ${e.numero} confirmado.`, tom: 'ok' });
    carregarAbertos();
  }

  return (
    <article className="bm-painel tm-registro" aria-label={e.numero}>
      <div className="tm-registro__cabeca">
        <Badge tom="acao">EM</Badge>
        <b>{e.numero}</b>
        <small>{dataHora(e.criadoEm)}</small>
      </div>
      {(fin || e.camm) && <p className="tm-registro__meta">{[fin, e.camm].filter(Boolean).join(' · ')}</p>}
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
      <Aceite
        marcado={aceito}
        aoMudar={(v) => {
          setErro('');
          setAceito(v);
        }}
        desligado={enviando}
      >
        <b>Termo de responsabilidade</b>
        <small>{termo}</small>
      </Aceite>
      <MensagemErro texto={erro} />
      <Botao
        variante="acao"
        className="tm-botao-grande"
        disabled={enviando || !aceito}
        aria-busy={enviando}
        onClick={() => void confirmar()}
      >
        {enviando ? (
          <>
            <span className="tm-giro" aria-hidden="true" /> Registrando…
          </>
        ) : (
          <>
            <Icone nome="check" tamanho={22} /> Confirmar recebimento
          </>
        )}
      </Botao>
    </article>
  );
}

export function TelaReceber() {
  const { abertos, abertosErro, carregarAbertos, ir, turno, turnoErro, carregarTurno, ocupado } = useTerminal();
  const lista = (abertos ?? []).filter(pedeRecebimento);
  return (
    <section className="tm-tela">
      <CabecalhoTela
        titulo="Confirmar recebimento"
        sub="Confira o que o almoxarifado entregou no balcão e confirme que recebeu."
        voltar={() => ir('inicio')}
        bloqueado={ocupado}
      />
      {abertosErro || turnoErro ? (
        <EmptyState
          titulo="Não deu para buscar seus empréstimos"
          texto={abertosErro || turnoErro}
          icone="alerta"
          acao={
            <Botao
              onClick={() => {
                carregarAbertos();
                carregarTurno();
              }}
            >
              Tentar de novo
            </Botao>
          }
        />
      ) : !abertos || !turno ? (
        <Carregando texto="Buscando seus empréstimos…" />
      ) : !lista.length ? (
        <EmptyState
          titulo="Nada para confirmar"
          texto="Todos os seus empréstimos já estão confirmados."
          icone="check"
          acao={<Botao onClick={() => ir('inicio')}>Voltar ao início</Botao>}
        />
      ) : (
        <ul className="tm-linhas">
          {lista.map((e) => (
            <li key={e.id}>
              <CartaoRecebimento e={e} termo={turno.termo} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
