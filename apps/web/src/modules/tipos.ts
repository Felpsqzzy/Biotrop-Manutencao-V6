/**
 * Contrato de um módulo: cada pasta src/modules/<id>/ exporta `modulo` em module.ts. O roteador (src/app/router.tsx)
 * acha todos por import.meta.glob e carrega cada página com React.lazy. Layout de um módulo:
 *   module.ts (este contrato) · api.ts (chamadas com api<T>) · hooks.ts (React Query) · pages/ · demo.ts (rotas do demo)
 */
import type { ComponentType } from 'react';
import type { TelaId } from '@biomanut/shared';

export interface RotaModulo {
  /** Caminho absoluto (ex.: '/', '/almoxarifado/sci/nova'). */
  path: string;
  /** Tela da matriz de perfis (packages/shared/src/perfis.ts) que decide quem vê. */
  tela: TelaId;
  /** Página carregada sob demanda. */
  pagina: () => Promise<{ default: ComponentType }>;
}

export interface ModuloDef {
  id: string;
  rotulo: string;
  rotas: RotaModulo[];
}
