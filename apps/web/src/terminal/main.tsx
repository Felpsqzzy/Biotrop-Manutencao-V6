// Terminal do almoxarifado (tablet, /terminal): página própria, sem o site. Motion com LazyMotion + domAnimation
// (modo estrito: só `m`), MotionConfig reducedMotion="user" e os avisos (toast) do kit.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import '../ui/estilos.css';
import './terminal.css';
import { ToastProvider } from '../ui';
import { Terminal } from './App';

const raiz = document.getElementById('root');
if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <ToastProvider>
            <Terminal />
          </ToastProvider>
        </MotionConfig>
      </LazyMotion>
    </StrictMode>,
  );
}
