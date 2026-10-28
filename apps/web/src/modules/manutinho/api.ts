/** Chamadas do Manutinho (server/src/routes/manutinho.js). O servidor já devolve só o que o perfil pode ver. */
import type {
  PedidoCobrancaManutinho,
  RespostaCobrancaManutinho,
  RespostaRelatorioManutinho,
  RespostaResumoManutinho,
  TreinamentoVencidoManutinho,
} from '@biomanut/shared';
import { api } from '../../lib/api/client';

export const BASE_MANUTINHO = '/api/manutinho';

export function buscarResumo(): Promise<RespostaResumoManutinho> {
  return api<RespostaResumoManutinho>('GET', `${BASE_MANUTINHO}/resumo`);
}

export function buscarRelatorioPreventivas(): Promise<RespostaRelatorioManutinho> {
  return api<RespostaRelatorioManutinho>('GET', `${BASE_MANUTINHO}/relatorio-preventivas`);
}

export async function buscarTreinamentosVencidos(): Promise<TreinamentoVencidoManutinho[]> {
  return (
    await api<{ ok: true; vencidos: TreinamentoVencidoManutinho[] }>('GET', `${BASE_MANUTINHO}/treinamentos-vencidos`)
  ).vencidos;
}

export function enviarCobranca(pedido: PedidoCobrancaManutinho): Promise<RespostaCobrancaManutinho> {
  return api<RespostaCobrancaManutinho>('POST', `${BASE_MANUTINHO}/cobrar`, pedido);
}
