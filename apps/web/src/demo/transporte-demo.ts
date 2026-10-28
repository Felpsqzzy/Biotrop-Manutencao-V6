/**
 * Transporte do modo demonstração: responde em memória, sem servidor. Só entra no build `--mode demo`
 * (import() em lib/api/transport.ts). Pessoas e dados FICTÍCIOS, identificados com [DEMO].
 */
import { ehPerfil, type PerfilId, type RespostaMe } from '@biomanut/shared';
import type { Transporte } from '../lib/api/transport';
import type { RotaDemo } from './tipos';

/** Perfil da demonstração: ?perfil=tecnico na URL troca (padrão admin). */
function perfilDemo(): PerfilId {
  const p = new URLSearchParams(globalThis.location?.search || '').get('perfil');
  return ehPerfil(p) ? p : 'admin';
}

const rotasBase: RotaDemo[] = [
  ({ method, path }) => {
    if (method !== 'GET' || path !== '/auth/me') return undefined;
    const perfilId = perfilDemo();
    const corpo: RespostaMe = {
      ok: true,
      usuario: {
        id: 'demo-' + perfilId,
        nome: `[DEMO] Pessoa ${perfilId}`,
        email: `${perfilId}@demo.invalid`,
        perfilId,
      },
    };
    return { status: 200, corpo };
  },
];

// rotas de cada módulo (modules/<id>/demo.ts exporta `rotas`)
const rotasModulos = Object.values(
  import.meta.glob<{ rotas: RotaDemo[] }>('../modules/*/demo.ts', { eager: true }),
).flatMap((m) => m.rotas);

export const transporteDemo: Transporte = {
  async enviar(pedido) {
    for (const rota of [...rotasBase, ...rotasModulos]) {
      const r = await rota(pedido);
      if (r) return r;
    }
    return { status: 404, corpo: { ok: false, erro: 'Rota sem resposta no modo demonstração.' } };
  },
};
