// Terminal do almoxarifado (tablet, /terminal): página própria, sem o site. A tela de verdade entra na fase do empréstimo.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/estilos.css';
import { Superficie } from '../ui';

const raiz = document.getElementById('root');
if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <main className="grid min-h-dvh place-items-center p-6">
        <Superficie vidro className="w-full max-w-md rounded-[var(--bm-r-lg)] p-8 text-center">
          <h1 className="text-xl font-semibold">Terminal do Almoxarifado</h1>
          <p className="mt-2 text-bm-ink-2">Em construção na V6.</p>
        </Superficie>
      </main>
    </StrictMode>,
  );
}
