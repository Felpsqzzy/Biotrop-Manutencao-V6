import type { ModuloDef } from '../tipos';

// Manutinho (assistente sem IA). Todo perfil com sessão vê: cada fonte do resumo é filtrada no servidor (RLS + escopo).
export const modulo: ModuloDef = {
  id: 'manutinho',
  rotulo: 'Manutinho',
  rotas: [{ path: '/manutinho', tela: 'inicio', pagina: () => import('./pages/ManutinhoPage') }],
};
