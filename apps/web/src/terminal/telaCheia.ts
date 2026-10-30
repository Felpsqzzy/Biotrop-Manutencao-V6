// Tela cheia no tablet: o navegador só aceita requestFullscreen dentro de um gesto da pessoa. A cada toque, se a página
// não está em tela cheia, pede de novo (o tablet pode sair dela com o gesto do sistema). Usa pointerup: no toque, só o
// pointerup (não o pointerdown) conta como gesto para o navegador; no mouse, o mousedown anterior já valeu.
import { useEffect } from 'react';

type DocW = Document & { webkitFullscreenElement?: Element | null };
type ElW = HTMLElement & { webkitRequestFullscreen?: () => void };

export function pedirTelaCheia(doc: Document = document) {
  const d = doc as DocW;
  if (d.fullscreenElement || d.webkitFullscreenElement) return;
  const el = d.documentElement as ElW;
  try {
    if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    else el.webkitRequestFullscreen?.();
  } catch {
    /* recusado ou sem suporte: segue sem tela cheia */
  }
}

export function useTelaCheia() {
  useEffect(() => {
    const aoTocar = () => pedirTelaCheia();
    document.addEventListener('pointerup', aoTocar, { passive: true });
    return () => document.removeEventListener('pointerup', aoTocar);
  }, []);
}
