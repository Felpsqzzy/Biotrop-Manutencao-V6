/**
 * Camadas por cima das telas: aviso de inatividade (últimos 15 s), saída administrativa escondida (matrícula, PIN do
 * terminal e código do autenticador; quem decide é o servidor, e só "liberado" sai do modo tablet) e o vidro de
 * "saindo" (logout e inatividade; a memória já foi limpa antes dele).
 */
import { useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Botao, Dialog, Icone, MOVIMENTO } from '../ui';
import { erroDe } from './api';
import { useTerminal } from './estado';
import { PIN, texto } from './regras';
import { MensagemErro, PinCampo, preenchidoPeloNavegador, PREENCHIDO, Teclado } from './teclado';

export function AvisoInatividade() {
  const { avisoResta, continuarSessao, sessao } = useTerminal();
  const aberto = !!sessao && avisoResta != null;
  return (
    <Dialog
      aberto={aberto}
      aoFechar={continuarSessao}
      titulo="Ainda está aí?"
      descricao={`Por segurança, a sessão termina em ${avisoResta ?? 0} s sem uso.`}
      rodape={
        <Botao variante="acao" className="tm-botao-grande" data-autofocus onClick={continuarSessao}>
          <Icone nome="check" tamanho={22} /> Continuar usando
        </Botao>
      }
    >
      <p className="tm-aviso-tempo" aria-hidden="true">
        {avisoResta ?? 0}
      </p>
    </Dialog>
  );
}

type AlvoAdm = 'mat' | 'senha' | 'codigo';

function FormAdmin({ aoCancelar }: { aoCancelar: () => void }) {
  const { chamar, aguardarLimpeza, voltarInicio } = useTerminal();
  const [mat, setMat] = useState('');
  const [senha, setSenha] = useState('');
  const [codigo, setCodigo] = useState('');
  const [alvo, setAlvo] = useState<AlvoAdm>('mat');
  const [letras, setLetras] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [tremor, setTremor] = useState(0);
  const refMat = useRef<HTMLInputElement>(null);
  const refSenha = useRef<HTMLInputElement>(null);

  function tecla(k: string) {
    if (erro) setErro('');
    if (alvo === 'mat') {
      setMat((v) =>
        k === 'apagar' ? v.slice(0, -1) : k === 'limpar' ? '' : v.length < 20 && /^[0-9A-Za-z]$/.test(k) ? v + k : v,
      );
      return;
    }
    const [v, set] = alvo === 'senha' ? [senha, setSenha] : [codigo, setCodigo];
    if (!/^(\d|apagar|limpar)$/.test(k)) return;
    const novo = k === 'apagar' ? v.slice(0, -1) : k === 'limpar' ? '' : v.length < PIN ? v + k : v;
    set(novo);
    if (alvo === 'senha' && novo.length === PIN && v.length < PIN) setAlvo('codigo');
  }

  async function enviar(e?: FormEvent) {
    e?.preventDefault();
    if (enviando) return;
    if (preenchidoPeloNavegador(refMat.current) || preenchidoPeloNavegador(refSenha.current)) {
      setMat('');
      setSenha('');
      return setErro(PREENCHIDO);
    }
    if (!texto(mat) || !senha || !/^\d{6}$/.test(codigo))
      return setErro('Informe a matrícula, o PIN e o código de 6 dígitos.');
    setErro('');
    setEnviando(true);
    await aguardarLimpeza();
    const r = await chamar('POST', '/saida-admin', { matricula: texto(mat), senha, codigo }, true);
    setEnviando(false);
    if (r.ok && r.json.liberado === true) {
      voltarInicio();
      try {
        window.location.href = '/';
      } catch {
        /* jsdom */
      }
      return;
    }
    setSenha('');
    setCodigo('');
    setAlvo('senha');
    setTremor((t) => t + 1);
    setErro(erroDe(r));
  }

  return (
    <form className="tm-admin" autoComplete="off" noValidate onSubmit={enviar}>
      <div className="tm-campo-bloco">
        <label className="tm-rotulo" htmlFor="tm-adm-mat">
          Matrícula
        </label>
        <input
          ref={refMat}
          id="tm-adm-mat"
          className={`tm-campo${alvo === 'mat' ? ' is-alvo' : ''}`}
          inputMode={letras ? 'text' : 'none'}
          onFocus={() => setAlvo('mat')}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={20}
          value={mat}
          data-autofocus
          onChange={(e) => {
            if (preenchidoPeloNavegador(e.currentTarget)) {
              setMat('');
              return setErro(PREENCHIDO);
            }
            setMat(e.currentTarget.value.slice(0, 20));
            if (erro) setErro('');
          }}
        />
      </div>
      <div className="tm-pin-dupla">
        <PinCampo
          ref={refSenha}
          id="tm-adm-senha"
          rotulo="PIN do terminal"
          valor={senha}
          alvo={alvo === 'senha'}
          tremor={tremor}
          aoFocar={() => setAlvo('senha')}
          aoTecla={tecla}
          aoEnviar={() => void enviar()}
        />
        <PinCampo
          id="tm-adm-cod"
          rotulo="Código do autenticador"
          valor={codigo}
          aberto
          alvo={alvo === 'codigo'}
          aoFocar={() => setAlvo('codigo')}
          aoTecla={tecla}
          aoEnviar={() => void enviar()}
        />
      </div>
      <Teclado rotulo="Teclado numérico da saída administrativa" aoTecla={tecla} />
      <button type="button" className="tm-link tm-link--mini" onClick={() => setLetras((v) => !v)}>
        {letras ? 'Usar o teclado numérico da tela' : 'Minha matrícula tem letras'}
      </button>
      <MensagemErro texto={erro} />
      <div className="tm-acoes">
        <Botao className="tm-botao-grande" onClick={aoCancelar}>
          Cancelar
        </Botao>
        <Botao type="submit" variante="acao" className="tm-botao-grande" disabled={enviando} aria-busy={enviando}>
          <Icone nome="escudo" tamanho={22} /> {enviando ? 'Conferindo…' : 'Liberar o tablet'}
        </Botao>
      </div>
    </form>
  );
}

export function SaidaAdmin() {
  const { adminAberto, setAdminAberto } = useTerminal();
  return (
    <Dialog
      aberto={adminAberto}
      aoFechar={() => setAdminAberto(false)}
      titulo="Liberar o tablet"
      descricao="Só administração, gestão ou almoxarifado: matrícula, PIN do terminal e código de 6 dígitos do autenticador."
      largo
    >
      {adminAberto && <FormAdmin aoCancelar={() => setAdminAberto(false)} />}
    </Dialog>
  );
}

export function Saindo() {
  const { saindo } = useTerminal();
  return (
    <AnimatePresence>
      {saindo && (
        <m.div
          key="saindo"
          className="tm-saindo"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: MOVIMENTO.medio }}
        >
          <m.div
            className="bm-vidro tm-saindo__caixa"
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ duration: MOVIMENTO.lento, ease: MOVIMENTO.curva }}
          >
            <span className="tm-giro tm-giro--grande" aria-hidden="true" />
            <p>
              {saindo.motivo === 'inatividade'
                ? 'Sessão encerrada por inatividade.'
                : `Até a próxima${saindo.nome ? `, ${saindo.nome}` : ''}!`}
            </p>
            <small>Limpando o terminal para o próximo colaborador…</small>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
