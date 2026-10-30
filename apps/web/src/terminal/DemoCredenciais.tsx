/**
 * Só no build de demonstração: as matrículas e os PINs FICTÍCIOS ([DEMO]) num cantinho discreto da tela inicial.
 * O demo entra por import() (fora do demo este componente nem é desenhado e o ./demo não vai para o pacote).
 */
import { useEffect, useState } from 'react';
import { credenciaisDemo } from './api';
import type { CredencialDemo } from './demo';

export function DemoCredenciais({ aoUsar }: { aoUsar: (matricula: string, pin: string) => void }) {
  const [lista, setLista] = useState<CredencialDemo[]>([]);
  const [aberto, setAberto] = useState(false);
  useEffect(() => {
    let vivo = true;
    void credenciaisDemo().then((l) => vivo && setLista(l));
    return () => {
      vivo = false;
    };
  }, [aberto]);
  return (
    <details className="tm-demo" onToggle={(e) => setAberto(e.currentTarget.open)}>
      <summary>Demonstração: acessos fictícios</summary>
      <ul>
        {lista.map((c) => (
          <li key={c.matricula}>
            <span>
              <b>{c.matricula}</b> · {c.nome} ({c.papel})
              {c.pin ? ` · PIN ${c.pin}` : c.convite ? ` · convite ${c.convite}` : ''}
              {c.codigo2fa ? ` · autenticador ${c.codigo2fa}` : ''}
            </span>
            {c.pin && (
              <button type="button" className="tm-link tm-link--mini" onClick={() => aoUsar(c.matricula, c.pin!)}>
                Usar
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
