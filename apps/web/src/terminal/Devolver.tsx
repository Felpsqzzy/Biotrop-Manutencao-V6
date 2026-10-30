/**
 * Devolução (só Empréstimo: a retirada não volta). Escolhe o empréstimo, marca o que está devolvendo (quantidade e
 * condição; avaria pede descrição), revisa e confirma. A chave da devolução é uma por empréstimo e só troca depois que
 * o servidor confirma; se o primeiro envio ficou sem resposta e o reenvio mudou, a tela avisa que valeu o primeiro.
 */
import { useEffect, useState } from 'react';
import { Badge, Botao, EmptyState, Icone } from '../ui';
import { erroDe } from './api';
import { CabecalhoTela, Carregando, CheckDesenhado, Contador, Segmento, useToqueProtegido } from './comum';
import { useTerminal, type ItemDevolvido, type SelDev } from './estado';
import { IconeTm } from './icones';
import { aberto, dataHora, devolviveis, ehRM, num, novaChave, plural, prazoInfo, texto } from './regras';
import { MensagemErro } from './teclado';
import type { Emprestimo } from './tipos';

const TOM_FAIXA = { ok: 'ok', aviso: 'aviso', ruim: 'ruim', info: 'info', neutro: 'neutro' } as const;

export function LinhaPrazo({ e }: { e: Emprestimo }) {
  const [tom, txt] = prazoInfo(e);
  return (
    <p className={`tm-prazo tm-prazo--${TOM_FAIXA[tom]}`}>
      <Icone nome={tom === 'ruim' ? 'alerta' : 'relogio'} tamanho={20} /> {txt}
    </p>
  );
}

function useEmprestimoDev(): Emprestimo | null {
  const { dev, abertos, carregarAbertos } = useTerminal();
  useEffect(() => {
    if (!abertos) carregarAbertos();
  }, [abertos, carregarAbertos]);
  return (dev && abertos?.find((e) => e.id === dev.id)) || null;
}

function itensDevolvidos(e: Emprestimo, sel: Record<string, SelDev>): ItemDevolvido[] {
  return devolviveis(e)
    .filter((i) => sel[i.id])
    .map((i) => ({
      itemId: i.id,
      codigo: i.codigo,
      descricao: i.descricao,
      quantidade: sel[i.id]!.quantidade,
      condicao: sel[i.id]!.condicao,
      observacao: texto(sel[i.id]!.observacao),
    }));
}

export function TelaDevolver() {
  const { abertos, abertosErro, carregarAbertos, ir, setDev } = useTerminal();
  const lista = (abertos ?? []).filter((e) => !ehRM(e) && aberto(e) && devolviveis(e).length > 0);
  return (
    <section className="tm-tela">
      <CabecalhoTela
        titulo="Devolver"
        sub="Escolha o empréstimo que você está devolvendo."
        voltar={() => ir('inicio')}
      />
      {abertosErro ? (
        <EmptyState
          titulo="Não deu para buscar seus empréstimos"
          texto={abertosErro}
          icone="alerta"
          acao={<Botao onClick={carregarAbertos}>Tentar de novo</Botao>}
        />
      ) : !abertos ? (
        <Carregando texto="Buscando seus empréstimos…" />
      ) : !lista.length ? (
        <EmptyState
          titulo="Nada para devolver"
          texto="Você não tem ferramenta emprestada pendente."
          icone="check"
          acao={<Botao onClick={() => ir('inicio')}>Voltar ao início</Botao>}
        />
      ) : (
        <ul className="tm-linhas">
          {lista.map((e) => (
            <li key={e.id} className="bm-painel tm-registro">
              <div className="tm-registro__cabeca">
                <Badge tom="acao">EM</Badge>
                <b>{e.numero}</b>
                <small>{dataHora(e.criadoEm)}</small>
              </div>
              <LinhaPrazo e={e} />
              <p className="tm-registro__itens">
                {devolviveis(e)
                  .map((i) => `${i.descricao} (${num(i.pendente)})`)
                  .join(' · ')}
              </p>
              <Botao
                variante="acao"
                className="tm-botao-grande"
                onClick={() => {
                  setDev({ id: e.id, sel: {}, de: 'devolver' });
                  ir('devolver-itens');
                }}
              >
                <IconeTm nome="devolver" tamanho={22} /> Devolver deste
              </Botao>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TelaDevolverItens() {
  const { dev, setDev, ir, abertos, abertosErro, carregarAbertos, chavesDev } = useTerminal();
  const e = useEmprestimoDev();
  const [erro, setErro] = useState('');
  const voltar = () => ir(dev?.de === 'meus' ? 'meus' : 'devolver');
  if (!dev) return null;
  if (!e)
    return (
      <section className="tm-tela">
        <CabecalhoTela titulo="Devolver" voltar={voltar} />
        {abertos ? (
          <EmptyState titulo="Este empréstimo não está mais em aberto" acao={<Botao onClick={voltar}>Voltar</Botao>} />
        ) : abertosErro ? (
          <EmptyState
            titulo="Não deu para buscar seus empréstimos"
            texto={abertosErro}
            icone="alerta"
            acao={<Botao onClick={carregarAbertos}>Tentar de novo</Botao>}
          />
        ) : (
          <Carregando />
        )}
      </section>
    );
  const itens = devolviveis(e);
  const mudar = (id: string, fn: (s: SelDev | undefined) => SelDev | undefined) => {
    setErro('');
    setDev((d) => {
      if (!d) return d;
      const sel = { ...d.sel };
      const novo = fn(sel[id]);
      if (novo) sel[id] = novo;
      else delete sel[id];
      return { ...d, sel };
    });
  };
  function revisar() {
    if (!e || !dev) return;
    const lista = itensDevolvidos(e, dev.sel);
    if (!lista.length) return setErro('Marque pelo menos uma ferramenta para devolver.');
    const sem = lista.find((i) => i.condicao === 'avaria' && i.observacao.length < 5);
    if (sem) return setErro(`Descreva a avaria de ${sem.descricao || sem.codigo} (pelo menos 5 caracteres).`);
    if (!chavesDev.current[e.id]) chavesDev.current[e.id] = { chave: novaChave(), incerto: null };
    ir('devolver-revisao');
  }
  return (
    <section className="tm-tela">
      <CabecalhoTela
        titulo={`Devolver ${e.numero}`}
        sub="Marque o que está devolvendo e a condição de cada ferramenta."
        voltar={voltar}
        extra={
          <Botao
            className="tm-marcar-todos"
            onClick={() =>
              itens.forEach((i) =>
                mudar(i.id, (s) => s ?? { quantidade: Number(i.pendente), condicao: 'boa', observacao: '' }),
              )
            }
          >
            <Icone nome="check" tamanho={20} /> Marcar todos
          </Botao>
        }
      />
      <ul className="tm-linhas">
        {itens.map((i) => {
          const s = dev.sel[i.id];
          const pend = Number(i.pendente);
          return (
            <li key={i.id} className={`bm-painel tm-dev${s ? ' is-marcado' : ''}`}>
              <button
                type="button"
                className="tm-dev__marcar"
                aria-pressed={!!s}
                onClick={() =>
                  mudar(i.id, (x) => (x ? undefined : { quantidade: pend, condicao: 'boa', observacao: '' }))
                }
              >
                <span className="tm-dev__caixa" aria-hidden="true">
                  {s && <Icone nome="check" tamanho={18} />}
                </span>
                <span className="tm-linha__textos">
                  <b>{i.descricao}</b>
                  <small>
                    <span className="tm-cod">{i.codigo}</span> · {plural(pend, 'pendente', 'pendentes')}
                  </small>
                </span>
              </button>
              {s && (
                <div className="tm-dev__detalhe">
                  {pend > 1 && (
                    <Contador
                      valor={s.quantidade}
                      rotulo={i.descricao}
                      aoMenos={() => mudar(i.id, (x) => x && { ...x, quantidade: Math.max(1, x.quantidade - 1) })}
                      aoMais={() => mudar(i.id, (x) => x && { ...x, quantidade: Math.min(pend, x.quantidade + 1) })}
                      podeMais={s.quantidade < pend}
                    />
                  )}
                  <Segmento<'boa' | 'avaria'>
                    rotulo={`Condição de ${i.descricao}`}
                    valor={s.condicao}
                    aoMudar={(c) => mudar(i.id, (x) => x && { ...x, condicao: c })}
                    opcoes={[
                      { id: 'boa', texto: 'Boa', icone: <Icone nome="check" tamanho={18} /> },
                      { id: 'avaria', texto: 'Com avaria', icone: <Icone nome="alerta" tamanho={18} /> },
                    ]}
                  />
                  {s.condicao === 'avaria' && (
                    <label className="tm-campo-bloco tm-dev__obs">
                      <span className="tm-rotulo">O que aconteceu?</span>
                      <textarea
                        className="tm-campo tm-campo--texto"
                        maxLength={500}
                        rows={2}
                        value={s.observacao}
                        onChange={(ev) => {
                          const v = ev.currentTarget.value;
                          mudar(i.id, (x) => x && { ...x, observacao: v });
                        }}
                      />
                    </label>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <MensagemErro texto={erro} />
      <div className="tm-acoes">
        <Botao variante="acao" className="tm-botao-grande" onClick={revisar}>
          Revisar devolução <Icone nome="direita" tamanho={22} />
        </Botao>
      </div>
    </section>
  );
}

export function TelaDevolverRevisao() {
  const { dev, setDev, ir, chamar, chavesDev, setResultadoDev, carregarAbertos, setOcupado } = useTerminal();
  const e = useEmprestimoDev();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  if (!dev || !e) return null;
  const itens = itensDevolvidos(e, dev.sel);

  async function confirmar() {
    const k = e && chavesDev.current[e.id];
    if (enviando || !e || !k) return;
    const corpoItens = itens.map((i) => ({
      itemId: i.itemId,
      quantidade: i.quantidade,
      condicao: i.condicao,
      ...(i.condicao === 'avaria' ? { observacao: i.observacao } : {}),
    }));
    const conteudo = JSON.stringify(corpoItens);
    setErro('');
    setEnviando(true);
    setOcupado(true); // até a resposta: nada de Voltar, Alterar ou troca de módulo
    const r = await chamar('POST', `/emprestimos/${encodeURIComponent(e.id)}/devolucoes`, {
      chave: k.chave,
      itens: corpoItens,
    });
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok) {
      // sem resposta (rede, 5xx) o servidor pode ter gravado: guarda o que foi no primeiro envio; 4xx não gravou nada
      if (r.status === 0 || r.status >= 500) {
        if (k.incerto == null) k.incerto = conteudo;
      } else k.incerto = null;
      setErro(erroDe(r));
      if (r.status === 409) carregarAbertos();
      return;
    }
    const repetido = r.json.repetido === true;
    setResultadoDev({
      numero: e.numero,
      repetido,
      itens,
      outra: repetido && k.incerto != null && k.incerto !== conteudo,
    });
    delete chavesDev.current[e.id];
    setDev(null);
    carregarAbertos();
    ir('devolver-ok');
  }

  return (
    <section className="tm-tela">
      <CabecalhoTela
        titulo="Revisar a devolução"
        sub={`${e.numero} · ${plural(itens.length, 'item', 'itens')}`}
        voltar={() => ir('devolver-itens')}
        bloqueado={enviando}
      />
      <ul className="tm-linhas">
        {itens.map((i) => (
          <li key={i.itemId} className="bm-painel tm-linha">
            <span className="tm-linha__icone" aria-hidden="true">
              <IconeTm nome="devolver" tamanho={22} />
            </span>
            <span className="tm-linha__textos">
              <b>{i.descricao}</b>
              <small>
                <span className="tm-cod">{i.codigo}</span>
                {i.condicao === 'avaria' ? ` · Avaria: ${i.observacao}` : ' · Em boas condições'}
              </small>
            </span>
            <span className="tm-linha__qtd">× {num(i.quantidade)}</span>
          </li>
        ))}
      </ul>
      <div className="bm-vidro tm-fechamento">
        <p className="tm-prazo tm-prazo--info">
          <Icone nome="info" tamanho={22} /> Deixe as ferramentas no balcão: o almoxarifado confere a devolução.
        </p>
        <MensagemErro texto={erro} />
        <div className="tm-acoes">
          <Botao className="tm-botao-grande" disabled={enviando} onClick={() => ir('devolver-itens')}>
            Alterar
          </Botao>
          <Botao
            variante="acao"
            className="tm-botao-grande"
            disabled={enviando}
            aria-busy={enviando}
            onClick={() => void confirmar()}
          >
            {enviando ? (
              <>
                <span className="tm-giro" aria-hidden="true" /> Registrando…
              </>
            ) : (
              <>
                <Icone nome="check" tamanho={22} /> Confirmar devolução
              </>
            )}
          </Botao>
        </div>
      </div>
    </section>
  );
}

export function TelaDevolverOk() {
  const { resultadoDev, ir, sair } = useTerminal();
  const protegido = useToqueProtegido();
  if (!resultadoDev) return null;
  return (
    <section className="tm-tela tm-sucesso">
      <div className="tm-sucesso__topo">
        <CheckDesenhado />
        <h1 className="tm-titulo-grande">Devolução registrada</h1>
        <p className="tm-numero">
          <Badge tom="acao">EM</Badge> <b>{resultadoDev.numero}</b>
        </p>
      </div>
      {resultadoDev.repetido && (
        <p className="tm-faixa tm-faixa--info" role="status">
          <Icone nome="info" tamanho={20} /> Esta devolução já estava registrada: nada foi duplicado.
        </p>
      )}
      {resultadoDev.outra && (
        <p className="tm-faixa tm-faixa--aviso" role="alert">
          <Icone nome="alerta" tamanho={20} /> Valeu o primeiro envio, que tinha outros itens. Confira em Meus
          empréstimos.
        </p>
      )}
      <ul className="tm-linhas">
        {resultadoDev.itens.map((i) => (
          <li key={i.itemId} className="bm-painel tm-linha">
            <span className="tm-linha__textos">
              <b>{i.descricao}</b>
              <small>{i.condicao === 'avaria' ? `Avaria: ${i.observacao}` : 'Em boas condições'}</small>
            </span>
            <span className="tm-linha__qtd">× {num(i.quantidade)}</span>
          </li>
        ))}
      </ul>
      <p className="tm-prazo tm-prazo--info">
        <Icone nome="info" tamanho={22} /> Aguardando a conferência do almoxarifado.
      </p>
      <div className="tm-acoes tm-acoes--fim">
        <Botao className="tm-botao-grande" onClick={protegido(() => ir('inicio'))}>
          <Icone nome="inicio" tamanho={22} /> Voltar ao início
        </Botao>
        <Botao variante="acao" className="tm-botao-grande" onClick={protegido(() => sair('logout'))}>
          <Icone nome="sair" tamanho={22} /> Terminar e sair
        </Botao>
      </div>
    </section>
  );
}
