/**
 * Revisão do que foi separado e o fechamento: "Confirmar empréstimo" (com o prazo padrão à vista) ou "Confirmar
 * retirada". A chave de operação é a mesma até o servidor confirmar (reenvio não duplica). Depois, a tela de sucesso
 * com o check desenhado; nela, toques nos primeiros 700 ms são ignorados.
 */
import { useState } from 'react';
import { m } from 'motion/react';
import { Badge, Botao, EmptyState, Icone, MOVIMENTO } from '../ui';
import { erroDe } from './api';
import { CabecalhoTela, Carregando, CheckDesenhado, Contador, useToqueProtegido } from './comum';
import { useTerminal } from './estado';
import { iconeCategoria, IconeTm } from './icones';
import { ajustarLinha, dataCurta, num, plural, totalSeparado } from './regras';
import { MensagemErro } from './teclado';
import type { Separado } from './tipos';

function textoPrazo(horas: number | null): string {
  if (!horas) return 'O prazo de devolução é definido pelo almoxarifado.';
  const dur = horas % 24 === 0 ? plural(horas / 24, 'dia', 'dias') : plural(horas, 'hora', 'horas');
  return `Prazo padrão: devolver em até ${dur} (até ${dataCurta(new Date(Date.now() + horas * 3600e3).toISOString())}).`;
}

function LinhaSeparada({ s, aoMudar }: { s: Separado; aoMudar?: (delta: number) => void }) {
  return (
    <li className={`bm-painel tm-linha${aoMudar ? ' tm-linha--editavel' : ''}`}>
      <span className="tm-linha__icone" aria-hidden="true">
        <IconeTm nome={iconeCategoria(s.categoria ?? '')} tamanho={22} />
      </span>
      <span className="tm-linha__textos">
        <b>{s.nome}</b>
        <small>
          <span className="tm-cod">{s.identificador || s.codigo}</span>
          {s.localizacao && ` · ${s.localizacao}`}
        </small>
      </span>
      {aoMudar ? (
        s.maximo > 1 ? (
          <Contador
            valor={s.quantidade}
            rotulo={s.nome}
            aoMenos={() => aoMudar(-1)}
            aoMais={() => aoMudar(1)}
            podeMais={s.quantidade < s.maximo}
          />
        ) : (
          <button type="button" className="tm-tirar" onClick={() => aoMudar(-1)} aria-label={`Tirar ${s.nome}`}>
            <IconeTm nome="lixo" tamanho={20} /> Tirar
          </button>
        )
      ) : (
        <span className="tm-linha__qtd">× {num(s.quantidade)}</span>
      )}
    </li>
  );
}

export function TelaRevisao() {
  const { modulo, bandeja, mudarBandeja, sessao, chamar, chaveDe, concluirRetirada, ir, setOcupado } = useTerminal();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const rm = modulo === 'retirada';

  async function confirmar() {
    if (enviando || !modulo || !bandeja.length) return;
    const itens = bandeja;
    const corpo = {
      modalidade: modulo,
      chave: chaveDe(modulo),
      itens: itens.map((s) =>
        s.unidadeId
          ? { ferramentaId: s.ferramentaId, unidadeId: s.unidadeId, quantidade: 1 }
          : { ferramentaId: s.ferramentaId, quantidade: s.quantidade },
      ),
    };
    setErro('');
    setEnviando(true);
    setOcupado(true); // até a resposta: nada de "Separar mais", Voltar ou troca de módulo (a bandeja fica como foi)
    const r = await chamar('POST', '/emprestimos', corpo);
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok) return setErro(erroDe(r));
    concluirRetirada(r.json, itens, modulo);
  }

  if (!bandeja.length)
    return (
      <section className="tm-tela">
        <CabecalhoTela titulo="Revisar" voltar={() => ir('catalogo')} />
        <EmptyState
          titulo="Nada separado"
          texto="Volte ao catálogo e toque em Separar."
          acao={<Botao onClick={() => ir('catalogo')}>Voltar ao catálogo</Botao>}
        />
      </section>
    );
  const total = totalSeparado(bandeja);
  return (
    <section className="tm-tela tm-revisao">
      <CabecalhoTela
        titulo={rm ? 'Revisar a retirada' : 'Revisar o empréstimo'}
        sub={`${plural(total, 'item separado', 'itens separados')}. Confira antes de confirmar.`}
        voltar={() => ir('catalogo')}
        bloqueado={enviando}
      />
      <ul className="tm-linhas">
        {bandeja.map((s, k) => (
          <LinhaSeparada
            key={`${s.ferramentaId}:${s.unidadeId ?? ''}`}
            s={s}
            aoMudar={enviando ? undefined : (d) => mudarBandeja((b) => ajustarLinha(b, k, d))}
          />
        ))}
      </ul>
      <div className="bm-vidro tm-fechamento">
        <p className={`tm-prazo tm-prazo--${rm ? 'info' : 'ok'}`}>
          <IconeTm nome={rm ? 'saida' : 'volta'} tamanho={22} />
          {rm
            ? 'Os itens saem do estoque e ficam aguardando a baixa do almoxarifado. Não precisa devolver.'
            : textoPrazo(sessao?.prazoPadraoHoras ?? null)}
        </p>
        <MensagemErro texto={erro} />
        <div className="tm-acoes">
          <Botao className="tm-botao-grande" disabled={enviando} onClick={() => ir('catalogo')}>
            <IconeTm nome="separar" tamanho={22} /> Separar mais
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
                <Icone nome="check" tamanho={22} /> {rm ? 'Confirmar retirada' : 'Confirmar empréstimo'}
              </>
            )}
          </Botao>
        </div>
      </div>
    </section>
  );
}

export function TelaSucesso() {
  const { resultado, ir, sair } = useTerminal();
  const protegido = useToqueProtegido();
  if (!resultado) return null;
  const rm = resultado.modalidade === 'retirada';
  return (
    <section className="tm-tela tm-sucesso">
      <div className="tm-sucesso__topo">
        <CheckDesenhado />
        <m.h1
          className="tm-titulo-grande"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: MOVIMENTO.medio, delay: MOVIMENTO.medio }}
        >
          {rm ? 'Retirada registrada' : 'Empréstimo registrado'}
        </m.h1>
        <p className="tm-numero">
          <Badge tom={rm ? 'info' : 'acao'}>{rm ? 'RM' : 'EM'}</Badge> <b>{resultado.numero}</b>
        </p>
      </div>
      {resultado.repetido && (
        <p className="tm-faixa tm-faixa--info" role="status">
          <Icone nome="info" tamanho={20} /> Este pedido já estava registrado: nada foi duplicado.
        </p>
      )}
      {resultado.outros && (
        <p className="tm-faixa tm-faixa--aviso" role="alert">
          <Icone nome="alerta" tamanho={20} /> O registro deste pedido tem outros itens. Confira abaixo o que ficou
          registrado.
        </p>
      )}
      <ul className="tm-linhas">
        {resultado.itens.map((s) => (
          <LinhaSeparada key={`${s.ferramentaId}:${s.unidadeId ?? ''}:${s.codigo}`} s={s} />
        ))}
      </ul>
      {rm ? (
        <p className="tm-prazo tm-prazo--info">
          <IconeTm nome="saida" tamanho={22} /> Aguardando a baixa do almoxarifado. Não precisa devolver.
        </p>
      ) : resultado.prazo ? (
        <p className="tm-prazo tm-prazo--ok">
          <Icone nome="relogio" tamanho={22} /> Devolva até {dataCurta(resultado.prazo)}.
        </p>
      ) : resultado.prazoFalhou ? (
        <p className="tm-prazo tm-prazo--neutro">
          <Icone nome="info" tamanho={22} /> Confira o prazo em Meus empréstimos.
        </p>
      ) : (
        <Carregando texto="Buscando o prazo…" />
      )}
      <div className="tm-acoes tm-acoes--fim">
        <Botao className="tm-botao-grande" onClick={protegido(() => ir('inicio'))}>
          <IconeTm nome={rm ? 'saida' : 'separar'} tamanho={22} />{' '}
          {rm ? 'Fazer outra retirada' : 'Fazer outro empréstimo'}
        </Botao>
        <Botao variante="acao" className="tm-botao-grande" onClick={protegido(() => sair('logout'))}>
          <Icone nome="sair" tamanho={22} /> Terminar e sair
        </Botao>
      </div>
    </section>
  );
}
