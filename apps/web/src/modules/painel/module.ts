import type { ModuloDef } from '../tipos';

export const modulo: ModuloDef = {
  id: 'painel',
  rotulo: 'Painel',
  rotas: [{ path: '/', tela: 'inicio', pagina: () => import('./pages/PainelPage') }],
};
