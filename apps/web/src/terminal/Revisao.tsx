/**
 * Revisão do que foi separado (migrations 49 e 50): a CAMM de quem retira, a finalidade (OM, CAPEX, TPM ou outra;
 * número só em OM e TPM; "empresa terceira" só pela conta da empresa) e o prazo automático (fim do turno, vindo do
 * servidor: só exibido). "Continuar" leva à entrega (Entrega.tsx: fotos, almoxarife, recebimento e termo).
 * Conta de terceiro: empresa fixa (da conta), nome de quem retira e o líder (GET /lideres); "Enviar para autorização"
 * (POST /autorizacoes) e a espera em Autorizacao.tsx. A chave de operação é a mesma até o servidor confirmar (reenvio
 * não duplica). Depois, a tela de sucesso com o check desenhado; nela, toques nos primeiros 700 ms são ignorados.
 * O fechamento não fica preso embaixo da tela: preso, ele cobria o "Número da OM" com o teclado do tablet aberto.
 */
import { useEffect, useState } from 'react';
import { m } from 'motion/react';
import { Badge, Botao, EmptyState, Icone, MOVIMENTO } from '../ui';
import { ERRO_PADRAO, erroDe, lista } from './api';
import { CabecalhoTela, Carregando, CheckDesenhado, Contador, Segmento, useToqueProtegido } from './comum';
import { useTerminal } from './estado';
import { iconeCategoria, IconeTm } from './icones';
import {
  ajustarLinha,
  CAMMS,
  dataCurta,
  ehTerceiro,
  FINALIDADES_INTERNO,
  num,
  pedeNumero,
  plural,
  texto,
  totalSeparado,
} from './regras';
import { MensagemErro } from './teclado';
import type { Finalidade, Lider, Separado } from './tipos';

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
  const { bandeja, mudarBandeja, chamar, chave, ir, setOcupado, turno, turnoErro, carregarTurno, sessao } =
    useTerminal();
  const { iniciarEntrega, concluirAutorizacao } = useTerminal();
  const terceiro = ehTerceiro(sessao?.colaborador);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [camm, setCamm] = useState('');
  const [finalidade, setFinalidade] = useState<Finalidade | ''>(terceiro ? 'terceira' : '');
  const [ref, setRef] = useState('');
  const [pessoa, setPessoa] = useState('');
  const [liderId, setLiderId] = useState('');
  const [lideres, setLideres] = useState<Lider[] | null>(null);
  const [lideresErro, setLideresErro] = useState('');
  const [recargaLideres, setRecargaLideres] = useState(0);

  // conta de terceiro: quem pode aprovar (líder ou gestor ativo; só id e nome)
  useEffect(() => {
    if (!terceiro) return;
    let vivo = true;
    setLideresErro('');
    void chamar('GET', '/lideres').then((r) => {
      if (!vivo || r.velho) return;
      if (!r.ok) setLideresErro(erroDe(r));
      else setLideres(lista<Lider>(r.json.rows));
    });
    return () => {
      vivo = false;
    };
  }, [terceiro, chamar, recargaLideres]);

  /** O que falta preencher (o servidor confere de novo): '' quando está tudo certo. */
  function falta(): string {
    if (terceiro) {
      if (texto(pessoa).length < 3) return 'Informe o nome de quem vai retirar.';
      if (!liderId) return 'Escolha o líder que vai autorizar.';
    }
    if (!camm) return 'Escolha a sua CAMM.';
    if (!finalidade) return 'Escolha a finalidade do empréstimo.';
    if (pedeNumero(finalidade) && !texto(ref)) return `Informe o número da ${finalidade.toUpperCase()}.`;
    return '';
  }

  function continuar() {
    if (enviando || !bandeja.length) return;
    const motivo = falta();
    if (motivo || !finalidade) return setErro(motivo);
    setErro('');
    iniciarEntrega({ itens: bandeja, finalidade, finalidadeRef: texto(ref).slice(0, 60), camm });
  }

  async function pedirAutorizacao() {
    if (enviando || !bandeja.length) return;
    const motivo = falta();
    if (motivo) return setErro(motivo);
    const corpo = {
      chave: chave(),
      terceiroPessoa: texto(pessoa).slice(0, 120),
      liderId,
      camm,
      ...(texto(ref) ? { finalidadeRef: texto(ref).slice(0, 60) } : {}),
      itens: bandeja.map((s) =>
        s.unidadeId
          ? { ferramentaId: s.ferramentaId, unidadeId: s.unidadeId, quantidade: 1 }
          : { ferramentaId: s.ferramentaId, quantidade: s.quantidade },
      ),
    };
    setErro('');
    setEnviando(true);
    setOcupado(true);
    const r = await chamar('POST', '/autorizacoes', corpo);
    if (r.velho) return;
    setOcupado(false);
    setEnviando(false);
    if (!r.ok || !texto(r.json.id)) return setErro(r.ok ? ERRO_PADRAO : erroDe(r));
    concluirAutorizacao(texto(r.json.id));
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
  const rotuloRef = terceiro ? 'Referência do serviço (opcional)' : finalidade ? REF[finalidade] : undefined;
  const mudou = () => setErro('');
  return (
    <section className="tm-tela tm-revisao">
      <CabecalhoTela
        titulo={terceiro ? 'Pedir autorização' : 'Revisar o empréstimo'}
        sub={`${plural(total, 'item separado', 'itens separados')}. Confira antes de ${terceiro ? 'enviar' : 'continuar'}.`}
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
        {terceiro && (
          <>
            <p className="tm-campo-bloco">
              <span className="tm-rotulo">Empresa</span>
              <b className="tm-fixo">{texto(sessao?.colaborador.empresa) || texto(sessao?.colaborador.nome)}</b>
            </p>
            <label className="tm-campo-bloco">
              <span className="tm-rotulo">Nome de quem vai retirar</span>
              <input
                className="tm-campo"
                autoComplete="off"
                spellCheck={false}
                maxLength={120}
                value={pessoa}
                onChange={(e) => {
                  mudou();
                  setPessoa(e.currentTarget.value);
                }}
              />
            </label>
            <label className="tm-campo-bloco">
              <span className="tm-rotulo">Líder que autoriza</span>
              {lideresErro ? (
                <span className="tm-prazo tm-prazo--ruim">
                  <Icone nome="alerta" tamanho={20} /> {lideresErro}{' '}
                  <Botao onClick={() => setRecargaLideres((x) => x + 1)}>Tentar de novo</Botao>
                </span>
              ) : (
                <select
                  className="tm-campo"
                  value={liderId}
                  disabled={!lideres}
                  onChange={(e) => {
                    mudou();
                    setLiderId(e.currentTarget.value);
                  }}
                >
                  <option value="">{lideres ? 'Escolha o líder' : 'Buscando os líderes…'}</option>
                  {(lideres ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.nome}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </>
        )}
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
        {!terceiro && (
          <div className="tm-campo-bloco">
            <span className="tm-rotulo">Finalidade</span>
            <Segmento<Finalidade | ''>
              rotulo="Finalidade"
              valor={finalidade}
              aoMudar={(f) => {
                mudou();
                setFinalidade(f);
              }}
              opcoes={FINALIDADES_INTERNO}
            />
          </div>
        )}
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
      </div>
      <div className="bm-vidro tm-fechamento">
        {terceiro ? (
          <p className="tm-prazo tm-prazo--info">
            <Icone nome="info" tamanho={22} /> O líder aprova no site. A autorização vale até o fim do turno.
          </p>
        ) : turno?.prazo ? (
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
        <MensagemErro texto={erro} />
        <div className="tm-acoes">
          <Botao className="tm-botao-grande" disabled={enviando} onClick={() => ir('catalogo')}>
            <IconeTm nome="separar" tamanho={22} /> Separar mais
          </Botao>
          {terceiro ? (
            <Botao
              variante="acao"
              className="tm-botao-grande"
              disabled={enviando}
              aria-busy={enviando}
              onClick={() => void pedirAutorizacao()}
            >
              {enviando ? (
                <>
                  <span className="tm-giro" aria-hidden="true" /> Enviando…
                </>
              ) : (
                <>
                  <Icone nome="check" tamanho={22} /> Enviar para autorização
                </>
              )}
            </Botao>
          ) : (
            <Botao variante="acao" className="tm-botao-grande" onClick={continuar}>
              Continuar <Icone nome="direita" tamanho={22} />
            </Botao>
          )}
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
      <p className={`tm-faixa ${resultado.entreguePor ? 'tm-faixa--ok' : 'tm-faixa--info'}`} role="status">
        <IconeTm nome="assinar" tamanho={20} />
        {resultado.entreguePor
          ? `Entrega confirmada por ${resultado.entreguePor}.`
          : 'Sem almoxarife no turno: o próximo almoxarife confirma a entrega.'}
      </p>
      {resultado.divergencia && (
        <p className="tm-faixa tm-faixa--aviso" role="status">
          <Icone nome="alerta" tamanho={20} /> Divergência registrada: o almoxarifado analisa antes do seu "recebi".
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
