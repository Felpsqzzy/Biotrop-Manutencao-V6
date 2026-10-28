// Vite multi-página: index.html (site) e terminal.html (tablet do almoxarifado).
// Modo demo (`vite build --mode demo`): VITE_DEMO=1 liga o transporte em memória (src/lib/api/transport.ts), sem servidor.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_DEMO': JSON.stringify(mode === 'demo' ? '1' : ''),
  },
  server: {
    // Em dev, a API é o servidor Express local (npm start na raiz, porta 3000).
    proxy: { '/api': 'http://127.0.0.1:3000', '/auth': 'http://127.0.0.1:3000' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Sem o polyfill de modulepreload: ele entra como <script> inline e a CSP (script-src 'self') o recusaria.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        terminal: resolve(import.meta.dirname, 'terminal.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
}));
