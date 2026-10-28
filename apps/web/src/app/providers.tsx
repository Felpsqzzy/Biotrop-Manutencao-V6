/**
 * Providers do app: React Query e Motion. Motion sempre com LazyMotion + domAnimation (só o necessário, modo estrito:
 * usar `m`, nunca `motion.*`) e MotionConfig reducedMotion="user" (quem pede menos movimento no sistema não vê animação).
 */
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import { ErroApi } from '../lib/api/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx não melhora repetindo; falha de rede ou 5xx tenta mais uma vez
      retry: (tentativas, erro) => !(erro instanceof ErroApi && erro.status < 500) && tentativas < 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  );
}
