/** Tema claro/escuro: o mesmo atributo e a mesma chave que public/theme-boot.js usa antes da primeira pintura. */
export type Tema = 'claro' | 'escuro';

const CHAVE = 'bm.tema';

export function temaAtual(): Tema {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'escuro' : 'claro';
}

export function definirTema(tema: Tema): void {
  document.documentElement.setAttribute('data-theme', tema === 'escuro' ? 'dark' : 'light');
  try {
    localStorage.setItem(CHAVE, tema);
  } catch {
    /* aba privada: vale só nesta página */
  }
}

export function alternarTema(): Tema {
  const novo: Tema = temaAtual() === 'escuro' ? 'claro' : 'escuro';
  definirTema(novo);
  return novo;
}
