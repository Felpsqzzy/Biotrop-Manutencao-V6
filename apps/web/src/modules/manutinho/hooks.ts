/**
 * React Query do Manutinho. Atualização (fase 1, sem realtime próprio): a cada 60 s, só com a aba visível
 * (refetchIntervalInBackground: false pausa o intervalo com a aba escondida). O Painel usa useManutinhoResumo().
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PedidoCobrancaManutinho } from '@biomanut/shared';
import { buscarRelatorioPreventivas, buscarResumo, buscarTreinamentosVencidos, enviarCobranca } from './api';

export const INTERVALO_MANUTINHO = 60_000;

export const CHAVES_MANUTINHO = {
  resumo: ['manutinho', 'resumo'] as const,
  relatorio: ['manutinho', 'relatorio-preventivas'] as const,
  treinamentos: ['manutinho', 'treinamentos-vencidos'] as const,
};

const atualizacao = { refetchInterval: INTERVALO_MANUTINHO, refetchIntervalInBackground: false, staleTime: 30_000 };

/** Avisos do Manutinho (crítico, atenção, info) das fontes que o perfil acessa. */
export function useManutinhoResumo(habilitado = true) {
  return useQuery({ queryKey: CHAVES_MANUTINHO.resumo, queryFn: buscarResumo, enabled: habilitado, ...atualizacao });
}

export function useRelatorioPreventivas(habilitado = true) {
  return useQuery({
    queryKey: CHAVES_MANUTINHO.relatorio,
    queryFn: buscarRelatorioPreventivas,
    enabled: habilitado,
    ...atualizacao,
  });
}

export function useTreinamentosVencidos(habilitado = true) {
  return useQuery({
    queryKey: CHAVES_MANUTINHO.treinamentos,
    queryFn: buscarTreinamentosVencidos,
    enabled: habilitado,
    ...atualizacao,
  });
}

export function useCobrarTreinamentos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pedido: PedidoCobrancaManutinho) => enviarCobranca(pedido),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVES_MANUTINHO.treinamentos }),
  });
}
