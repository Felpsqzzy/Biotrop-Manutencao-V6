/**
 * Contagem do número (0 → valor) SÓ na primeira vez que aquela chave aparece na sessão da página: voltar ao Painel,
 * trocar o período ou a atualização em tempo real mostram o valor direto. Dura 600 ms e para (nada de rAF contínuo);
 * com "reduzir movimento", nem começa.
 */
import { useEffect, useState } from 'react';
import { menosMovimento } from './movimento';

const jaContados = new Set<string>();
const DURACAO = 600;

/** Só para testes. */
export function esquecerContagens(): void {
  jaContados.clear();
}

export function useContagem(valor: number, chave: string): number {
  const [mostrado, setMostrado] = useState(() =>
    jaContados.has(chave) || menosMovimento() || typeof requestAnimationFrame !== 'function' ? valor : 0,
  );

  useEffect(() => {
    if (jaContados.has(chave) || menosMovimento() || typeof requestAnimationFrame !== 'function' || valor === 0) {
      jaContados.add(chave);
      setMostrado(valor);
      return;
    }
    let quadro = 0;
    const inicio = performance.now();
    const passo = (agora: number) => {
      const t = Math.min(1, (agora - inicio) / DURACAO);
      setMostrado(valor * (1 - Math.pow(1 - t, 3)));
      if (t < 1) quadro = requestAnimationFrame(passo);
      else jaContados.add(chave);
    };
    quadro = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro);
  }, [valor, chave]);

  return mostrado;
}
