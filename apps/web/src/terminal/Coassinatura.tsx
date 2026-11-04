/**
 * Co-assinatura do almoxarife no tablet (migration 50, D2): matrícula + PIN dele, no teclado da tela, com o PIN mascarado.
 * Não abre sessão: o servidor (POST /coassinatura) só confere e devolve um id de uso único que vale 3 min, gasto no
 * registro (entrega ou conferência). Aceitos: almoxarife, gestor e admin, nunca quem retira (o servidor decide; a tela
 * só barra a própria matrícula). PIN errado conta para o bloqueio (401 genérico; 429 = muitas tentativas). O PIN some
 * da memória assim que vai ao servidor. Esperar o almoxarife chegar é espera longa: a sessão fica segurada (até 5 min).
 */
import { useRef, useState, type FormEvent } from 'react';
import { Botao, Icone } from '../ui';
import { erroDe } from './api';
import { useSegurarSessao, useTerminal } from './estado';
import { PIN, texto } from './regras';
import { MensagemErro, PinCampo, preenchidoPeloNavegador, PREENCHIDO, Teclado } from './teclado';
import type { Coassinatura as Assinatura } from './tipos';

type Alvo = 'matricula' | 'senha';

export function Coassinatura({
  finalidade,
  aoConfirmar,
  desligado,
}: {
  finalidade: 'entrega' | 'conferencia';
  aoConfirmar: (c: Assinatura) => void;
  desligado?: boolean;
}) {
  const { chamar, sessao } = useTerminal();
  const [matricula, setMatricula] = useState('');
  const [senha, setSenha] = useState('');
  const [alvo, setAlvo] = useState<Alvo>('matricula');
  const [letras, setLetras] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [tremor, setTremor] = useState(0);
  const refMat = useRef<HTMLInputElement>(null);
  const refPin = useRef<HTMLInputElement>(null);
  useSegurarSessao(true);

  function recusar(msg: string) {
    setSenha('');
    setAlvo('senha');
    setTremor((t) => t + 1);
    setErro(msg);
  }

  async function confirmar(pin = senha) {
    if (enviando || desligado) return;
    if (preenchidoPeloNavegador(refMat.current) || preenchidoPeloNavegador(refPin.current)) {
      setMatricula('');
      setSenha('');
      setAlvo('matricula');
      return setErro(PREENCHIDO);
    }
    const mat = texto(matricula);
    if (!mat) {
      setAlvo('matricula');
      return setErro('O almoxarife informa a matrícula dele.');
    }
    if (pin.length !== PIN) {
      setAlvo('senha');
      return setErro('O almoxarife digita o PIN de 6 dígitos dele.');
    }
    if (mat.toUpperCase() === texto(sessao?.colaborador.matricula).toUpperCase())
      return recusar('Quem retira não pode confirmar a própria entrega. Chame o almoxarife.');
    setErro('');
    setEnviando(true);
    setSenha(''); // o PIN não fica na memória da tela
    // pública: 401 aqui é PIN errado, não fim da sessão (a sessão é conferida logo abaixo, se for o caso)
    const r = await chamar('POST', '/coassinatura', { matricula: mat, senha: pin, finalidade }, true);
    if (r.velho) return;
    setEnviando(false);
    const id = texto(r.json.coassinaturaId);
    if (r.ok && id) {
      setMatricula('');
      return aoConfirmar({ coassinaturaId: id, nome: texto(r.json.nome), expiraEm: texto(r.json.expiraEm) });
    }
    if (r.status === 401) void chamar('GET', '/eu'); // a sessão de quem retira ainda vale? Se não, encerra
    recusar(erroDe(r));
  }

  function tecla(k: string) {
    if (erro) setErro('');
    if (alvo === 'matricula') {
      setMatricula((v) =>
        k === 'apagar' ? v.slice(0, -1) : k === 'limpar' ? '' : v.length < 20 && /^[0-9A-Za-z]$/.test(k) ? v + k : v,
      );
      return;
    }
    const v = senha;
    const novo = k === 'apagar' ? v.slice(0, -1) : k === 'limpar' ? '' : /^\d$/.test(k) && v.length < PIN ? v + k : v;
    setSenha(novo);
    if (novo.length === PIN && v.length < PIN && texto(matricula)) void confirmar(novo);
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (alvo === 'matricula' && texto(matricula) && !senha) {
      setAlvo('senha');
      refPin.current?.focus({ preventScroll: true });
      return;
    }
    void confirmar();
  }

  return (
    <form className="bm-painel tm-coassinatura" autoComplete="off" noValidate onSubmit={enviar}>
      <p className="tm-coassinatura__texto">
        <Icone nome="escudo" tamanho={20} />
        {finalidade === 'entrega'
          ? 'O almoxarife confere o que está saindo e digita a matrícula e o PIN dele. Ninguém entra na sessão dele.'
          : 'O almoxarife confere a devolução e digita a matrícula e o PIN dele. Ninguém entra na sessão dele.'}
      </p>
      <div className="tm-coassinatura__campos">
        <div className="tm-campo-bloco">
          <label className="tm-rotulo" htmlFor="tm-coass-mat">
            Matrícula do almoxarife
          </label>
          <input
            ref={refMat}
            id="tm-coass-mat"
            name="tm-coass-mat"
            className={`tm-campo tm-campo--mat${alvo === 'matricula' ? ' is-alvo' : ''}`}
            inputMode={letras ? 'text' : 'none'}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={20}
            value={matricula}
            disabled={desligado}
            onFocus={() => setAlvo('matricula')}
            onChange={(e) => {
              if (preenchidoPeloNavegador(e.currentTarget)) {
                setMatricula('');
                return setErro(PREENCHIDO);
              }
              setErro('');
              setMatricula(e.currentTarget.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 20));
            }}
          />
          <button type="button" className="tm-link tm-link--mini" onClick={() => setLetras((v) => !v)}>
            {letras ? 'Só números' : 'A matrícula tem letras'}
          </button>
        </div>
        <PinCampo
          ref={refPin}
          id="tm-coass-pin"
          rotulo="PIN do almoxarife"
          valor={senha}
          alvo={alvo === 'senha'}
          tremor={tremor}
          aoFocar={() => setAlvo('senha')}
          aoTecla={tecla}
          aoEnviar={() => void confirmar()}
        />
      </div>
      <Teclado aoTecla={tecla} rotulo="Teclado numérico do almoxarife" />
      <MensagemErro texto={erro} />
      <Botao
        type="submit"
        variante="acao"
        className="tm-botao-grande"
        disabled={enviando || desligado}
        aria-busy={enviando}
      >
        {enviando ? (
          <>
            <span className="tm-giro" aria-hidden="true" /> Conferindo…
          </>
        ) : (
          <>
            <Icone nome="check" tamanho={22} /> {alvo === 'matricula' && !senha ? 'Continuar' : 'Confirmar'}
          </>
        )}
      </Botao>
    </form>
  );
}
