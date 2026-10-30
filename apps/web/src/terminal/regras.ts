// Regras puras do terminal (sem React): PIN, chave de operação, catálogo (categorias e peças iguais), prazos e textos.
import type { Emprestimo, Ferramenta, ItemEmprestimo, Separado } from './tipos';

export const PIN = 6;
export const MAX_ITENS = 30;
export const MAX_QTD = 999;
export const ABERTOS = ['em_andamento', 'parcialmente_devolvido', 'aguardando_conferencia', 'aguardando_baixa'];
const STATUS: Record<string, string> = {
  em_andamento: 'Em andamento',
  parcialmente_devolvido: 'Parcialmente devolvido',
  aguardando_conferencia: 'Aguardando conferência',
  devolvido: 'Devolvido',
  encerrado: 'Encerrado com baixa',
  estornado: 'Estornado',
  aguardando_baixa: 'Aguardando baixa',
};
// na retirada (RM) o mesmo status quer dizer outra coisa (encerrado = baixada; estornado = recusada)
const STATUS_RM: Record<string, string> = {
  aguardando_baixa: 'Aguardando baixa do almoxarifado',
  encerrado: 'Baixada pelo almoxarifado',
  estornado: 'Recusada pelo almoxarifado',
};
// ordem dos chips de categoria (as sugeridas na importação; as outras depois, em ordem alfabética; "Outros" no fim)
const ORDEM_CAT = [
  'Elétrica',
  'Medição',
  'Manual',
  'Iluminação',
  'Lubrificação',
  'Solda',
  'Pneumática e hidráulica',
  'Elevação e movimentação',
  'Acesso e segurança',
  'Limpeza',
];

export const texto = (v: unknown) => String(v ?? '').trim();
export const num = (n: unknown) => (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export const plural = (n: number, um: string, varios: string) => `${num(n)} ${Number(n) === 1 ? um : varios}`;
/** Primeiro nome, sem marcas como [DEMO]. */
export const primeiroNome = (n: unknown) =>
  texto(n)
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .split(/\s+/)[0] || '';
const pad = (n: number) => String(n).padStart(2, '0');

export function dataCurta(iso: string | null | undefined): string {
  const d = new Date(String(iso ?? ''));
  return !iso || Number.isNaN(d.getTime())
    ? ''
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function dataHora(iso: string | null | undefined): string {
  const d = new Date(String(iso ?? ''));
  return !iso || Number.isNaN(d.getTime())
    ? ''
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function duracao(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return plural(m, 'minuto', 'minutos');
  const h = Math.round(m / 60);
  return h < 48 ? plural(h, 'hora', 'horas') : plural(Math.round(h / 24), 'dia', 'dias');
}

/** Regras do PIN (as do servidor; quem decide é ele): '' quando passa, senão o motivo. */
export function problemaPin(pin: string, matricula?: string): string {
  const s = String(pin || '');
  if (!/^\d{6}$/.test(s)) return 'O PIN tem exatamente 6 dígitos.';
  if (/^(\d)\1{5}$/.test(s)) return 'O PIN não pode ter todos os dígitos iguais.';
  if ('0123456789'.includes(s) || '9876543210'.includes(s)) return 'O PIN não pode ser uma sequência (123456, 654321).';
  const m = String(matricula || '').replace(/\D/g, '');
  if (m.length >= 6 && s === m.slice(-6)) return 'O PIN não pode ser igual aos 6 últimos dígitos da matrícula.';
  return '';
}

/**
 * Chave de operação (^[A-Za-z0-9_-]{8,80}$ no servidor). Uma por pedido, e só troca depois que o servidor confirma:
 * sem resposta (rede, 5xx) o servidor pode ter gravado, e o reenvio com a mesma chave devolve o registro existente.
 */
export function novaChave(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `tm-${Date.now().toString(36)}-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/* ---------------------------------------------------------------- catálogo */
export const disponivel = (f: Ferramenta | undefined) => Number(f?.saldo?.disponivel) || 0;
export const categoriaDe = (f: Ferramenta) => texto(f.categoria) || 'Outros';

/** Categorias presentes, na ordem combinada, com quantas ferramentas cada uma tem. */
export function categorias(rows: Ferramenta[]): [string, number][] {
  const cont = new Map<string, number>();
  for (const f of rows) cont.set(categoriaDe(f), (cont.get(categoriaDe(f)) ?? 0) + 1);
  return [...cont.entries()].sort(([a], [b]) => {
    if (a === 'Outros' || b === 'Outros') return a === 'Outros' ? 1 : -1;
    const ia = ORDEM_CAT.indexOf(a);
    const ib = ORDEM_CAT.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b, 'pt-BR');
  });
}

export type Entrada =
  { tipo: 'unica'; chave: string; f: Ferramenta } | { tipo: 'grupo'; chave: string; nome: string; itens: Ferramenta[] };

/**
 * Peças iguais juntas: ferramentas por quantidade com a mesma descrição (códigos FMNT, uma peça cada) viram um grupo e
 * a pessoa escolhe o código da etiqueta. Controle por unidade (patrimônio) fica sozinho (escolhe a unidade na folha).
 */
export function agrupar(rows: Ferramenta[]): Entrada[] {
  const out: Entrada[] = [];
  const porNome = new Map<string, { tipo: 'grupo'; chave: string; nome: string; itens: Ferramenta[] }>();
  for (const f of rows) {
    const k = f.controle === 'individual' ? '' : texto(f.nome).toLowerCase().replace(/\s+/g, ' ');
    if (!k) {
      out.push({ tipo: 'unica', chave: f.id, f });
      continue;
    }
    const g = porNome.get(k);
    if (g) {
      g.itens.push(f);
      continue;
    }
    const novo = { tipo: 'grupo' as const, chave: `g:${k}`, nome: f.nome, itens: [f] };
    porNome.set(k, novo);
    out.push(novo);
  }
  return out.map((e) =>
    e.tipo === 'grupo' && e.itens.length === 1 ? { tipo: 'unica', chave: e.itens[0]!.id, f: e.itens[0]! } : e,
  );
}

/** O que a pessoa vê de cada entrada: disponível, quantos separados, código e local. */
export function resumoEntrada(e: Entrada, bandeja: Separado[]) {
  if (e.tipo === 'unica') {
    const separados = bandeja.filter((x) => x.ferramentaId === e.f.id).reduce((n, x) => n + x.quantidade, 0);
    return {
      nome: e.f.nome,
      codigo: e.f.codigo,
      local: texto(e.f.localizacao),
      categoria: categoriaDe(e.f),
      livres: e.f.controle === 'individual' ? (e.f.unidadesDisponiveis ?? []).length : disponivel(e.f),
      separados,
      porEtiqueta: e.f.controle === 'individual',
    };
  }
  const locais = [...new Set(e.itens.map((f) => texto(f.localizacao)).filter(Boolean))];
  return {
    nome: e.nome,
    codigo: plural(e.itens.length, 'peça', 'peças'),
    local: locais.length === 1 ? locais[0]! : locais.length ? `Em ${plural(locais.length, 'local', 'locais')}` : '',
    categoria: categoriaDe(e.itens[0]!),
    livres: e.itens.filter((f) => disponivel(f) > 0).length,
    separados: bandeja.filter((x) => e.itens.some((f) => f.id === x.ferramentaId)).length,
    porEtiqueta: true,
  };
}

export const totalSeparado = (b: Separado[]) => b.reduce((s, x) => s + x.quantidade, 0);

/** Linha da bandeja para uma ferramenta por quantidade (ou uma peça de um grupo) ou para uma unidade (etiqueta). */
export function separadoDe(f: Ferramenta, unidade?: { id: string; identificador: string }): Separado {
  return {
    ferramentaId: f.id,
    unidadeId: unidade?.id ?? null,
    identificador: unidade?.identificador ?? '',
    quantidade: 1,
    codigo: f.codigo,
    nome: f.nome,
    localizacao: texto(f.localizacao) || undefined,
    categoria: categoriaDe(f),
    maximo: unidade ? 1 : Math.min(disponivel(f), MAX_QTD),
  };
}

/** Soma (ou tira) uma unidade de uma ferramenta por quantidade, dentro do disponível; zero sai da bandeja. */
export function mudarQuantidade(b: Separado[], f: Ferramenta, delta: number): Separado[] {
  const i = b.findIndex((x) => x.ferramentaId === f.id && !x.unidadeId);
  if (i < 0) return delta > 0 && disponivel(f) > 0 && b.length < MAX_ITENS ? [...b, separadoDe(f)] : b;
  const q = Math.min(b[i]!.quantidade + delta, disponivel(f), MAX_QTD);
  if (q <= 0) return b.filter((_, k) => k !== i);
  return b.map((x, k) => (k === i ? { ...x, quantidade: q } : x));
}

/** Liga ou desliga uma linha por etiqueta (unidade de patrimônio ou peça de um grupo). */
export function alternarEtiqueta(
  b: Separado[],
  f: Ferramenta,
  unidade?: { id: string; identificador: string },
): Separado[] {
  const igual = (x: Separado) => x.ferramentaId === f.id && (x.unidadeId ?? null) === (unidade?.id ?? null);
  if (b.some(igual)) return b.filter((x) => !igual(x));
  return b.length < MAX_ITENS ? [...b, separadoDe(f, unidade)] : b;
}

/* ---------------------------------------------------------------- empréstimos e retiradas */
export const ehRM = (e: Emprestimo | null | undefined) => !!e && e.modalidade === 'retirada';
export const aberto = (e: Emprestimo) => ABERTOS.includes(e.status);
// retirada (RM) não volta: nada a devolver nela
export const devolviveis = (e: Emprestimo): ItemEmprestimo[] =>
  ehRM(e) ? [] : (e.itensLista ?? []).filter((i) => i.tipo !== 'material' && Number(i.pendente) > 0);
export const textoStatus = (e: Emprestimo) => (ehRM(e) && STATUS_RM[e.status]) || STATUS[e.status] || e.status;
export function tomStatus(e: Emprestimo): 'ok' | 'info' | 'aviso' | 'neutro' | 'ruim' {
  if (ehRM(e) && e.status === 'estornado') return 'ruim';
  if (e.status === 'devolvido' || (ehRM(e) && e.status === 'encerrado')) return 'ok';
  if (e.status === 'aguardando_conferencia' || e.status === 'aguardando_baixa') return 'info';
  if (e.status === 'parcialmente_devolvido') return 'aviso';
  return 'neutro';
}

export type TomPrazo = 'ok' | 'aviso' | 'ruim' | 'info' | 'neutro';
export function prazoInfo(e: Emprestimo, agora = Date.now()): [TomPrazo, string] {
  const t = Date.parse(String(e.prazo ?? ''));
  const falta = t - agora;
  if (Number(e.pendente) <= 0 && Number(e.emConferencia) > 0)
    return ['info', 'Tudo entregue: aguardando a conferência do almoxarifado.'];
  if (Number.isNaN(t)) return ['neutro', 'Sem prazo definido.'];
  if (e.atrasado || falta < 0) return ['ruim', `Atrasado há ${duracao(-falta)}: o prazo era ${dataCurta(e.prazo)}.`];
  if (falta < 24 * 3600e3) return ['aviso', `Vence em ${duracao(falta)}: até ${dataCurta(e.prazo)}.`];
  return ['ok', `Devolver até ${dataCurta(e.prazo)}.`];
}

/** Situação do item. "Pendente" só em registro aberto: o estornado guarda a quantidade cheia, mas ninguém deve nada. */
export function estadoItem(i: ItemEmprestimo, e?: Emprestimo): string {
  const p: string[] = [];
  if (Number(i.pendente) > 0 && (!e || aberto(e)))
    p.push(`${num(i.pendente)} ${Number(i.pendente) === 1 ? 'pendente' : 'pendentes'}`);
  if (Number(i.emConferencia) > 0) p.push(`${num(i.emConferencia)} em conferência`);
  if (Number(i.devolvida) > 0) p.push(`${num(i.devolvida)} ${Number(i.devolvida) === 1 ? 'devolvida' : 'devolvidas'}`);
  if (Number(i.baixa) > 0) p.push(`${num(i.baixa)} ${Number(i.baixa) === 1 ? 'baixada' : 'baixadas'}`);
  return `Qtd ${num(i.quantidade)}${p.length ? ` · ${p.join(' · ')}` : ''}`;
}

/** O que vai ao servidor, em ordem fixa: para comparar o pedido com o registro que o servidor devolveu. */
export function assinatura(itens: { ferramentaId?: string | null; unidadeId?: string | null; quantidade: number }[]) {
  return JSON.stringify(
    itens.map((i) => [String(i.ferramentaId ?? ''), String(i.unidadeId ?? ''), Number(i.quantidade) || 0]).sort(),
  );
}

/** Muda a quantidade de uma linha da bandeja (revisão), entre 1 e o máximo dela; 0 tira a linha. */
export function ajustarLinha(b: Separado[], k: number, delta: number): Separado[] {
  const x = b[k];
  if (!x) return b;
  const q = Math.min(x.quantidade + delta, x.maximo);
  return q <= 0 ? b.filter((_, i) => i !== k) : b.map((y, i) => (i === k ? { ...y, quantidade: q } : y));
}
