/**
 * Topo fixo (vidro): logotipo (segurar 3 s abre a saída administrativa), nome de quem está no terminal e "Sair" sempre
 * à vista. Só empréstimo (49): a troca de módulo (Empréstimo × Retirada) saiu.
 */
import { useEffect, useRef } from 'react';
import { Icone } from '../ui';
import { useTerminal } from './estado';
import { IconeTm } from './icones';
import { primeiroNome } from './regras';

const SEGURAR_MS = 3000;

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
  const { sessao, sair } = useTerminal();
  return (
    <header className="bm-vidro tm-topo">
      <Logotipo />
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
