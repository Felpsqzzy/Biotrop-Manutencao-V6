/** Sessão atual (GET /auth/me). 401 = sem sessão: o shell mostra o "Entrar com a conta Microsoft". */
import { useQuery } from '@tanstack/react-query';
import type { RespostaMe, UsuarioSessao } from '@biomanut/shared';
import { api, ErroApi } from '../lib/api/client';

export function useSessao() {
  return useQuery<UsuarioSessao | null>({
    queryKey: ['sessao'],
    queryFn: async () => {
      try {
        return (await api<RespostaMe>('GET', '/auth/me')).usuario;
      } catch (e) {
        if (e instanceof ErroApi && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

/** Login pelo Microsoft Entra ID (server/src/routes/auth.js). */
export const URL_LOGIN = '/auth/microsoft';
