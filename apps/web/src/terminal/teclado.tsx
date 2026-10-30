/**
 * Teclado numérico da tela e campo do PIN. O PIN só entra por aqui (ou pelo teclado físico com o campo em foco): o
 * <input> é readonly com inputMode="none" (tocar não abre o teclado do tablet) e fica por cima das 6 bolinhas.
 */
import { forwardRef, type KeyboardEvent } from 'react';
import { m } from 'motion/react';
import { Icone } from '../ui';
import { IconeTm } from './icones';
import { PIN } from './regras';

export const PREENCHIDO = 'Por segurança, o terminal não usa matrícula nem PIN guardados no navegador. Digite os seus.';

/**
 * O navegador preencheu o campo (senha guardada, sugestão escolhida)? No tablet compartilhado seria a credencial de
 * outra pessoa: o terminal nunca aceita. :autofill é o padrão; :-webkit-autofill, o dos navegadores antigos.
 */
export function preenchidoPeloNavegador(el: Element | null | undefined): boolean {
  if (!el) return false;
  for (const sel of [':autofill', ':-webkit-autofill']) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* seletor desconhecido */
    }
  }
  return false;
}

export function Teclado({ aoTecla, rotulo }: { aoTecla: (k: string) => void; rotulo: string }) {
  const tecla = (k: string, conteudo: React.ReactNode, extra?: { classe?: string; aria?: string }) => (
    <m.button
      key={k}
      type="button"
      className={`tm-tecla ${extra?.classe ?? ''}`}
      aria-label={extra?.aria}
      whileTap={{ scale: 0.92 }}
      transition={{ duration: 0.15 }}
      onClick={() => aoTecla(k)}
    >
      {conteudo}
    </m.button>
  );
  return (
    <div className="tm-teclado" role="group" aria-label={rotulo}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => tecla(n, n))}
      {tecla('limpar', 'Limpar', { classe: 'tm-tecla--fn' })}
      {tecla('0', '0')}
      {tecla('apagar', <IconeTm nome="apagar" tamanho={26} />, {
        classe: 'tm-tecla--fn',
        aria: 'Apagar o último dígito',
      })}
    </div>
  );
}

interface PinCampoProps {
  id: string;
  rotulo: string;
  valor: string;
  alvo: boolean;
  /** Mostra os dígitos (código do autenticador: não é segredo guardado e a pessoa confere o que digitou). */
  aberto?: boolean;
  /** Muda a cada erro: as bolinhas balançam. */
  tremor?: number;
  aoFocar: () => void;
  aoTecla: (k: string) => void;
  aoEnviar: () => void;
}

export const PinCampo = forwardRef<HTMLInputElement, PinCampoProps>(function PinCampo(
  { id, rotulo, valor, alvo, aberto, tremor = 0, aoFocar, aoTecla, aoEnviar },
  ref,
) {
  const teclar = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (/^\d$/.test(e.key) || e.key === 'Backspace') {
      e.preventDefault();
      aoTecla(e.key === 'Backspace' ? 'apagar' : e.key);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      aoEnviar();
    }
  };
  return (
    <div className="tm-campo-bloco">
      <label className="tm-rotulo" htmlFor={id}>
        {rotulo}
      </label>
      <m.div
        key={tremor}
        className={`tm-pin${alvo ? ' is-alvo' : ''}`}
        animate={tremor ? { x: [0, -10, 10, -7, 7, -3, 0] } : undefined}
        transition={{ duration: 0.25 }}
      >
        <span className="tm-pin__pontos" aria-hidden="true">
          {Array.from({ length: PIN }, (_, i) => (
            <i
              key={i}
              className={`tm-pin__ponto${i < valor.length ? ' is-on' : ''}${alvo && i === valor.length ? ' is-cursor' : ''}`}
            >
              {aberto && i < valor.length ? valor[i] : ''}
            </i>
          ))}
        </span>
        <input
          ref={ref}
          id={id}
          className="tm-pin__campo"
          type={aberto ? 'text' : 'password'}
          inputMode="none"
          readOnly
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={PIN}
          value={valor}
          aria-label={`${rotulo}, ${valor.length} de ${PIN} dígitos`}
          onFocus={aoFocar}
          onClick={aoFocar}
          onKeyDown={teclar}
        />
      </m.div>
    </div>
  );
});

export function MensagemErro({ texto }: { texto: string }) {
  return (
    <p className="tm-erro" role="alert">
      {texto && <Icone nome="alerta" tamanho={18} />}
      {texto}
    </p>
  );
}
