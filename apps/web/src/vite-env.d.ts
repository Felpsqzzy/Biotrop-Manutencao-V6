/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' no build de demonstração (`vite build --mode demo`); vazio no build normal. */
  readonly VITE_DEMO: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
