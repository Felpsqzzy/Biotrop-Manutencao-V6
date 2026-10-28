/** Busca no guia de uso do site (dado estático do pacote compartilhado, sem IA e sem servidor). */
import { useId, useMemo, useState } from 'react';
import { buscarGuia } from '@biomanut/shared';

export function BuscaGuia({ resultados = 2 }: { resultados?: number }) {
  const [texto, setTexto] = useState('');
  const id = useId();
  const achados = useMemo(() => buscarGuia(texto, resultados), [texto, resultados]);
  return (
    <div className="manu-guia">
      <label htmlFor={id} className="manu-rotulo">
        Dúvida de uso do site
      </label>
      <input
        id={id}
        type="search"
        className="manu-campo"
        placeholder="Ex.: como aponto bateladas?"
        value={texto}
        maxLength={200}
        onChange={(e) => setTexto(e.target.value)}
      />
      {texto.trim() ? (
        achados.length ? (
          <ul className="manu-guia-lista" aria-label="Respostas do guia">
            {achados.map((g) => (
              <li key={g.t} className="manu-guia-item">
                <b>{g.t}</b>
                {g.txt.split('\n').map((linha, n) => (
                  <p key={n}>{linha}</p>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="manu-vazio">Não achei nada no guia. Tente outras palavras ou fale com o seu gestor.</p>
        )
      ) : null}
    </div>
  );
}
