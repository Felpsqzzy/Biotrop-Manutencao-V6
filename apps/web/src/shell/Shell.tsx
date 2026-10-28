/**
 * Casca do app: menu (vidro), topo (vidro) e a área da página. Menu = rotas dos módulos que o perfil vê.
 * Sem sessão: botão de entrar com a conta Microsoft (o sistema não tem senha própria).
 */
import { m } from 'motion/react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { acessoDaTela, TELAS } from '@biomanut/shared';
import { URL_LOGIN, useSessao } from '../auth/useSessao';
import type { ModuloDef } from '../modules/tipos';
import { alternarTema, Botao, MOVIMENTO, Superficie } from '../ui';

export function Shell({ modulos }: { modulos: ModuloDef[] }) {
  const { data: usuario, isPending, isError } = useSessao();
  const { pathname } = useLocation();

  if (isPending) return null;
  if (isError)
    return <p className="p-6 text-bm-ink-2">Não foi possível falar com o servidor. Tente de novo em instantes.</p>;
  if (!usuario) {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <Superficie vidro className="w-full max-w-sm rounded-[var(--bm-r-lg)] p-8 text-center">
          <h1 className="text-xl font-semibold">BIOMANUT</h1>
          <p className="mt-2 text-bm-ink-2">Entre com a sua conta Microsoft da Biotrop.</p>
          <a className="bm-botao bm-botao--acao mt-6" href={URL_LOGIN}>
            Entrar
          </a>
        </Superficie>
      </main>
    );
  }

  const itens = modulos.flatMap((mod) =>
    mod.rotas
      .filter((r) => acessoDaTela(usuario.perfilId, r.tela))
      .map((r) => ({ path: r.path, rotulo: TELAS[r.tela].rotulo })),
  );

  return (
    <div className="grid min-h-dvh grid-cols-[var(--bm-side)_1fr] max-md:grid-cols-1">
      <Superficie vidro como="nav" aria-label="Menu" className="sticky top-0 h-dvh p-4 max-md:hidden">
        <p className="mb-4 font-semibold">BIOMANUT</p>
        <ul className="grid gap-1">
          {itens.map((i) => (
            <li key={i.path}>
              <NavLink
                to={i.path}
                className="block rounded-[var(--bm-r-ctl)] px-3 py-2 aria-[current=page]:text-bm-accent"
              >
                {i.rotulo}
              </NavLink>
            </li>
          ))}
        </ul>
      </Superficie>
      <div className="min-w-0">
        <Superficie
          vidro
          como="header"
          className="sticky top-0 z-10 flex h-[var(--bm-top)] items-center justify-between px-6"
        >
          <span className="text-bm-ink-2">{usuario.nome}</span>
          <Botao onClick={() => alternarTema()} aria-label="Alternar tema claro e escuro">
            Tema
          </Botao>
        </Superficie>
        <m.main
          key={pathname}
          className="p-6"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: MOVIMENTO.medio, ease: MOVIMENTO.curva }}
        >
          <Outlet />
        </m.main>
      </div>
    </div>
  );
}
