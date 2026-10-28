import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/estilos.css';
import { Providers } from './providers';
import { Router } from './router';

const raiz = document.getElementById('root');
if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <Providers>
        <Router />
      </Providers>
    </StrictMode>,
  );
}
