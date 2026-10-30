/** Tema claro/escuro: o mesmo atributo e a mesma chave que public/theme-boot.js usa antes da primeira pintura. */
export type Tema = 'claro' | 'escuro';
/** O que a pessoa escolheu: um tema fixo ou seguir o sistema (sem chave guardada). */
export type EscolhaTema = Tema | 'sistema';

const CHAVE = 'bm.tema';

export function temaAtual(): Tema {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'escuro' : 'claro';
}

export function temaEscolhido(): EscolhaTema {
  try {
    const t = localStorage.getItem(CHAVE);
    if (t === 'claro' || t === 'escuro') return t;
  } catch {
    /* aba privada */
  }
  return 'sistema';
}

export function definirTema(tema: Tema): void {
  document.documentElement.setAttribute('data-theme', tema === 'escuro' ? 'dark' : 'light');
  try {
    localStorage.setItem(CHAVE, tema);
  } catch {
    /* aba privada: vale só nesta página */
  }
}

/** Volta a seguir o tema do sistema (o mesmo cálculo do theme-boot.js). */
export function seguirSistema(): Tema {
  try {
    localStorage.removeItem(CHAVE);
  } catch {
    /* aba privada */
  }
  const escuro = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', escuro ? 'dark' : 'light');
  return escuro ? 'escuro' : 'claro';
}

export function alternarTema(): Tema {
  const novo: Tema = temaAtual() === 'escuro' ? 'claro' : 'escuro';
  definirTema(novo);
  return novo;
}
