/**
 * Topo fixo (vidro): logotipo (segurar 3 s abre a saída administrativa), troca de módulo sem sair (Empréstimo ×
 * Retirada), nome de quem está no terminal e "Sair" sempre à vista.
 */
import { useEffect, useRef } from 'react';
import { m } from 'motion/react';
import { Icone, MOVIMENTO } from '../ui';
import { useTerminal } from './estado';
import { IconeTm } from './icones';
import { primeiroNome } from './regras';
import type { Modulo } from './tipos';

const SEGURAR_MS = 3000;

export const MODULOS: Record<Modulo, { nome: string; reg: string; icone: 'volta' | 'saida' }> = {
  emprestimo: { nome: 'Empréstimo', reg: 'EM', icone: 'volta' },
  retirada: { nome: 'Retirada', reg: 'RM', icone: 'saida' },
};

function Logotipo() {
  const { setAdminAberto } = useTerminal();
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soltar = () => {
    if (t.current) clearTimeout(t.current);
    t.current = null;
  };
  useEffect(() => soltar, []);
  return (
    <span
      className="tm-logo"
      data-testid="tm-logo"
      onPointerDown={() => {
        soltar();
        t.current = setTimeout(() => {
          t.current = null;
          setAdminAberto(true);
        }, SEGURAR_MS);
      }}
      onPointerUp={soltar}
      onPointerLeave={soltar}
      onPointerCancel={soltar}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="tm-logo__marca" aria-hidden="true">
        <IconeTm nome="chaveInglesa" tamanho={22} />
      </span>
      <span className="tm-logo__texto">
        <b>BIOTROP</b>
        <small>Terminal do Almoxarifado</small>
      </span>
    </span>
  );
}

export function Topo() {
  const { sessao, modulo, tela, ir, sair, ocupado } = useTerminal();
  const comModulo = !!sessao && tela !== 'modulos';
  return (
    <header className="bm-vidro tm-topo">
      <Logotipo />
      {comModulo && (
        <nav className="tm-troca" aria-label="Trocar de módulo">
          {(Object.keys(MODULOS) as Modulo[]).map((k) => {
            const ativo = modulo === k;
            return (
              <button
                key={k}
                type="button"
                className={`tm-troca__botao${ativo ? ' is-ativo' : ''}`}
                aria-pressed={ativo}
                disabled={ocupado}
                onClick={() => ir('inicio', k)}
              >
                {ativo && (
                  <m.span
                    className="tm-troca__fundo"
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: MOVIMENTO.medio, ease: MOVIMENTO.curva }}
                  />
                )}
                <IconeTm nome={MODULOS[k].icone} tamanho={20} />
                <span>{MODULOS[k].nome}</span>
              </button>
            );
          })}
        </nav>
      )}
      {sessao && (
        <div className="tm-topo__quem">
          <span className="tm-topo__nome">
            <Icone nome="usuario" tamanho={18} />
            {primeiroNome(sessao.colaborador.nome) || 'Colaborador'}
          </span>
          <button type="button" className="tm-sair" onClick={() => sair('logout')}>
            <Icone nome="sair" tamanho={20} /> Sair
          </button>
        </div>
      )}
    </header>
  );
}
