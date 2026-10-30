/**
 * Telas sem sessão: entrada (matrícula + PIN de 6 dígitos no teclado da tela) e primeiro acesso / PIN novo (código do
 * convite + PIN duas vezes). Matrícula e PIN preenchidos pelo navegador são recusados e limpos: quem entra digita.
 * Teclado físico e leitor de crachá valem (sem campo em foco, os dígitos vão para o campo marcado).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { m } from 'motion/react';
import { Botao, Icone } from '../ui';
import { erroDe, MODO_DEMO } from './api';
import { useTerminal } from './estado';
import { IconeTm } from './icones';
import { PIN, problemaPin, texto } from './regras';
import { MensagemErro, PinCampo, preenchidoPeloNavegador, PREENCHIDO, Teclado } from './teclado';
import { DemoCredenciais } from './DemoCredenciais';

/** Fundo vivo do login: manchas de luz e partículas leves em CSS (transform/opacity; o único lugar com partículas). */
export function Fundo() {
  return (
    <div className="tm-fundo" aria-hidden="true">
      <span className="tm-fundo__luz tm-fundo__luz--a" />
      <span className="tm-fundo__luz tm-fundo__luz--b" />
      <span className="tm-fundo__luz tm-fundo__luz--c" />
      {Array.from({ length: 14 }, (_, i) => (
        <i
          key={i}
          className="tm-fundo__ponto"
          style={{
            left: `${(i * 37 + 11) % 100}%`,
            animationDelay: `${-((i * 1.7) % 14)}s`,
            animationDuration: `${12 + (i % 5) * 2.5}s`,
          }}
        />
      ))}
    </div>
  );
}

function useTeclaFisica(ativo: boolean, aoTecla: (k: string) => void) {
  const fn = useRef(aoTecla);
  fn.current = aoTecla;
  useEffect(() => {
    if (!ativo) return;
    const teclar = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      if (/^[0-9A-Za-z]$/.test(e.key) || e.key === 'Backspace') {
        e.preventDefault();
        fn.current(e.key === 'Backspace' ? 'apagar' : e.key);
      }
    };
    document.addEventListener('keydown', teclar);
    return () => document.removeEventListener('keydown', teclar);
  }, [ativo]);
}

type AlvoEntrada = 'matricula' | 'senha';

export function TelaEntrada() {
  const { chamar, aguardarLimpeza, abrirSessao, recado, ir, adminAberto } = useTerminal();
  const [matricula, setMatricula] = useState('');
  const [senha, setSenha] = useState('');
  const [alvo, setAlvo] = useState<AlvoEntrada>('matricula');
  const [letras, setLetras] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [tremor, setTremor] = useState(0);
  const refMat = useRef<HTMLInputElement>(null);
  const refPin = useRef<HTMLInputElement>(null);
  const estado = useRef({ matricula, senha, enviando });
  estado.current = { matricula, senha, enviando };

  function recusar() {
    setMatricula('');
    setSenha('');
    setAlvo('matricula');
    setErro(PREENCHIDO);
  }

  async function entrar(pin = senha) {
    if (estado.current.enviando) return;
    if (preenchidoPeloNavegador(refMat.current) || preenchidoPeloNavegador(refPin.current)) return recusar();
    const mat = texto(estado.current.matricula);
    // dois passos no mesmo botão: com a matrícula digitada e o teclado nela, "Continuar" passa para o PIN
    if (mat && !pin && alvo === 'matricula') {
      setErro('');
      setAlvo('senha');
      refPin.current?.focus({ preventScroll: true });
      return;
    }
    if (!mat) {
      setAlvo('matricula');
      return setErro('Informe a matrícula.');
    }
    if (!pin) {
      setAlvo('senha');
      return setErro('Digite o PIN de 6 dígitos.');
    }
    setErro('');
    setEnviando(true);
    await aguardarLimpeza();
    const r = await chamar('POST', '/entrar', { matricula: mat, senha: pin }, true);
    if (r.velho) return;
    setEnviando(false);
    if (r.ok) return abrirSessao(r.json);
    setSenha('');
    setAlvo('senha');
    setTremor((t) => t + 1);
    setErro(erroDe(r));
  }

  function tecla(k: string) {
    if (erro) setErro('');
    if (alvo === 'matricula') {
      setMatricula((v) =>
        k === 'apagar' ? v.slice(0, -1) : k === 'limpar' ? '' : v.length < 20 && /^[0-9A-Za-z]$/.test(k) ? v + k : v,
      );
      return;
    }
    if (/^[A-Za-z]$/.test(k)) {
      setAlvo('matricula');
      setMatricula((v) => (v.length < 20 ? v + k : v));
      return;
    }
    const v = senha;
    const novo = k === 'apagar' ? v.slice(0, -1) : k === 'limpar' ? '' : /^\d$/.test(k) && v.length < PIN ? v + k : v;
    setSenha(novo);
    // o 6º dígito entra (com a matrícula já digitada)
    if (novo.length === PIN && v.length < PIN) {
      if (texto(matricula)) void entrar(novo);
      else {
        setAlvo('matricula');
        setErro('Informe a matrícula.');
      }
    }
  }
  useTeclaFisica(!adminAberto, tecla);

  function enviar(e: FormEvent) {
    e.preventDefault();
    void entrar();
  }

  const continuar = alvo === 'matricula' && !senha;
  return (
    <section className="tm-entrada">
      <div className="tm-entrada__boas">
        <p className="tm-sobretitulo">
          <IconeTm nome="chaveInglesa" tamanho={18} /> Empréstimo e retirada de ferramentas
        </p>
        <h1 className="tm-titulo-grande">Acesso do colaborador</h1>
        <p className="tm-lead">Digite sua matrícula e o seu PIN de 6 dígitos no teclado da tela.</p>
        <ol className="tm-passos">
          <li>
            <b>1</b>Matrícula e PIN
          </li>
          <li>
            <b>2</b>Empréstimo ou retirada
          </li>
          <li>
            <b>3</b>Separe, confira e confirme
          </li>
        </ol>
        {MODO_DEMO && (
          <DemoCredenciais
            aoUsar={(mat, pin) => {
              setMatricula(mat);
              setSenha(pin);
              setAlvo('senha');
              setErro('');
            }}
          />
        )}
      </div>
      <form className="bm-painel tm-painel-vidro tm-form" autoComplete="off" noValidate onSubmit={enviar}>
        {recado && (
          <p className={`tm-recado tm-recado--${recado.tom}`} role="status">
            <Icone nome={recado.tom === 'ok' ? 'check' : 'info'} tamanho={18} />
            {recado.texto}
          </p>
        )}
        <div className="tm-campo-bloco">
          <label className="tm-rotulo" htmlFor="tm-matricula">
            Matrícula
          </label>
          <input
            ref={refMat}
            id="tm-matricula"
            name="tm-mat"
            className={`tm-campo tm-campo--mat${alvo === 'matricula' ? ' is-alvo' : ''}`}
            inputMode={letras ? 'text' : 'none'}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={20}
            placeholder="Toque e digite a matrícula"
            value={matricula}
            onFocus={() => setAlvo('matricula')}
            onChange={(e) => {
              if (preenchidoPeloNavegador(e.currentTarget)) return recusar();
              setMatricula(e.currentTarget.value.slice(0, 20));
              if (erro) setErro('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setAlvo('senha');
                refPin.current?.focus({ preventScroll: true });
              }
            }}
          />
        </div>
        <PinCampo
          ref={refPin}
          id="tm-senha"
          rotulo="PIN"
          valor={senha}
          alvo={alvo === 'senha'}
          tremor={tremor}
          aoFocar={() => setAlvo('senha')}
          aoTecla={(k) => {
            setAlvo('senha');
            tecla(k);
          }}
          aoEnviar={() => void entrar()}
        />
        <p className="tm-dica-teclado" aria-hidden="true">
          {alvo === 'matricula' ? 'Digitando a matrícula' : 'Digitando o PIN'}
        </p>
        <Teclado rotulo="Teclado numérico da matrícula e do PIN" aoTecla={tecla} />
        <button type="button" className="tm-link tm-link--mini" onClick={() => setLetras((v) => !v)}>
          {letras ? 'Usar o teclado numérico da tela' : 'Minha matrícula tem letras'}
        </button>
        <MensagemErro texto={erro} />
        <Botao type="submit" variante="acao" className="tm-botao-grande" disabled={enviando} aria-busy={enviando}>
          {enviando ? (
            <>
              <span className="tm-giro" aria-hidden="true" /> Entrando…
            </>
          ) : continuar ? (
            <>
              Continuar <Icone nome="direita" tamanho={22} />
            </>
          ) : (
            <>
              <IconeTm nome="entrar" /> Entrar
            </>
          )}
        </Botao>
        <button type="button" className="tm-link" onClick={() => ir('primeiro')}>
          <Icone nome="chave" tamanho={20} /> Primeiro acesso ou PIN novo (tenho um código)
        </button>
      </form>
    </section>
  );
}

type AlvoPrimeiro = 'pSenha' | 'pSenha2';

export function TelaPrimeiro() {
  const { chamar, aguardarLimpeza, abrirSessao, ir, adminAberto } = useTerminal();
  const [mat, setMat] = useState('');
  const [codigo, setCodigo] = useState('');
  const [s1, setS1] = useState('');
  const [s2, setS2] = useState('');
  const [alvo, setAlvo] = useState<AlvoPrimeiro>('pSenha');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [tremor, setTremor] = useState(0);
  const refMat = useRef<HTMLInputElement>(null);
  const ref1 = useRef<HTMLInputElement>(null);
  const ref2 = useRef<HTMLInputElement>(null);

  const motivo = problemaPin(s1, mat);
  const regras = [
    { ok: /^\d{6}$/.test(s1), texto: '6 dígitos' },
    { ok: /^\d{6}$/.test(s1) && !motivo, texto: 'Nem repetido nem sequência' },
    { ok: s1.length === PIN && s1 === s2, texto: 'Os dois PINs iguais' },
  ];

  function tecla(k: string) {
    if (erro) setErro('');
    const [v, set] = alvo === 'pSenha' ? [s1, setS1] : [s2, setS2];
    if (!/^(\d|apagar|limpar)$/.test(k)) return;
    const novo = k === 'apagar' ? v.slice(0, -1) : k === 'limpar' ? '' : v.length < PIN ? v + k : v;
    set(novo);
    if (alvo === 'pSenha' && novo.length === PIN && v.length < PIN) setAlvo('pSenha2');
  }
  useTeclaFisica(!adminAberto, tecla);

  async function enviar(e?: FormEvent) {
    e?.preventDefault();
    if (enviando) return;
    if ([refMat, ref1, ref2].some((r) => preenchidoPeloNavegador(r.current))) {
      setMat('');
      setS1('');
      setS2('');
      return setErro(PREENCHIDO);
    }
    if (!texto(mat) || !texto(codigo)) return setErro('Informe a matrícula e o código do convite.');
    if (!s1) {
      setAlvo('pSenha');
      return setErro('Crie o seu PIN de 6 dígitos no teclado da tela.');
    }
    if (s1 !== s2) {
      setAlvo('pSenha2');
      setTremor((t) => t + 1);
      return setErro('Os dois PINs não são iguais.');
    }
    setErro('');
    setEnviando(true);
    await aguardarLimpeza();
    // as regras do PIN são conferidas no servidor (a mensagem dele aparece aqui; a tela só acende os avisos)
    const r = await chamar(
      'POST',
      '/primeiro-acesso',
      { matricula: texto(mat), codigo: texto(codigo), senha: s1 },
      true,
    );
    if (r.velho) return;
    setEnviando(false);
    if (r.ok) return abrirSessao(r.json, 'PIN definido. Da próxima vez, entre com a matrícula e esse PIN.');
    setErro(erroDe(r));
  }

  return (
    <section className="tm-entrada">
      <div className="tm-entrada__boas">
        <button type="button" className="tm-voltar" onClick={() => ir('entrada')}>
          <Icone nome="esquerda" tamanho={22} /> Voltar
        </button>
        <h1 className="tm-titulo-grande">Primeiro acesso</h1>
        <p className="tm-lead">
          Use o código que o almoxarifado entregou a você (ex.: ABCD-EFGH). Ele vale por 72 horas e só pode ser usado
          uma vez. O mesmo caminho serve para criar um PIN novo.
        </p>
        <div className="bm-painel tm-regras">
          <h2>Regras do PIN</h2>
          <ul>
            <li>Exatamente 6 dígitos, digitados no teclado da tela.</li>
            <li>Não pode ter todos os dígitos iguais (111111).</li>
            <li>Não pode ser sequência (123456, 654321).</li>
            <li>Não pode ser igual aos 6 últimos dígitos da sua matrícula.</li>
          </ul>
          <p>Ninguém do almoxarifado vê o seu PIN. Não conte a ninguém.</p>
        </div>
      </div>
      <form className="bm-painel tm-painel-vidro tm-form" autoComplete="off" noValidate onSubmit={enviar}>
        <div className="tm-campo-bloco">
          <label className="tm-rotulo" htmlFor="tm-p-mat">
            Matrícula
          </label>
          <input
            ref={refMat}
            id="tm-p-mat"
            className="tm-campo"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={20}
            placeholder="Sua matrícula"
            value={mat}
            onChange={(e) => {
              if (preenchidoPeloNavegador(e.currentTarget)) {
                setMat('');
                return setErro(PREENCHIDO);
              }
              setMat(e.currentTarget.value.slice(0, 20));
            }}
          />
        </div>
        <div className="tm-campo-bloco">
          <label className="tm-rotulo" htmlFor="tm-p-cod">
            Código do convite
          </label>
          <input
            id="tm-p-cod"
            className="tm-campo tm-campo--codigo"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={16}
            placeholder="ABCD-EFGH"
            value={codigo}
            onChange={(e) => setCodigo(e.currentTarget.value.slice(0, 16))}
          />
        </div>
        <div className="tm-pin-dupla">
          <PinCampo
            ref={ref1}
            id="tm-p-senha"
            rotulo="PIN novo"
            valor={s1}
            alvo={alvo === 'pSenha'}
            aoFocar={() => setAlvo('pSenha')}
            aoTecla={tecla}
            aoEnviar={() => void enviar()}
          />
          <PinCampo
            ref={ref2}
            id="tm-p-senha2"
            rotulo="Repita o PIN"
            valor={s2}
            alvo={alvo === 'pSenha2'}
            tremor={tremor}
            aoFocar={() => setAlvo('pSenha2')}
            aoTecla={tecla}
            aoEnviar={() => void enviar()}
          />
        </div>
        <Teclado rotulo="Teclado numérico do PIN novo" aoTecla={tecla} />
        <ul className="tm-checagem" aria-live="polite">
          {regras.map((r) => (
            <li key={r.texto} className={r.ok ? 'is-ok' : ''}>
              <m.span animate={{ scale: r.ok ? 1 : 0.85, opacity: r.ok ? 1 : 0.5 }} transition={{ duration: 0.2 }}>
                <Icone nome="check" tamanho={18} />
              </m.span>
              {r.texto}
            </li>
          ))}
        </ul>
        <MensagemErro texto={erro} />
        <Botao type="submit" variante="acao" className="tm-botao-grande" disabled={enviando} aria-busy={enviando}>
          {enviando ? (
            <>
              <span className="tm-giro" aria-hidden="true" /> Salvando…
            </>
          ) : (
            <>
              <Icone nome="chave" tamanho={22} /> Definir PIN e entrar
            </>
          )}
        </Botao>
      </form>
    </section>
  );
}
