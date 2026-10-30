/** Duração e curva padrão das animações (só transform e opacity, de 150 a 250 ms). */
export const MOVIMENTO = { rapido: 0.15, medio: 0.2, lento: 0.25, curva: [0.22, 1, 0.36, 1] as const };

/** A pessoa pediu menos movimento no sistema. */
export function menosMovimento(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
