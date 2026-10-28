// Esconder a tela não fecha a rota: a API e a RLS continuam sendo a barreira. Aqui só evita mostrar o que o perfil não vê.
import type { ReactNode } from 'react';
import { acessoDaTela, type TelaId } from '@biomanut/shared';
import { useSessao } from '../auth/useSessao';

export function ExigeTela({ tela, children }: { tela: TelaId; children: ReactNode }) {
  const { data: usuario } = useSessao();
  if (!usuario) return null;
  if (!acessoDaTela(usuario.perfilId, tela))
    return <p className="text-bm-ink-2">Seu perfil não tem acesso a esta tela.</p>;
  return <>{children}</>;
}
