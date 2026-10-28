/**
 * Tempo real: GET /api/realtime (SSE, server/src/routes/realtime.js) manda "change" { namespace, recordId, payload }.
 * Assinatura usada pelos módulos para invalidar as consultas do React Query. Fora do ar no modo demo.
 */
import { MODO_DEMO } from '../api/transport';

export interface Alteracao {
  namespace: string;
  recordId: string;
  payload: unknown;
}

/** Abre o canal e chama `aoMudar` a cada alteração. Devolve a função que fecha o canal. */
export function assinarAlteracoes(aoMudar: (a: Alteracao) => void): () => void {
  if (MODO_DEMO || typeof EventSource === 'undefined') return () => {};
  const fonte = new EventSource('/api/realtime', { withCredentials: true });
  const ouvir = (e: MessageEvent<string>) => {
    try {
      aoMudar(JSON.parse(e.data) as Alteracao);
    } catch {
      /* evento malformado: ignora */
    }
  };
  fonte.addEventListener('change', ouvir);
  return () => {
    fonte.removeEventListener('change', ouvir);
    fonte.close();
  };
}
