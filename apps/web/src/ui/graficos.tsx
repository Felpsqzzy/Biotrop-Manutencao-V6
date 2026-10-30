/**
 * Gráficos em SVG próprio (sem biblioteca): área/linha com dica, barras, rosca e linha mínima (spark).
 * Desempenho: o SVG tem viewBox fixo e escala com a largura (CSS); a dica não lê layout nenhum: cada ponto tem uma
 * faixa invisível que avisa pointerenter/focus, e a dica é posicionada em % do viewBox. Nada anima sozinho.
 * Acessível: role="img" com um resumo em texto; a dica também abre pelo teclado (setas, com o gráfico em foco).
 */
import { useId, useState } from 'react';

const L = 640;
const A = 200;
const M = { cima: 12, dir: 8, baixo: 24, esq: 36 };

export interface Serie {
  nome: string;
  /** Cor (variável CSS, ex.: 'var(--bm-violet)'). */
  cor: string;
  valores: readonly number[];
}

export interface AreaChartProps {
  series: readonly Serie[];
  /** Rótulo de cada ponto do eixo x (mesmo tamanho das séries). */
  rotulos: readonly string[];
  /** Resumo para leitor de tela. */
  resumo: string;
  /** false = só as linhas (LineChart). */
  area?: boolean;
  formato?: (n: number) => string;
  className?: string;
}

/** Topo do eixo y "redondo" (1, 2, 5 × 10^n) acima do maior valor. */
export function topoRedondo(max: number): number {
  if (max <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(max)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * base >= max) return f * base;
  return 10 * base;
}

const inteiro = (n: number) => Math.round(n).toLocaleString('pt-BR');

export function AreaChart({ series, rotulos, resumo, area = true, formato = inteiro, className = '' }: AreaChartProps) {
  const id = useId().replace(/:/g, '');
  const [ativo, setAtivo] = useState<number | null>(null);
  const n = rotulos.length;
  const topo = topoRedondo(Math.max(0, ...series.flatMap((s) => s.valores)));
  const larg = L - M.esq - M.dir;
  const alt = A - M.cima - M.baixo;
  const x = (i: number) => M.esq + (n <= 1 ? larg / 2 : (i * larg) / (n - 1));
  const y = (v: number) => M.cima + alt - (v / topo) * alt;
  const linha = (vs: readonly number[]) =>
    vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const faixa = n <= 1 ? larg : larg / (n - 1);
  // até ~6 rótulos no eixo x
  const passo = Math.max(1, Math.ceil(n / 6));

  return (
    <div
      className={['bm-grafico', className].filter(Boolean).join(' ')}
      onPointerLeave={() => setAtivo(null)}
      // teclado: Tab entra no gráfico, as setas andam pelos pontos (um só ponto de parada, não um por dia)
      tabIndex={0}
      aria-label={`${resumo} Use as setas para ver cada ponto.`}
      onBlur={() => setAtivo(null)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const d = e.key === 'ArrowRight' ? 1 : -1;
        setAtivo((a) => Math.min(n - 1, Math.max(0, a === null ? (d > 0 ? 0 : n - 1) : a + d)));
      }}
    >
      <svg viewBox={`0 0 ${L} ${A}`} role="img" aria-label={resumo} className="bm-grafico__svg">
        <defs>
          {series.map((s, k) => (
            <linearGradient key={s.nome} id={`${id}-g${k}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.cor} stopOpacity="0.32" />
              <stop offset="100%" stopColor={s.cor} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={M.esq} x2={L - M.dir} y1={y(topo * f)} y2={y(topo * f)} className="bm-grafico__grade" />
            <text x={M.esq - 6} y={y(topo * f) + 4} textAnchor="end" className="bm-grafico__eixo">
              {formato(topo * f)}
            </text>
          </g>
        ))}
        {rotulos.map((r, i) =>
          i % passo === 0 || i === n - 1 ? (
            <text key={i} x={x(i)} y={A - 6} textAnchor="middle" className="bm-grafico__eixo">
              {r}
            </text>
          ) : null,
        )}
        {series.map((s, k) => (
          <g key={s.nome}>
            {area && n > 1 && (
              <path
                d={`${linha(s.valores)}L${x(n - 1)} ${y(0)}L${x(0)} ${y(0)}Z`}
                fill={`url(#${id}-g${k})`}
                stroke="none"
              />
            )}
            <path d={linha(s.valores)} fill="none" stroke={s.cor} strokeWidth="2.2" strokeLinejoin="round" />
          </g>
        ))}
        {ativo !== null && (
          <g>
            <line x1={x(ativo)} x2={x(ativo)} y1={M.cima} y2={M.cima + alt} className="bm-grafico__guia" />
            {series.map((s) => (
              <circle key={s.nome} cx={x(ativo)} cy={y(s.valores[ativo] ?? 0)} r="4" fill={s.cor} />
            ))}
          </g>
        )}
        {rotulos.map((r, i) => (
          <rect
            key={i}
            x={x(i) - faixa / 2}
            y={M.cima}
            width={faixa}
            height={alt}
            fill="transparent"
            data-rotulo={r}
            onPointerEnter={() => setAtivo(i)}
            className="bm-grafico__faixa"
          />
        ))}
      </svg>
      {ativo !== null && (
        <div
          className="bm-grafico__dica"
          aria-live="polite"
          style={{
            left: `${(x(ativo) / L) * 100}%`,
            top: `${(M.cima / A) * 100}%`,
            transform: `translateX(${ativo > n / 2 ? '-105%' : '5%'})`,
          }}
        >
          <strong>{rotulos[ativo]}</strong>
          {series.map((s) => (
            <span key={s.nome}>
              <i style={{ background: s.cor }} />
              {s.nome}: {formato(s.valores[ativo] ?? 0)}
            </span>
          ))}
        </div>
      )}
      <ul className="bm-grafico__legenda">
        {series.map((s) => (
          <li key={s.nome}>
            <i style={{ background: s.cor }} />
            {s.nome}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Só as linhas, sem preenchimento. */
export function LineChart(p: Omit<AreaChartProps, 'area'>) {
  return <AreaChart {...p} area={false} />;
}

export interface Barra {
  rotulo: string;
  valor: number;
  cor?: string;
}

export interface BarChartProps {
  dados: readonly Barra[];
  resumo: string;
  formato?: (n: number) => string;
  className?: string;
}

export function BarChart({ dados, resumo, formato = inteiro, className = '' }: BarChartProps) {
  const topo = topoRedondo(Math.max(0, ...dados.map((d) => d.valor)));
  const larg = L - M.esq - M.dir;
  const alt = A - M.cima - M.baixo;
  const faixa = larg / Math.max(1, dados.length);
  const barra = Math.min(36, faixa * 0.62);
  return (
    <div className={['bm-grafico', className].filter(Boolean).join(' ')}>
      <svg viewBox={`0 0 ${L} ${A}`} role="img" aria-label={resumo} className="bm-grafico__svg">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={M.esq}
              x2={L - M.dir}
              y1={M.cima + alt - f * alt}
              y2={M.cima + alt - f * alt}
              className="bm-grafico__grade"
            />
            <text x={M.esq - 6} y={M.cima + alt - f * alt + 4} textAnchor="end" className="bm-grafico__eixo">
              {formato(topo * f)}
            </text>
          </g>
        ))}
        {dados.map((d, i) => {
          const h = (d.valor / topo) * alt;
          const cx = M.esq + faixa * i + faixa / 2;
          return (
            <g key={d.rotulo}>
              <rect
                x={cx - barra / 2}
                y={M.cima + alt - h}
                width={barra}
                height={Math.max(0, h)}
                rx="5"
                fill={d.cor ?? 'var(--bm-accent-fill)'}
              >
                <title>{`${d.rotulo}: ${formato(d.valor)}`}</title>
              </rect>
              <text x={cx} y={A - 6} textAnchor="middle" className="bm-grafico__eixo">
                {d.rotulo}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export interface Fatia {
  rotulo: string;
  valor: number;
  cor: string;
}

export interface DonutChartProps {
  partes: readonly Fatia[];
  resumo: string;
  /** Texto no centro (ex.: o total). */
  centro?: string;
  legendaCentro?: string;
  className?: string;
}

export function DonutChart({ partes, resumo, centro, legendaCentro, className = '' }: DonutChartProps) {
  const total = partes.reduce((s, p) => s + p.valor, 0);
  const r = 42;
  const volta = 2 * Math.PI * r;
  let acumulado = 0;
  return (
    <div className={['bm-rosca', className].filter(Boolean).join(' ')}>
      <svg viewBox="0 0 100 100" role="img" aria-label={resumo} className="bm-rosca__svg">
        <circle cx="50" cy="50" r={r} className="bm-rosca__trilho" />
        {total > 0 &&
          partes.map((p) => {
            const comp = (p.valor / total) * volta;
            const el = (
              <circle
                key={p.rotulo}
                cx="50"
                cy="50"
                r={r}
                fill="none"
                stroke={p.cor}
                strokeWidth="11"
                strokeDasharray={`${comp} ${volta - comp}`}
                strokeDashoffset={-acumulado}
                transform="rotate(-90 50 50)"
              />
            );
            acumulado += comp;
            return el;
          })}
        {centro && (
          <text x="50" y={legendaCentro ? 50 : 55} textAnchor="middle" className="bm-rosca__centro">
            {centro}
          </text>
        )}
        {legendaCentro && (
          <text x="50" y="63" textAnchor="middle" className="bm-rosca__legenda-centro">
            {legendaCentro}
          </text>
        )}
      </svg>
      <ul className="bm-grafico__legenda bm-grafico__legenda--coluna">
        {partes.map((p) => (
          <li key={p.rotulo}>
            <i style={{ background: p.cor }} />
            {p.rotulo} <b>{p.valor.toLocaleString('pt-BR')}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface SparklineProps {
  valores: readonly number[];
  cor?: string;
  className?: string;
}

/** Linha mínima, decorativa (o número ao lado já diz o valor). */
export function Sparkline({ valores, cor = 'var(--bm-accent)', className = '' }: SparklineProps) {
  const max = Math.max(1, ...valores);
  const n = valores.length;
  const pts = valores.map((v, i) => `${n <= 1 ? 50 : (i * 100) / (n - 1)},${28 - (v / max) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true" className={className} focusable="false">
      <polyline points={pts} fill="none" stroke={cor} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
