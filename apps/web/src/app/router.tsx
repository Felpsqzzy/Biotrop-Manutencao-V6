/**
 * Rotas: cada src/modules/<id>/module.ts é achado por import.meta.glob (só os metadados, pequenos) e cada página
 * entra com React.lazy (um pedaço de JS por página). Quem vê cada rota: a tela dela na matriz de perfis (shared).
 */
import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { ModuloDef } from '../modules/tipos';
import { ExigeTela } from '../shell/ExigeTela';
import { Shell } from '../shell/Shell';

const registros = import.meta.glob<{ modulo: ModuloDef }>('../modules/*/module.ts', { eager: true });

export const MODULOS: ModuloDef[] = Object.values(registros).map((r) => r.modulo);

const ROTAS = MODULOS.flatMap((m) =>
  m.rotas.map((r) => ({ ...r, chave: `${m.id}:${r.path}`, Pagina: lazy(r.pagina) })),
);

export function Router() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell modulos={MODULOS} />}>
          {ROTAS.map(({ chave, path, tela, Pagina }) => (
            <Route
              key={chave}
              path={path}
              element={
                <ExigeTela tela={tela}>
                  <Suspense fallback={<p className="text-bm-ink-3">Carregando…</p>}>
                    <Pagina />
                  </Suspense>
                </ExigeTela>
              }
            />
          ))}
          <Route path="*" element={<p className="text-bm-ink-2">Página não encontrada.</p>} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
