// Componentes e nomes do sistema visual. Módulos importam daqui (nunca de arquivos internos de src/ui).
export { Botao, type BotaoProps } from './Botao';
export { Superficie, type SuperficieProps } from './Superficie';
export { Card, GlassPanel, type CardProps, type GlassPanelProps } from './Card';
export { Badge, type BadgeProps, type TomBadge } from './Badge';
export { EmptyState, Skeleton, type EmptyStateProps, type SkeletonProps } from './EmptyState';
export { Tabs, type Aba, type TabsProps } from './Tabs';
export { Table, VirtualTable, type Coluna, type TableProps, type VirtualTableProps } from './Table';
export { Dialog, Drawer, type DialogProps, type DrawerProps } from './Dialog';
export { Kpi, type KpiProps, type Variacao } from './Kpi';
export { ToastProvider, useToast, type Aviso, type TomToast } from './Toast';
export {
  AreaChart,
  BarChart,
  DonutChart,
  LineChart,
  Sparkline,
  topoRedondo,
  type AreaChartProps,
  type Barra,
  type BarChartProps,
  type DonutChartProps,
  type Fatia,
  type Serie,
  type SparklineProps,
} from './graficos';
export { Icone, type IconeProps, type NomeIcone } from './Icone';
export { useContagem } from './useContagem';
export {
  alternarTema,
  definirTema,
  seguirSistema,
  temaAtual,
  temaEscolhido,
  type EscolhaTema,
  type Tema,
} from './tema';
// Duração e curva padrão das animações (só transform e opacity, de 150 a 250 ms).
export { MOVIMENTO, menosMovimento } from './movimento';

/** Classes globais do sistema (prefixo bm-). Classe de módulo usa o prefixo do próprio módulo. */
export const CLASSES = {
  vidro: 'bm-vidro',
  painel: 'bm-painel',
  botao: 'bm-botao',
  botaoAcao: 'bm-botao--acao',
} as const;
