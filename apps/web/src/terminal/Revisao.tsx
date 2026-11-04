/**
 * Revisão do que foi separado e o fechamento do empréstimo (migration 49): a CAMM de quem retira, a finalidade (OM,
 * CAPEX, TPM, empresa terceira ou outra; número só em OM e TPM), o prazo automático (fim do turno, vindo do servidor:
 * só exibido), "sem almoxarife no turno" e o termo de responsabilidade, obrigatório antes de "Confirmar empréstimo".
 * Quem decide é o servidor: a mensagem de erro dele aparece como veio. A chave de operação é a mesma até o servidor
 * confirmar (reenvio não duplica). Depois, a tela de sucesso com o check desenhado; nela, toques nos primeiros 700 ms
 * são ignorados.
 */
import { useState } from 'react';
import { m } from 'motion/react';
import { Badge, Botao, EmptyState, Icone, MOVIMENTO } from '../ui';
import { erroDe } from './api';
import { Aceite, CabecalhoTela, Carregando, CheckDesenhado, Contador, Segmento, useToqueProtegido } from './comum';
import { useTerminal } from './estado';
import { iconeCategoria, IconeTm } from './icones';
import { ajustarLinha, CAMMS, dataCurta, FINALIDADES, num, pedeNumero, plural, texto, totalSeparado } from './regras';
import { MensagemErro } from './teclado';
import type { Finalidade, Separado } from './tipos';

/** Rótulo do campo de referência da finalidade (OM e TPM: número obrigatório; terceira e outra: opcional). */
const REF: Partial<Record<Finalidade, string>> = {
  om: 'Número da OM',
  tpm: 'Número da TPM',
  terceira: 'Qual empresa? (opcional)',
  outro: 'Qual? (opcional)',
};

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
          {s.camm && ` · ${s.camm}`}
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
  const { bandeja, mudarBandeja, chamar, chave, concluirEmprestimo, ir, setOcupado, turno, turnoErro, carregarTurno } =
    useTerminal();
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [camm, setCamm] = useState('');
  const [finalidade, setFinalidade] = useState<Finalidade | ''>('');
  const [ref, setRef] = useState('');
  const [semAlmoxarife, setSemAlmoxarife] = useState(false);
  const [termo, setTermo] = useState(false);

  /** O que falta preencher (o servidor confere de novo): '' quando está tudo certo. */
  function falta(): string {
    if (!camm) return 'Escolha a sua CAMM.';
    if (!finalidade) return 'Escolha a finalidade do empréstimo.';
    if (pedeNumero(finalidade) && !texto(ref)) return `Informe o número da ${finalidade.toUpperCase()}.`;
    if (!termo) return 'Aceite o termo de responsabilidade para retirar.';
    return '';
  }

  async function confirmar() {
    if (enviando || !bandeja.length) return;
    const motivo = falta();
    if (motivo || !finalidade) return setErro(motivo);
    const itens = bandeja;
    const corpo = {
      chave: chave(),
      itens: itens.map((s) =>
        s.unidadeId
          ? { ferramentaId: s.ferramentaId, unidadeId: s.unidadeId, quantidade: 1 }
          : { ferramentaId: s.ferramentaId, quantidade: s.quantidade },
      ),
      finalidade,
      finalidadeRef: finalidade === 'capex' ? '' : texto(ref).slice(0, 60),
      camm,
      termoAceito: true,
      ...(semAlmoxarife ? { semAlmoxarife: true } : {}),
    };
    setErro('');
    setEnviando(true);
    setOcupado(true); // até a resposta: nada de "Separar mais" nem Voltar (a bandeja fica como foi)
    const r = await chamar('POST', '/emprestimos', corpo);
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok) return setErro(erroDe(r));
    concluirEmprestimo(r.json, itens);
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
  const rotuloRef = finalidade ? REF[finalidade] : undefined;
  const mudou = () => setErro('');
  return (
    <section className="tm-tela tm-revisao">
      <CabecalhoTela
        titulo="Revisar o empréstimo"
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
      <div className="bm-painel tm-pedido">
        <div className="tm-campo-bloco">
          <span className="tm-rotulo">Sua CAMM</span>
          <Segmento<string>
            rotulo="Sua CAMM"
            valor={camm}
            aoMudar={(c) => {
              mudou();
              setCamm(c);
            }}
            opcoes={CAMMS.map((c) => ({ id: c, texto: c }))}
          />
        </div>
        <div className="tm-campo-bloco">
          <span className="tm-rotulo">Finalidade</span>
          <Segmento<Finalidade | ''>
            rotulo="Finalidade"
            valor={finalidade}
            aoMudar={(f) => {
              mudou();
              setFinalidade(f);
            }}
            opcoes={FINALIDADES}
          />
        </div>
        {rotuloRef && (
          <label className="tm-campo-bloco">
            <span className="tm-rotulo">{rotuloRef}</span>
            <input
              className="tm-campo"
              autoComplete="off"
              spellCheck={false}
              maxLength={60}
              value={ref}
              onChange={(e) => {
                mudou();
                setRef(e.currentTarget.value);
              }}
            />
          </label>
        )}
        <Aceite marcado={semAlmoxarife} aoMudar={setSemAlmoxarife} desligado={enviando}>
          <b>Sem almoxarife no turno</b>
          <small>A entrega fica para o próximo almoxarife confirmar.</small>
        </Aceite>
      </div>
      <div className="bm-vidro tm-fechamento">
        {turno?.prazo ? (
          <p className="tm-prazo tm-prazo--ok">
            <Icone nome="relogio" tamanho={22} /> Devolver até {dataCurta(turno.prazo)} (fim do turno).
          </p>
        ) : turnoErro ? (
          <div className="tm-prazo tm-prazo--ruim">
            <Icone nome="alerta" tamanho={22} /> {turnoErro} <Botao onClick={carregarTurno}>Tentar de novo</Botao>
          </div>
        ) : !turno ? (
          <Carregando texto="Buscando o prazo…" />
        ) : (
          <p className="tm-prazo tm-prazo--neutro">
            <Icone nome="relogio" tamanho={22} /> Devolver até o fim do turno.
          </p>
        )}
        {turno && (
          <Aceite
            marcado={termo}
            aoMudar={(v) => {
              mudou();
              setTermo(v);
            }}
            desligado={enviando}
          >
            <b>Termo de responsabilidade</b>
            <small>{turno.termo}</small>
          </Aceite>
        )}
        <MensagemErro texto={erro} />
        <div className="tm-acoes">
          <Botao className="tm-botao-grande" disabled={enviando} onClick={() => ir('catalogo')}>
            <IconeTm nome="separar" tamanho={22} /> Separar mais
          </Botao>
          <Botao
            variante="acao"
            className="tm-botao-grande"
            disabled={enviando || !turno || !termo}
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
      </div>
    </section>
  );
}

export function TelaSucesso() {
  const { resultado, ir, sair } = useTerminal();
  const protegido = useToqueProtegido();
  if (!resultado) return null;
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
          Empréstimo registrado
        </m.h1>
        <p className="tm-numero">
          <Badge tom="acao">EM</Badge> <b>{resultado.numero}</b>
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
      {resultado.prazo ? (
        <p className="tm-prazo tm-prazo--ok">
          <Icone nome="relogio" tamanho={22} /> Devolva até {dataCurta(resultado.prazo)} (fim do turno).
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
          <IconeTm nome="separar" tamanho={22} /> Fazer outro empréstimo
        </Botao>
        <Botao variante="acao" className="tm-botao-grande" onClick={protegido(() => sair('logout'))}>
          <Icone nome="sair" tamanho={22} /> Terminar e sair
        </Botao>
      </div>
    </section>
  );
}
