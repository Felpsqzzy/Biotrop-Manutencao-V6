/**
 * Avisos rápidos (toast): useToast().mostrar({ texto, tom }). Região aria-live no canto; cada aviso some em 4,5 s
 * (o temporizador só existe enquanto há aviso na tela) ou no botão fechar.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Icone } from './Icone';
import { MOVIMENTO } from './movimento';

export type TomToast = 'ok' | 'info' | 'ruim';
export interface Aviso {
  texto: string;
  tom?: TomToast;
}
interface AvisoNaTela extends Aviso {
  id: number;
}

const Contexto = createContext<{ mostrar: (a: Aviso) => void } | null>(null);
const DURACAO = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [lista, setLista] = useState<AvisoNaTela[]>([]);
  const proximo = useRef(1);
  const tirar = useCallback((id: number) => setLista((l) => l.filter((a) => a.id !== id)), []);
  const mostrar = useCallback((a: Aviso) => {
    const id = proximo.current++;
    setLista((l) => [...l.slice(-2), { ...a, id }]);
  }, []);
  const valor = useMemo(() => ({ mostrar }), [mostrar]);
  return (
    <Contexto.Provider value={valor}>
      {children}
      <div className="bm-avisos" role="region" aria-label="Avisos" aria-live="polite">
        <AnimatePresence initial={false}>
          {lista.map((a) => (
            <Toast key={a.id} aviso={a} aoFechar={() => tirar(a.id)} />
          ))}
        </AnimatePresence>
      </div>
    </Contexto.Provider>
  );
}

function Toast({ aviso, aoFechar }: { aviso: AvisoNaTela; aoFechar: () => void }) {
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;
  useEffect(() => {
    const t = setTimeout(() => fechar.current(), DURACAO);
    return () => clearTimeout(t);
  }, []);
  const tom = aviso.tom ?? 'info';
  return (
    <m.div
      layout={false}
      className={`bm-aviso bm-aviso--${tom}`}
      role={tom === 'ruim' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: MOVIMENTO.medio, ease: MOVIMENTO.curva }}
    >
      <Icone nome={tom === 'ok' ? 'check' : tom === 'ruim' ? 'alerta' : 'info'} tamanho={16} />
      <span>{aviso.texto}</span>
      <button type="button" className="bm-icone-botao bm-icone-botao--p" aria-label="Fechar aviso" onClick={aoFechar}>
        <Icone nome="fechar" tamanho={14} />
      </button>
    </m.div>
  );
}

export function useToast() {
  const c = useContext(Contexto);
  if (!c) throw new Error('useToast fora do ToastProvider.');
  return c;
}
