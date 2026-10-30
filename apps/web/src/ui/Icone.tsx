/**
 * Ícones em SVG próprio, no traço da Lucide (ISC), sem dependência: cada ícone é uma lista de formas, desenhadas com
 * elementos React (nada de innerHTML). Forma: 'M…' = path; 'c cx cy r' = circle; 'r x y w h rx' = rect.
 * Os desenhos do menu vêm da V5 (web/src/app.js, BT_SVG); os demais seguem a Lucide.
 */
import type { SVGProps } from 'react';

const ICONES = {
  inicio: ['M4 10.5 12 4l8 6.5', 'M6 9.8V19a1 1 0 0 0 1 1h3.5v-4.5h3V20H17a1 1 0 0 0 1-1V9.8'],
  consumo: ['c 12 12 8.2', 'M12 12l3.4-2.6', 'M12 4.4v1.6M19.6 12H18M12 19.6V18M4.4 12H6'],
  registros: ['M4 6.5h16M4 12h16M4 17.5h16', 'c 7.2 6.5 1.4', 'c 12.8 12 1.4', 'c 9.4 17.5 1.4'],
  medidores: ['r 3.4 4.6 17.2 14.8 3', 'M3.4 9.4h17.2', 'M8 14.2h8', 'M8 16.8h4.5'],
  solicitacao: [
    'M14.5 3.6H7a2 2 0 0 0-2 2v12.8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.1z',
    'M14.3 3.6v4.3h4.5',
    'M9.2 13h5.6M9.2 16.2h3.4',
  ],
  minhas: [
    'M14.5 3.6H7a2 2 0 0 0-2 2v12.8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.1z',
    'M14.3 3.6v4.3h4.5',
    'm8.8 13.6 1.8 1.8 3.6-3.6',
  ],
  fila: ['r 3.4 4.2 17.2 6 2', 'r 3.4 13.8 17.2 6 2', 'M7.2 7.2h.02M7.2 16.8h.02'],
  compra: [
    'c 9.4 19.4 1.5',
    'c 17.4 19.4 1.5',
    'M3 4h2.2l2.4 10.2a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.6-1.3L21 7.6H6.1',
  ],
  aprovar: ['M20.4 6.6 9.6 17.4l-6-6'],
  familias: ['r 3.6 3.6 7 7 2', 'r 13.4 3.6 7 7 2', 'r 3.6 13.4 7 7 2', 'r 13.4 13.4 7 7 2'],
  pcm: ['M14.9 6.3a3.6 3.6 0 0 0 4.9 4.9l-8.4 8.4a2.3 2.3 0 0 1-3.3-3.3z', 'M6.4 4.3l1.9 1.9M4.3 6.4l1.9 1.9'],
  treinar: [
    'M12 6.2 3.6 9.8 12 13.4l8.4-3.6z',
    'M6.6 11.5v4c0 1.6 2.4 2.8 5.4 2.8s5.4-1.2 5.4-2.8v-4',
    'M20.4 9.8v5.2',
  ],
  visaogeral: [
    'c 9 8.2 3.1',
    'M3.6 19.4c0-3 2.4-5.4 5.4-5.4s5.4 2.4 5.4 5.4',
    'M16.4 6.6a3 3 0 0 1 0 5.6',
    'M17.6 14.6c1.7.8 2.8 2.5 2.8 4.8',
  ],
  gestao: ['M17.3 3.4 20.6 6.7 9.4 17.9l-4.2 1 1-4.2z', 'M15.6 5.1l3.3 3.3'],
  admin: ['c 12 8 3.4', 'M5.2 20c0-3.8 3-6.6 6.8-6.6s6.8 2.8 6.8 6.6'],
  buscar: ['c 10.6 10.6 6.2', 'm15.2 15.2 4.4 4.4'],
  emprestimo: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z',
  ],
  bateladas: ['M9 3h6', 'M10 3v5.5L5.6 17a2.5 2.5 0 0 0 2.2 3.7h8.4a2.5 2.5 0 0 0 2.2-3.7L14 8.5V3', 'M7.5 14h9'],
  inventario: ['r 3 4 18 16 2', 'M7 8h10M7 12h10M7 16h6'],
  comprovante: ['r 4.4 3.6 15.2 16.8 2.5', 'M8.4 8.2h7.2M8.4 11.6h7.2M8.4 15h4', 'c 15.8 16.4 2.4'],
  auditoria: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  ],
  email: ['r 2 4 20 16 2', 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  // interface (Lucide)
  menu: ['M4 6h16M4 12h16M4 18h16'],
  recolher: ['r 3 4 18 16 3', 'M9 4v16', 'M15.5 9.5 13 12l2.5 2.5'],
  expandir: ['r 3 4 18 16 3', 'M9 4v16', 'M13 9.5 15.5 12 13 14.5'],
  fechar: ['M18 6 6 18', 'm6 6 12 12'],
  baixo: ['m6 9 6 6 6-6'],
  direita: ['m9 18 6-6-6-6'],
  esquerda: ['m15 18-6-6 6-6'],
  sol: [
    'c 12 12 4',
    'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
  ],
  lua: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  sair: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  usuario: ['c 12 8 4', 'M6 21v-1a6 6 0 0 1 12 0v1'],
  escudo: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'm9 12 2 2 4-4',
  ],
  chave: ['c 7.5 15.5 5.5', 'm21 2-9.6 9.6', 'm15.5 7.5 3 3L22 7l-3-3'],
  copiar: ['r 8 8 14 14 2', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  baixar: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  telefone: ['r 5 2 14 20 2', 'M12 18h.01'],
  energia: ['M12 2v10', 'M18.4 6.6a9 9 0 1 1-12.77.04'],
  check: ['M20 6 9 17l-5-5'],
  alerta: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: ['c 12 12 10', 'M12 16v-4', 'M12 8h.01'],
  obras: ['r 2 6 20 8 1', 'M17 14v7', 'M7 14v7', 'M17 3v3', 'M7 3v3', 'M10 14 2.3 6.3', 'm14 6 7.7 7.7', 'm8 6 8 8'],
  calendario: ['r 3 4 18 18 2', 'M16 2v4M8 2v4M3 10h18'],
  atividade: [
    'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
  ],
  sobe: ['M7 17 17 7', 'M7 7h10v10'],
  desce: ['M7 7l10 10', 'M17 7v10H7'],
  brilho: ['M9.94 14.06 4 20M14.06 9.94 20 4', 'M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z'],
  relogio: ['c 12 12 10', 'M12 6v6l4 2'],
} as const satisfies Record<string, readonly string[]>;

export type NomeIcone = keyof typeof ICONES;

export interface IconeProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  nome: NomeIcone;
  tamanho?: number;
  /** Texto para leitor de tela. Sem ele, o ícone é decorativo (aria-hidden). */
  rotulo?: string;
}

function forma(f: string, i: number) {
  const [tipo, ...n] = f.split(' ');
  if (tipo === 'c') return <circle key={i} cx={n[0]} cy={n[1]} r={n[2]} />;
  if (tipo === 'r') return <rect key={i} x={n[0]} y={n[1]} width={n[2]} height={n[3]} rx={n[4]} />;
  return <path key={i} d={f} />;
}

export function Icone({ nome, tamanho = 18, rotulo, ...resto }: IconeProps) {
  return (
    <svg
      width={tamanho}
      height={tamanho}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rotulo ? undefined : true}
      role={rotulo ? 'img' : undefined}
      aria-label={rotulo}
      focusable="false"
      {...resto}
    >
      {ICONES[nome].map(forma)}
    </svg>
  );
}
