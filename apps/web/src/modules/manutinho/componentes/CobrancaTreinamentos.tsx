/**
 * Treinamentos vencidos da equipe e a cobrança por e-mail (modelo fixo). Só admin, gestor e líder veem o botão; quem
 * decide de verdade é a função lms.copiloto_cobrar no banco (perfil, equipe, 1 por pessoa a cada 24 h, 40 por dia).
 */
import { useMemo, useState } from 'react';
import { modeloCobranca, type PerfilId, type TreinamentoVencidoManutinho } from '@biomanut/shared';
import { Botao } from '../../../ui';
import { ErroApi } from '../../../lib/api/client';
import { useCobrarTreinamentos } from '../hooks';

export const PODE_COBRAR: ReadonlySet<PerfilId> = new Set<PerfilId>(['admin', 'gestor', 'lider']);
const MAX_POR_ENVIO = 25;

interface Pessoa {
  id: string;
  nome: string;
  cursos: string[];
}

export function agruparPorPessoa(vencidos: TreinamentoVencidoManutinho[]): Pessoa[] {
  const m = new Map<string, Pessoa>();
  for (const v of vencidos) {
    const p = m.get(v.pessoaId) ?? { id: v.pessoaId, nome: v.pessoa, cursos: [] };
    if (!p.cursos.includes(v.curso)) p.cursos.push(v.curso);
    m.set(v.pessoaId, p);
  }
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
}

export function CobrancaTreinamentos({
  vencidos,
  perfil,
  euId,
  euNome,
}: {
  vencidos: TreinamentoVencidoManutinho[];
  perfil: PerfilId;
  euId: string;
  euNome: string;
}) {
  const pessoas = useMemo(() => agruparPorPessoa(vencidos), [vencidos]);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const cobrar = useCobrarTreinamentos();
  const pode = PODE_COBRAR.has(perfil);
  const escolhidas = pessoas.filter((p) => marcadas.has(p.id));
  const modelo = modeloCobranca(euNome, escolhidas[0]?.cursos ?? ['']);

  function alternar(id: string) {
    setMarcadas((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < MAX_POR_ENVIO) n.add(id);
      return n;
    });
  }
  function enviar() {
    cobrar.mutate(
      { itens: escolhidas.map((p) => ({ pessoaId: p.id, cursos: p.cursos.slice(0, 10) })) },
      { onSuccess: () => setMarcadas(new Set()) },
    );
  }

  if (!pessoas.length) return <p className="manu-vazio">Nenhum treinamento obrigatório vencido.</p>;
  return (
    <div className="manu-cobranca">
      <ul className="manu-pessoas" aria-label="Treinamentos vencidos">
        {pessoas.map((p) => {
          const marcavel = pode && p.id !== euId;
          return (
            <li key={p.id} className="manu-pessoa">
              {marcavel ? (
                <label className="manu-marcar">
                  <input type="checkbox" checked={marcadas.has(p.id)} onChange={() => alternar(p.id)} />
                  <b>{p.nome}</b>
                </label>
              ) : (
                <b>{p.nome}</b>
              )}
              <span className="manu-aviso-detalhe">{p.cursos.join(', ')}</span>
            </li>
          );
        })}
      </ul>
      {pode ? (
        <div className="manu-cobranca-acoes">
          {escolhidas.length ? (
            <div className="manu-previa" aria-label="Prévia do e-mail">
              <p className="manu-rotulo">Prévia (modelo fixo) · {modelo.assunto}</p>
              <p>{modelo.paragrafos[0]}</p>
              <p>{modelo.paragrafos[1]}</p>
            </div>
          ) : null}
          <Botao variante="acao" disabled={!escolhidas.length || cobrar.isPending} onClick={enviar}>
            {cobrar.isPending ? 'Enviando…' : `Enviar cobrança${escolhidas.length ? ` (${escolhidas.length})` : ''}`}
          </Botao>
          <p className="manu-nota" role="status">
            {cobrar.isSuccess
              ? `${cobrar.data.enviados} ${cobrar.data.enviados === 1 ? 'cobrança enviada' : 'cobranças enviadas'}.${cobrar.data.avisos.length ? ' ' + cobrar.data.avisos.join(' ') : ''}`
              : cobrar.isError
                ? cobrar.error instanceof ErroApi
                  ? cobrar.error.message
                  : 'Não foi possível enviar a cobrança.'
                : 'Cada pessoa recebe no máximo uma cobrança por dia; você vai em cópia.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
