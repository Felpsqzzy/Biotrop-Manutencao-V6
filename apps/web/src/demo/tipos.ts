import type { Pedido, RespostaBruta } from '../lib/api/transport';

/** Rota do demo: responde o pedido ou devolve undefined (não é comigo). Cada módulo registra as suas em demo.ts. */
export type RotaDemo = (pedido: Pedido) => RespostaBruta | Promise<RespostaBruta> | undefined;
