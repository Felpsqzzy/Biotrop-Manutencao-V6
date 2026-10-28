/**
 * Transporte da API: HTTP (servidor Express, mesma origem, cookie de sessão) ou demo (em memória, sem servidor).
 * O modo sai do build (VITE_DEMO): no build normal o código do demo nem entra no pacote.
 */
import type { Metodo } from './client';

export interface Pedido {
  method: Metodo;
  path: string;
  body?: unknown;
}

export interface RespostaBruta {
  status: number;
  corpo: unknown;
}

export interface Transporte {
  enviar(pedido: Pedido): Promise<RespostaBruta>;
}

export const MODO_DEMO = import.meta.env.VITE_DEMO === '1';

export const transporteHttp: Transporte = {
  async enviar({ method, path, body }) {
    const r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const tipo = r.headers.get('content-type') || '';
    const corpo: unknown = tipo.includes('application/json') ? await r.json().catch(() => null) : null;
    return { status: r.status, corpo };
  },
};

let atual: Promise<Transporte> | null = null;

/** Transporte do build atual. O demo é carregado sob demanda (import()), só no build de demonstração. */
export function obterTransporte(): Promise<Transporte> {
  if (!atual) {
    atual = MODO_DEMO
      ? import('../../demo/transporte-demo').then((m) => m.transporteDemo)
      : Promise.resolve(transporteHttp);
  }
  return atual;
}

/** Só para testes: troca o transporte (ex.: msw ou um falso). */
export function definirTransporte(t: Transporte | null): void {
  atual = t ? Promise.resolve(t) : null;
}
