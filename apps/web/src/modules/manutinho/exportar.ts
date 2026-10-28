/**
 * Export do relatório das preventivas: CSV (Excel abre direto: BOM, ponto e vírgula) e PDF pela impressão A4 do
 * navegador (CSS de impressão em manutinho.css, sem biblioteca). Nada de innerHTML: o CSV vira Blob.
 */
import { utilManutinho, type RelatorioPreventivasManutinho, type SituacaoManutinho } from '@biomanut/shared';

export const ROTULO_SITUACAO: Record<SituacaoManutinho, string> = {
  atrasada: 'Atrasada',
  em_dia: 'Em dia',
  sem_programacao: 'Sem programação',
};

/** Célula CSV: aspas quando precisa; fórmula (=, +, -, @) vira texto para o Excel não executar. */
export function celulaCsv(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvPreventivas(rel: RelatorioPreventivasManutinho): string {
  const cab = [
    'Equipamento',
    'Nome',
    'Setor',
    'CAMM',
    'Situação',
    'Dias de atraso',
    'Folhas abertas',
    'Próxima/atrasada desde',
    'OMs abertas',
    'Última concluída',
  ];
  const linhas = rel.equipamentos.map((e) => [
    e.codigo,
    e.nome,
    e.setor,
    e.camm,
    ROTULO_SITUACAO[e.situacao],
    e.atrasoDias,
    e.folhas.length,
    utilManutinho.dataBr(e.proxima),
    e.folhas
      .map((f) => f.numeroOm)
      .filter(Boolean)
      .join(' '),
    utilManutinho.dataBr(e.ultimaConcluida),
  ]);
  return '﻿' + [cab, ...linhas].map((l) => l.map(celulaCsv).join(';')).join('\r\n') + '\r\n';
}

export function baixarCsv(nome: string, conteudo: string): void {
  const url = URL.createObjectURL(new Blob([conteudo], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Imprime só o bloco do relatório (classe manu-imprimir no <html> liga o CSS de impressão do módulo). */
export function imprimirRelatorio(): void {
  const raiz = document.documentElement;
  raiz.classList.add('manu-imprimir');
  try {
    window.print();
  } finally {
    raiz.classList.remove('manu-imprimir');
  }
}
