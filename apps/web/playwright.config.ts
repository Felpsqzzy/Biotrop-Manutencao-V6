// Testes de navegador (e2e). Sobem o build de demonstração com o preview do Vite: nenhum dado real, nenhum servidor.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: { command: 'npm run build:demo && npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
});
