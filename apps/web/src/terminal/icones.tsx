/**
 * Ícones do terminal que o kit (src/ui/Icone.tsx) não tem. Mesmo traço (viewBox 24, stroke 1.75, pontas redondas, no
 * estilo da Lucide/ISC) e mesmo formato: cada ícone é uma lista de formas desenhadas com elementos React.
 * Forma: 'M…' = path; 'c cx cy r' = circle; 'r x y w h rx' = rect.
 */
import type { SVGProps } from 'react';

const ICONES = {
  devolver: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  volta: ['M17 2l4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'],
  caixa: ['M21 8 12 3 3 8v8l9 5 9-5Z', 'm3 8 9 5 9-5', 'M12 13v8'],
  saida: ['M21 8 12 3 3 8v8l9 5 9-5Z', 'm3 8 9 5 9-5', 'M12 13v8', 'M16 5.2 7.5 10'],
  etiqueta: ['M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z', 'c 7.5 7.5 1.5'],
  local: ['M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z', 'c 12 9 2.5'],
  mais: ['M12 5v14', 'M5 12h14'],
  menos: ['M5 12h14'],
  apagar: ['M21 5H9l-7 7 7 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z', 'm17 9-6 6', 'm11 9 6 6'],
  grade: ['r 3.5 3.5 7 7 1.8', 'r 13.5 3.5 7 7 1.8', 'r 3.5 13.5 7 7 1.8', 'r 13.5 13.5 7 7 1.8'],
  lista: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  lixo: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  separar: [
    'M5 7h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9Z',
    'M9 7V5.5a3 3 0 0 1 6 0V7',
    'M12 11v5',
    'M9.5 13.5h5',
  ],
  bandeja: [
    'M22 12h-6l-2 3h-4l-2-3H2',
    'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  ],
  entrar: ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'm10 17 5-5-5-5', 'M15 12H3'],
  raio: ['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],
  regua: [
    'M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z',
    'm14.5 12.5 2-2',
    'm11.5 9.5 2-2',
    'm8.5 6.5 2-2',
    'm17.5 15.5 2-2',
  ],
  chaveInglesa: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z',
  ],
  lanterna: ['M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z', 'M6 6h12', 'M12 12v2'],
  capacete: [
    'M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1z',
    'M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5',
    'M4 15v-3a6 6 0 0 1 6-6',
    'M14 6a6 6 0 0 1 6 6v3',
  ],
  historico: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  trocar: ['m16 3 4 4-4 4', 'M20 7H4', 'm8 21-4-4 4-4', 'M4 17h16'],
  separado: ['c 12 12 9', 'm8.5 12 2.5 2.5 4.5-5'],
} as const satisfies Record<string, readonly string[]>;

export type NomeIconeTm = keyof typeof ICONES;

function forma(f: string, i: number) {
  const [tipo, ...n] = f.split(' ');
  if (tipo === 'c') return <circle key={i} cx={n[0]} cy={n[1]} r={n[2]} />;
  if (tipo === 'r') return <rect key={i} x={n[0]} y={n[1]} width={n[2]} height={n[3]} rx={n[4]} />;
  return <path key={i} d={f} />;
}

export function IconeTm({
  nome,
  tamanho = 22,
  ...resto
}: { nome: NomeIconeTm; tamanho?: number } & Omit<SVGProps<SVGSVGElement>, 'children'>) {
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
      aria-hidden
      focusable="false"
      {...resto}
    >
      {ICONES[nome].map(forma)}
    </svg>
  );
}

/** Ícone que representa a categoria (quadro dos cartões sem foto). */
export function iconeCategoria(categoria: string): NomeIconeTm {
  const c = categoria.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (c.includes('eletric')) return 'raio';
  if (c.includes('medic')) return 'regua';
  if (c.includes('ilumin')) return 'lanterna';
  if (c.includes('seguran') || c.includes('acesso')) return 'capacete';
  if (c.includes('consum')) return 'caixa';
  return 'chaveInglesa';
}
