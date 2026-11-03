// Tela sempre acesa no tablet enquanto o terminal está aberto (Screen Wake Lock; só em HTTPS ou localhost). O sistema
// solta a trava quando a aba some ou a bateria aperta: pede de novo ao voltar a ficar visível, quando a trava cai e a
// cada toque/tecla (cobre o navegador que recusa sem gesto). Solta no pagehide e ao desmontar. Sem suporte: não faz nada.
// Usa document.hidden de propósito: comparar o estado em texto faz o Tailwind (que lê todo o fonte) gerar uma classe a mais.
import { useEffect } from 'react';

export function useTelaAtiva(nav: Navigator = navigator, doc: Document = document) {
  useEffect(() => {
    const wl = (nav as Partial<Navigator>).wakeLock;
    if (!wl) return;
    let trava: WakeLockSentinel | null = null;
    let pedindo = false;
    let ativo = true;

    const pedir = async () => {
      if (!ativo || trava || pedindo || doc.hidden) return;
      pedindo = true;
      try {
        const t = await wl.request('screen');
        if (!ativo) {
          void t.release().catch(() => undefined);
          return;
        }
        trava = t;
        // caiu pelo sistema (não por nós, que zeramos a trava antes de soltar): pede outra
        t.addEventListener('release', () => {
          if (trava !== t) return;
          trava = null;
          void pedir();
        });
      } catch {
        /* recusado (sem gesto, aba oculta, economia de bateria): tenta no próximo toque ou ao voltar */
      } finally {
        pedindo = false;
      }
    };
    const soltar = () => {
      const t = trava;
      trava = null;
      if (t) void t.release().catch(() => undefined);
    };
    const aoMudarVisibilidade = () => {
      if (!doc.hidden) void pedir();
    };
    const aoTocar = () => void pedir();

    void pedir();
    doc.addEventListener('visibilitychange', aoMudarVisibilidade);
    doc.addEventListener('pointerup', aoTocar, { passive: true });
    doc.addEventListener('keydown', aoTocar);
    window.addEventListener('pagehide', soltar);
    return () => {
      ativo = false;
      doc.removeEventListener('visibilitychange', aoMudarVisibilidade);
      doc.removeEventListener('pointerup', aoTocar);
      doc.removeEventListener('keydown', aoTocar);
      window.removeEventListener('pagehide', soltar);
      soltar();
    };
  }, [nav, doc]);
}
