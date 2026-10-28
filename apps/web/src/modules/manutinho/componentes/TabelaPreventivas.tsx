/**
 * Equipamentos do relatório das preventivas. Acima de 100 linhas, virtualiza (@tanstack/react-virtual, regra do
 * CLAUDE.md); a impressão usa RelatorioImpressao, que traz todas as linhas.
 */
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { utilManutinho, type EquipamentoRelatorioManutinho } from '@biomanut/shared';
import { ROTULO_SITUACAO } from '../exportar';

export const LIMITE_SEM_VIRTUALIZAR = 100;
const ALTURA_LINHA = 44;

function Linha({ e }: { e: EquipamentoRelatorioManutinho }) {
  return (
    <>
      <span role="cell" className="manu-forte">
        {e.codigo}
      </span>
      <span role="cell">{e.setor}</span>
      <span role="cell">{e.camm || '—'}</span>
      <span role="cell">
        <span className={`manu-situacao manu-situacao--${e.situacao}`}>{ROTULO_SITUACAO[e.situacao]}</span>
      </span>
      <span role="cell">
        {e.situacao === 'atrasada'
          ? `${e.atrasoDias} ${e.atrasoDias === 1 ? 'dia' : 'dias'}`
          : utilManutinho.dataBr(e.proxima) || '—'}
      </span>
      <span role="cell">{utilManutinho.dataBr(e.ultimaConcluida) || 'nunca'}</span>
    </>
  );
}

function Cabecalho() {
  return (
    <div role="row" className="manu-linha manu-linha--cab">
      {['Equipamento', 'Setor', 'CAMM', 'Situação', 'Atraso / próxima', 'Última concluída'].map((c) => (
        <span key={c} role="columnheader">
          {c}
        </span>
      ))}
    </div>
  );
}

export function TabelaPreventivas({ equipamentos }: { equipamentos: EquipamentoRelatorioManutinho[] }) {
  const rolagem = useRef<HTMLDivElement>(null);
  const virtual = equipamentos.length > LIMITE_SEM_VIRTUALIZAR;
  const v = useVirtualizer({
    count: virtual ? equipamentos.length : 0,
    getScrollElement: () => rolagem.current,
    estimateSize: () => ALTURA_LINHA,
    overscan: 8,
  });
  if (!equipamentos.length) return <p className="manu-vazio">Nenhum equipamento de preventiva cadastrado.</p>;
  return (
    <div role="table" aria-label="Equipamentos e situação das preventivas" aria-rowcount={equipamentos.length + 1}>
      <Cabecalho />
      {virtual ? (
        <div ref={rolagem} className="manu-rolagem">
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((r) => {
              const e = equipamentos[r.index];
              if (!e) return null;
              return (
                <div
                  key={e.id}
                  role="row"
                  aria-rowindex={r.index + 2}
                  className="manu-linha"
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${r.start}px)` }}
                >
                  <Linha e={e} />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        equipamentos.map((e) => (
          <div key={e.id} role="row" className="manu-linha">
            <Linha e={e} />
          </div>
        ))
      )}
    </div>
  );
}
