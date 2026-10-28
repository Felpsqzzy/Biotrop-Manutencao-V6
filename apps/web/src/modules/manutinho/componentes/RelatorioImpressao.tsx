/** Relatório das preventivas para impressão A4 (PDF pelo "Salvar como PDF" do navegador). Só existe enquanto imprime. */
import { utilManutinho, type RelatorioPreventivasManutinho } from '@biomanut/shared';
import { ROTULO_SITUACAO } from '../exportar';

export function RelatorioImpressao({ rel, emitidoPor }: { rel: RelatorioPreventivasManutinho; emitidoPor: string }) {
  const t = rel.totais;
  return (
    <section className="manu-impressao" aria-label="Relatório das preventivas para impressão">
      <h1>BIOMANUT · Relatório das preventivas</h1>
      <p>
        Data de referência: {utilManutinho.dataBr(rel.hoje)} · emitido por {emitidoPor}
      </p>
      <p>
        {t.total} equipamentos: {t.atrasadas} com preventiva atrasada, {t.emDia} em dia e {t.semProgramacao} sem
        programação. Folhas abertas: {t.folhasAtrasadas} atrasadas e {t.folhasEmDia} a partir de hoje.
      </p>
      <h2>Por setor</h2>
      <table>
        <thead>
          <tr>
            <th>Setor</th>
            <th>Atrasadas</th>
            <th>Em dia</th>
            <th>Sem programação</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {rel.porSetor.map((s) => (
            <tr key={s.setor}>
              <td>{s.setor}</td>
              <td>{s.atrasadas}</td>
              <td>{s.emDia}</td>
              <td>{s.semProgramacao}</td>
              <td>{s.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Por equipamento</h2>
      <table>
        <thead>
          <tr>
            <th>Equipamento</th>
            <th>Setor</th>
            <th>CAMM</th>
            <th>Situação</th>
            <th>Atraso / próxima</th>
            <th>OMs abertas</th>
            <th>Última concluída</th>
          </tr>
        </thead>
        <tbody>
          {rel.equipamentos.map((e) => (
            <tr key={e.id}>
              <td>{e.codigo}</td>
              <td>{e.setor}</td>
              <td>{e.camm || '—'}</td>
              <td>{ROTULO_SITUACAO[e.situacao]}</td>
              <td>{e.situacao === 'atrasada' ? `${e.atrasoDias} dias` : utilManutinho.dataBr(e.proxima) || '—'}</td>
              <td>
                {e.folhas
                  .map((f) => f.numeroOm)
                  .filter(Boolean)
                  .join(', ') || '—'}
              </td>
              <td>{utilManutinho.dataBr(e.ultimaConcluida) || 'nunca'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
