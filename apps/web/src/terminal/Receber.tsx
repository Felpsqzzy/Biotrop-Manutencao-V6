/**
 * Dupla confirmação (migrations 49 e 50): o almoxarife entregou no balcão (empréstimo registrado pelo painel) e o
 * colaborador declara aqui "Recebi, conferi a quantidade e estão em boas condições" com o termo (POST
 * /emprestimos/:id/recebimento {termoAceito, conferido}) ou registra a divergência com foto ({divergencias}). Com
 * divergência aberta da retirada, o "recebi" fica travado até o almoxarifado resolver. Repetir não duplica (o servidor
 * devolve "repetido"); 409 (já não pede confirmação) relê a lista.
 */
import { useEffect, useState } from 'react';
import { Badge, Botao, EmptyState, Icone, useToast } from '../ui';
import { erroDe, lista } from './api';
import { CabecalhoTela, Carregando } from './comum';
import { faltaRecebimento, Recebimento } from './Entrega';
import { RECEBIMENTO_VAZIO, useTerminal, type EscolhaRecebimento } from './estado';
import { Fotos } from './Fotos';
import {
  dataHora,
  divergenciasAbertas,
  estadoItem,
  pedeRecebimento,
  textoFinalidade,
  textoRecebimento,
  textoTipoDivergencia,
} from './regras';
import { MensagemErro } from './teclado';
import type { Emprestimo, FotoEnviada, FotoRegistro } from './tipos';

function CartaoRecebimento({ e, termo }: { e: Emprestimo; termo: string }) {
  const { chamar, carregarAbertos, setOcupado } = useTerminal();
  const toast = useToast();
  const [escolha, setEscolha] = useState<EscolhaRecebimento>(RECEBIMENTO_VAZIO);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [fotos, setFotos] = useState<FotoEnviada[]>([]);
  // null = ainda não sabe; o servidor pede foto no "recebi" quando a entrega ficou sem foto
  const [semFotoEntrega, setSemFotoEntrega] = useState<boolean | null>(null);
  const fin = textoFinalidade(e.finalidade, e.finalidadeRef);
  useEffect(() => {
    let vivo = true;
    void chamar('GET', `/emprestimos/${encodeURIComponent(e.id)}/fotos`).then((r) => {
      if (!vivo || r.velho) return;
      setSemFotoEntrega(!r.ok || !lista<FotoRegistro>(r.json.rows).some((f) => f.etapa === 'entrega'));
    });
    return () => {
      vivo = false;
    };
  }, [e.id, chamar]);
  const abertas = divergenciasAbertas(e, 'retirada');
  const bloqueio = abertas.length
    ? 'Há divergência aberta neste empréstimo: o "recebi" fica liberado depois que o almoxarifado resolver.'
    : '';
  const falta =
    faltaRecebimento(escolha, false) ||
    (escolha.modo === 'ok' && bloqueio ? bloqueio : '') ||
    (escolha.modo === 'ok' && semFotoEntrega !== false && !fotos.length
      ? 'Tire pelo menos uma foto do que recebeu.'
      : '');

  async function confirmar() {
    if (enviando) return;
    if (falta) return setErro(falta);
    setErro('');
    setEnviando(true);
    setOcupado(true);
    const corpo =
      escolha.modo === 'divergencia'
        ? { divergencias: escolha.divergencias }
        : { termoAceito: true, conferido: true, ...(fotos.length ? { fotoIds: fotos.map((f) => f.fotoId) } : {}) };
    const r = await chamar('POST', `/emprestimos/${encodeURIComponent(e.id)}/recebimento`, corpo);
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok) {
      setErro(erroDe(r));
      if (r.status === 409 || r.status === 404) carregarAbertos();
      return;
    }
    toast.mostrar({
      texto:
        escolha.modo === 'divergencia'
          ? `Divergência de ${e.numero} registrada.`
          : `Recebimento de ${e.numero} confirmado.`,
      tom: 'ok',
    });
    setEscolha(RECEBIMENTO_VAZIO);
    setFotos([]);
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
      {textoRecebimento(e) && (
        <p className="tm-prazo tm-prazo--aviso">
          <Icone nome="alerta" tamanho={20} /> {textoRecebimento(e)}
        </p>
      )}
      {abertas.length > 0 && (
        <ul className="tm-registro__lista" aria-label="Divergências abertas">
          {abertas.map((d) => (
            <li key={d.id}>
              <span>
                <b>{textoTipoDivergencia(d.tipo)}</b> {d.descricao}
              </span>
              <small>Aberta</small>
            </li>
          ))}
        </ul>
      )}
      <Recebimento
        itens={(e.itensLista ?? []).map((i) => ({
          id: i.id,
          codigo: i.codigo,
          descricao: i.descricao,
          quantidade: i.quantidade,
        }))}
        valor={escolha}
        aoMudar={(fn) => {
          setErro('');
          setEscolha(fn);
        }}
        termo={termo}
        bloqueioOk={bloqueio}
        desligado={enviando}
      />
      {escolha.modo !== 'divergencia' && !bloqueio && (
        <div className="tm-campo-bloco">
          <span className="tm-rotulo">
            {semFotoEntrega === false ? 'Fotos do que recebeu (opcional)' : 'Fotos do que recebeu (obrigatória)'}
          </span>
          <Fotos
            etapa="entrega"
            rotulo={`Fotos do recebimento de ${e.numero}`}
            fotos={fotos}
            desligado={enviando}
            aoAdicionar={(f) => {
              setErro('');
              setFotos((l) => [...l, f]);
            }}
            aoRemover={(id) => setFotos((l) => l.filter((f) => f.fotoId !== id))}
          />
        </div>
      )}
      <MensagemErro texto={erro} />
      <Botao
        variante="acao"
        className="tm-botao-grande"
        disabled={enviando || !!falta}
        aria-busy={enviando}
        onClick={() => void confirmar()}
      >
        {enviando ? (
          <>
            <span className="tm-giro" aria-hidden="true" /> Registrando…
          </>
        ) : (
          <>
            <Icone nome="check" tamanho={22} />{' '}
            {escolha.modo === 'divergencia' ? 'Enviar divergência' : 'Confirmar recebimento'}
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
