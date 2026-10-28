/**
 * Manutinho · regras (funções puras, sem relógio: `hoje`/`agora` entram como parâmetro).
 * O servidor (server/src/routes/manutinho.js) chama estas funções com o que a transação com RLS devolveu; o front usa
 * as mesmas para ordenar, agrupar e exportar. Nada aqui consulta banco nem decide acesso.
 */
import type {
  ContagemManutinho,
  CursoManutinho,
  EquipamentoManutinho,
  EquipamentoRelatorioManutinho,
  FolhaManutinho,
  ItemManutinho,
  LeituraManutinho,
  MedidorManutinho,
  ModuloManutinho,
  NivelManutinho,
  PessoaManutinho,
  ProgressoManutinho,
  RelatorioPreventivasManutinho,
  SituacaoManutinho,
  SolicitacaoManutinho,
  TanqueManutinho,
  TreinamentoVencidoManutinho,
  ValvulaManutinho,
} from './tipos.js';

/** Rotas do front de cada fonte (onde a pessoa resolve o aviso). */
export const ROTAS_MANUTINHO: Record<ModuloManutinho, string> = {
  preventivas: '/pcm/preventivas',
  valvulas: '/pcm/preventivas',
  bateladas: '/pcm/bateladas',
  solicitacoes: '/almoxarifado/minhas',
  aprovacoes: '/almoxarifado/scm/aprovacoes',
  medidores: '/utilidades/pendencias',
  treinamentos: '/treinamentos/equipe',
};

/** SCI e SCM paradas há mais que isto (dias) viram aviso. */
export const DIAS_PARADA_MANUTINHO = 3;

/** Status em que a SCI/SCM já terminou (workflow.js): não contam como parada. */
const FINAIS: Record<'sci' | 'scm', ReadonlySet<string>> = {
  sci: new Set(['cadastrado', 'rejeitada', 'recusado', 'reprovada', 'excluida']),
  scm: new Set(['concluida', 'reprovada', 'excluida']),
};
const ROTULO_STATUS: Record<string, string> = {
  pendente_aprovacao_lider: 'aguardando aprovação',
  revisao_solicitada: 'em revisão pelo solicitante',
  aprovada: 'aprovada, sem RC',
  revisao_almoxarifado: 'devolvida pelo almoxarifado',
  parcial: 'RC aberta parcial',
  em_tratativa: 'RC aberta',
  aberto: 'aberta',
  pendente: 'aberta',
  pendente_aprovacao: 'aguardando o almoxarifado',
  revisao_solicitante: 'em revisão pelo solicitante',
  aguardando_cadastro: 'aguardando cadastro',
  em_compra: 'em compra',
};

/* ------------------------------------------------------------------ datas */

const DIA = /^\d{4}-\d{2}-\d{2}$/;

function utc(dia: string): number {
  return Date.parse(`${dia}T00:00:00Z`);
}

/** Dias de `a` até `b` (YYYY-MM-DD). */
function diasEntre(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

function somaDias(dia: string, n: number): string {
  return new Date(utc(dia) + n * 86_400_000).toISOString().slice(0, 10);
}

function ehDia(v: unknown): v is string {
  return typeof v === 'string' && DIA.test(v) && Number.isFinite(utc(v));
}

/** 2026-10-28 → 28/10/2026 */
function dataBr(dia: string | null | undefined): string {
  if (!dia || !DIA.test(dia.slice(0, 10))) return '';
  const [a, m, d] = dia.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/** Lista curta para o detalhe: até `max` nomes e "e mais N". */
function listaCurta(nomes: string[], max = 6): string {
  if (nomes.length <= max) return nomes.join(', ');
  return `${nomes.slice(0, max).join(', ')} e mais ${nomes.length - max}`;
}

/* ------------------------------------------------------------------ preventivas */

/**
 * Setor do equipamento: o local cadastrado; sem ele, o tipo pelo código (como a V5: FTD = Fermentadores,
 * PGD = Propagadores, BLD = Blenders); senão a CAMM; senão "Outros".
 */
export function setorManutinho(e: Pick<EquipamentoManutinho, 'codigo' | 'local' | 'camm'>): string {
  if (e.local) return e.local;
  if (/^FTD/i.test(e.codigo)) return 'Fermentadores';
  if (/^PGD/i.test(e.codigo)) return 'Propagadores';
  if (/^BLD/i.test(e.codigo)) return 'Blenders';
  return e.camm || 'Outros';
}

/** Folha aberta com data prevista antes de hoje = atrasada; a partir de hoje = em dia. */
export function situacaoFolhaManutinho(dataPrevista: string, hoje: string): 'atrasada' | 'em_dia' {
  return dataPrevista < hoje ? 'atrasada' : 'em_dia';
}

/** Situação do equipamento: atrasada (alguma folha aberta atrasada), em dia (tem folha aberta) ou sem programação. */
export function situacaoEquipamentoManutinho(
  folhas: Pick<FolhaManutinho, 'dataPrevista'>[],
  hoje: string,
): SituacaoManutinho {
  if (!folhas.length) return 'sem_programacao';
  return folhas.some((f) => situacaoFolhaManutinho(f.dataPrevista, hoje) === 'atrasada') ? 'atrasada' : 'em_dia';
}

const ORDEM_SITUACAO: Record<SituacaoManutinho, number> = { atrasada: 0, sem_programacao: 1, em_dia: 2 };

function contar(lista: EquipamentoRelatorioManutinho[]): ContagemManutinho {
  return {
    atrasadas: lista.filter((e) => e.situacao === 'atrasada').length,
    emDia: lista.filter((e) => e.situacao === 'em_dia').length,
    semProgramacao: lista.filter((e) => e.situacao === 'sem_programacao').length,
    total: lista.length,
  };
}

function agrupar<K extends string>(
  lista: EquipamentoRelatorioManutinho[],
  chave: (e: EquipamentoRelatorioManutinho) => string,
  nome: K,
): (ContagemManutinho & Record<K, string>)[] {
  const grupos = new Map<string, EquipamentoRelatorioManutinho[]>();
  for (const e of lista) {
    const k = chave(e);
    grupos.set(k, [...(grupos.get(k) ?? []), e]);
  }
  return [...grupos.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'pt'))
    .map(([k, es]) => ({ ...contar(es), [nome]: k }) as ContagemManutinho & Record<K, string>);
}

/**
 * Relatório das preventivas: cada equipamento com a situação, as folhas abertas e o atraso; contagens por setor e
 * por CAMM. Ordem: atrasadas (mais atraso primeiro), sem programação, em dia; depois setor e código.
 */
export function montarRelatorioManutinho(
  equipamentos: EquipamentoManutinho[],
  folhas: FolhaManutinho[],
  hoje: string,
): RelatorioPreventivasManutinho {
  const porAtivo = new Map<string, FolhaManutinho[]>();
  for (const f of folhas) porAtivo.set(f.ativoId, [...(porAtivo.get(f.ativoId) ?? []), f]);
  const lista: EquipamentoRelatorioManutinho[] = equipamentos.map((e) => {
    const fs = (porAtivo.get(e.id) ?? [])
      .slice()
      .sort((a, b) => a.dataPrevista.localeCompare(b.dataPrevista))
      .map((f) => ({ ...f, atrasoDias: Math.max(0, diasEntre(f.dataPrevista, hoje)) }));
    const situacao = situacaoEquipamentoManutinho(fs, hoje);
    return {
      ...e,
      setor: setorManutinho(e),
      situacao,
      folhas: fs,
      proxima: fs[0]?.dataPrevista ?? null,
      atrasoDias: situacao === 'atrasada' ? (fs[0]?.atrasoDias ?? 0) : 0,
    };
  });
  lista.sort(
    (a, b) =>
      ORDEM_SITUACAO[a.situacao] - ORDEM_SITUACAO[b.situacao] ||
      b.atrasoDias - a.atrasoDias ||
      a.setor.localeCompare(b.setor, 'pt') ||
      a.codigo.localeCompare(b.codigo, 'pt', { numeric: true }),
  );
  const todasFolhas = lista.flatMap((e) => e.folhas);
  return {
    hoje,
    totais: {
      ...contar(lista),
      folhasAtrasadas: todasFolhas.filter((f) => f.dataPrevista < hoje).length,
      folhasEmDia: todasFolhas.filter((f) => f.dataPrevista >= hoje).length,
    },
    equipamentos: lista,
    porSetor: agrupar(lista, (e) => e.setor, 'setor'),
    porCamm: agrupar(lista, (e) => e.camm || 'Sem CAMM', 'camm'),
  };
}

/** Avisos das preventivas: um por setor para atrasadas (crítico) e sem programação (atenção); um resumo das em dia. */
export function itensPreventivas(rel: RelatorioPreventivasManutinho): ItemManutinho[] {
  const rota = ROTAS_MANUTINHO.preventivas;
  const itens: ItemManutinho[] = [];
  for (const s of rel.porSetor) {
    const doSetor = rel.equipamentos.filter((e) => e.setor === s.setor);
    if (s.atrasadas) {
      const atr = doSetor.filter((e) => e.situacao === 'atrasada');
      itens.push({
        nivel: 'critico',
        modulo: 'preventivas',
        titulo: `${s.setor}: ${plural(s.atrasadas, 'equipamento com preventiva atrasada', 'equipamentos com preventiva atrasada')}`,
        detalhe: listaCurta(atr.map((e) => `${e.codigo} (${plural(e.atrasoDias, 'dia', 'dias')})`)),
        rota,
      });
    }
    if (s.semProgramacao) {
      const sem = doSetor.filter((e) => e.situacao === 'sem_programacao');
      itens.push({
        nivel: 'atencao',
        modulo: 'preventivas',
        titulo: `${s.setor}: ${plural(s.semProgramacao, 'equipamento sem preventiva programada', 'equipamentos sem preventiva programada')}`,
        detalhe: listaCurta(sem.map((e) => e.codigo)),
        rota,
      });
    }
  }
  if (rel.totais.emDia) {
    itens.push({
      nivel: 'info',
      modulo: 'preventivas',
      titulo: `${plural(rel.totais.emDia, 'equipamento', 'equipamentos')} com preventiva em dia`,
      detalhe: `${plural(rel.totais.folhasEmDia, 'folha aberta', 'folhas abertas')} a partir de hoje.`,
      rota,
    });
  }
  return itens;
}

/* ------------------------------------------------------------------ válvulas */

/** Vida 1 (0%, crítico) = crítico; vida 2 (25%, sério) = atenção; 3 e 4 não são aviso. */
export function nivelValvulaManutinho(estado: number): NivelManutinho | null {
  if (estado === 1) return 'critico';
  if (estado === 2) return 'atencao';
  return null;
}

/** Um aviso por equipamento com válvulas em vida 1 ou 2 (nível = a pior). */
export function itensValvulas(valvulas: ValvulaManutinho[]): ItemManutinho[] {
  const porAtivo = new Map<string, ValvulaManutinho[]>();
  for (const v of valvulas) {
    if (!nivelValvulaManutinho(v.estado)) continue;
    porAtivo.set(v.ativoCodigo, [...(porAtivo.get(v.ativoCodigo) ?? []), v]);
  }
  return [...porAtivo.entries()].map(([codigo, vs]) => {
    const v1 = vs.filter((v) => v.estado === 1).length;
    const v2 = vs.length - v1;
    const partes = [v1 ? `${v1} em vida 1` : '', v2 ? `${v2} em vida 2` : ''];
    return {
      nivel: v1 ? 'critico' : 'atencao',
      modulo: 'valvulas',
      titulo: `${codigo}: ${plural(vs.length, 'válvula crítica', 'válvulas críticas')} (${partes.filter(Boolean).join(', ')})`,
      detalhe: listaCurta(vs.map((v) => v.tag)),
      rota: ROTAS_MANUTINHO.valvulas,
    };
  });
}

/* ------------------------------------------------------------------ bateladas */

/** Tanques que passaram do limite (vencido = crítico) e em alerta (atenção), um aviso por faixa. */
export function itensBateladas(tanques: TanqueManutinho[]): ItemManutinho[] {
  const fmt = (t: TanqueManutinho) => `${t.codigo} (${t.desdePreventiva}${t.frequencia ? `/${t.frequencia}` : ''})`;
  const ordenar = (a: TanqueManutinho, b: TanqueManutinho) =>
    b.desdePreventiva - a.desdePreventiva || a.codigo.localeCompare(b.codigo, 'pt', { numeric: true });
  const vencidos = tanques.filter((t) => t.faixa === 'vencido').sort(ordenar);
  const alerta = tanques.filter((t) => t.faixa === 'alerta').sort(ordenar);
  const itens: ItemManutinho[] = [];
  if (vencidos.length)
    itens.push({
      nivel: 'critico',
      modulo: 'bateladas',
      titulo: `${plural(vencidos.length, 'tanque passou', 'tanques passaram')} do limite de bateladas`,
      detalhe: listaCurta(vencidos.map(fmt)),
      rota: ROTAS_MANUTINHO.bateladas,
    });
  if (alerta.length)
    itens.push({
      nivel: 'atencao',
      modulo: 'bateladas',
      titulo: `${plural(alerta.length, 'tanque', 'tanques')} em alerta de bateladas`,
      detalhe: listaCurta(alerta.map(fmt)),
      rota: ROTAS_MANUTINHO.bateladas,
    });
  return itens;
}

/* ------------------------------------------------------------------ SCI e SCM */

export function solicitacaoFinal(ns: 'sci' | 'scm', status: string): boolean {
  return FINAIS[ns].has(String(status || ''));
}

/** Dias corridos desde a última mudança (agora e atualizadoEm em ISO). */
export function diasParado(atualizadoEm: string, agora: string): number {
  const d = (Date.parse(agora) - Date.parse(atualizadoEm)) / 86_400_000;
  return Number.isFinite(d) ? Math.floor(d) : 0;
}

/** SCI e SCM em andamento sem mudança há mais de DIAS_PARADA_MANUTINHO dias: um aviso por tipo. */
export function itensSolicitacoesParadas(regs: SolicitacaoManutinho[], agora: string): ItemManutinho[] {
  const itens: ItemManutinho[] = [];
  for (const ns of ['scm', 'sci'] as const) {
    const paradas = regs
      .filter((r) => r.namespace === ns && !solicitacaoFinal(ns, r.status))
      .map((r) => ({ ...r, dias: diasParado(r.atualizadoEm, agora) }))
      .filter((r) => r.dias > DIAS_PARADA_MANUTINHO)
      .sort((a, b) => b.dias - a.dias || a.recordId.localeCompare(b.recordId));
    if (!paradas.length) continue;
    itens.push({
      nivel: 'atencao',
      modulo: 'solicitacoes',
      titulo: `${plural(paradas.length, `${ns.toUpperCase()} parada`, `${ns.toUpperCase()}s paradas`)} há mais de ${DIAS_PARADA_MANUTINHO} dias`,
      detalhe: listaCurta(
        paradas.map((r) => `${r.recordId} (${ROTULO_STATUS[r.status] ?? r.status}, ${plural(r.dias, 'dia', 'dias')})`),
        4,
      ),
      rota: ROTAS_MANUTINHO.solicitacoes,
    });
  }
  return itens;
}

/** SCM aguardando a aprovação da própria pessoa (aprovadorId = ela). */
export function itensAprovacoes(regs: SolicitacaoManutinho[], agora: string): ItemManutinho[] {
  const pend = regs
    .filter((r) => r.namespace === 'scm' && r.status === 'pendente_aprovacao_lider')
    .map((r) => ({ ...r, dias: diasParado(r.atualizadoEm, agora) }))
    .sort((a, b) => b.dias - a.dias || a.recordId.localeCompare(b.recordId));
  if (!pend.length) return [];
  return [
    {
      nivel: pend.some((r) => r.dias > DIAS_PARADA_MANUTINHO) ? 'critico' : 'atencao',
      modulo: 'aprovacoes',
      titulo: `${plural(pend.length, 'SCM aguarda', 'SCMs aguardam')} a sua aprovação`,
      detalhe: listaCurta(
        pend.map((r) => `${r.recordId} (${plural(r.dias, 'dia', 'dias')})`),
        4,
      ),
      rota: ROTAS_MANUTINHO.aprovacoes,
    },
  ];
}

/* ------------------------------------------------------------------ medidores */

/** Medidores ativos sem nenhuma leitura no dia `ontem`. */
export function medidoresSemLeitura(
  medidores: MedidorManutinho[],
  leituras: LeituraManutinho[],
  ontem: string,
): MedidorManutinho[] {
  const lidos = new Set(leituras.filter((l) => l.dia === ontem).map((l) => l.medidorId));
  return medidores
    .filter((m) => m.ativo && !lidos.has(m.id))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt', { numeric: true }));
}

export function itensMedidores(semLeitura: MedidorManutinho[], ontem: string): ItemManutinho[] {
  if (!semLeitura.length) return [];
  return [
    {
      nivel: 'atencao',
      modulo: 'medidores',
      titulo: `${plural(semLeitura.length, 'medidor ficou', 'medidores ficaram')} sem leitura ontem (${dataBr(ontem)})`,
      detalhe: listaCurta(semLeitura.map((m) => m.nome)),
      rota: ROTAS_MANUTINHO.medidores,
    },
  ];
}

/* ------------------------------------------------------------------ treinamentos */

const PRAZO_PADRAO = 30;
const ehIso = (v: string | null) => (v && /^\d{4}-/.test(v) ? v : null);
const maisDias = (iso: string, dias: number) => new Date(Date.parse(iso) + dias * 86_400_000).toISOString();

/** O curso vale para a pessoa? Sem público definido = todos; senão, o grupo ou a própria pessoa na lista. */
export function cursoValePara(c: CursoManutinho, p: PessoaManutinho): boolean {
  if (!c.publicoGrupos.length && !c.publicoPessoas.length) return true;
  return (!!p.grupoId && c.publicoGrupos.includes(p.grupoId)) || c.publicoPessoas.includes(p.id);
}

/**
 * Prazo do curso obrigatório para a pessoa (mesma regra de lms.enfileirar_cobrancas_treinamento, migration 29):
 *  - concluído: revisão mais nova que a versão concluída → data da revisão (ou publicação) + prazo; senão a validade
 *    do certificado (expires_at), se houver;
 *  - não concluído: o maior entre inscrição e publicação + prazo (padrão 30 dias).
 * null = sem prazo.
 */
export function prazoTreinamento(
  c: CursoManutinho,
  pr: ProgressoManutinho | undefined,
): { prazo: string; refazer: boolean } | null {
  const dias = c.prazoDias ?? PRAZO_PADRAO;
  const publicado = ehIso(c.publicadoEm);
  if (pr && ehIso(pr.concluidoEm)) {
    if ((c.revisaoVersao ?? 0) > (pr.versao ?? 1)) {
      const base = ehIso(c.revisaoEm) ?? publicado;
      return base ? { prazo: maisDias(base, dias), refazer: true } : null;
    }
    const expira = ehIso(pr.expiraEm);
    return expira ? { prazo: new Date(Date.parse(expira)).toISOString(), refazer: true } : null;
  }
  const inscrito = ehIso(pr?.inscritoEm ?? null);
  const datas = [inscrito, publicado].filter((d): d is string => !!d).map((d) => Date.parse(d));
  if (!datas.length) return null;
  return { prazo: maisDias(new Date(Math.max(...datas)).toISOString(), dias), refazer: false };
}

/** Treinamentos obrigatórios com prazo já vencido (prazo < agora) das pessoas que a sessão acompanha. */
export function treinamentosVencidos(
  cursos: CursoManutinho[],
  pessoas: PessoaManutinho[],
  progressos: ProgressoManutinho[],
  agora: string,
): TreinamentoVencidoManutinho[] {
  const prog = new Map(progressos.map((p) => [`${p.usuarioId}__${p.cursoId}`, p]));
  const limite = Date.parse(agora);
  const out: TreinamentoVencidoManutinho[] = [];
  for (const c of cursos) {
    if (!c.obrigatorio || !c.publicado) continue;
    for (const p of pessoas) {
      if (!cursoValePara(c, p)) continue;
      const r = prazoTreinamento(c, prog.get(`${p.id}__${c.id}`));
      if (r && Date.parse(r.prazo) < limite)
        out.push({
          pessoaId: p.id,
          pessoa: p.nome,
          cursoId: c.id,
          curso: c.titulo,
          prazo: r.prazo,
          refazer: r.refazer,
        });
    }
  }
  return out.sort(
    (a, b) =>
      a.prazo.localeCompare(b.prazo) || a.pessoa.localeCompare(b.pessoa, 'pt') || a.curso.localeCompare(b.curso),
  );
}

/** Um aviso com as pessoas e quantos cursos vencidos cada uma tem. */
export function itensTreinamentos(vencidos: TreinamentoVencidoManutinho[]): ItemManutinho[] {
  if (!vencidos.length) return [];
  const porPessoa = new Map<string, number>();
  for (const v of vencidos) porPessoa.set(v.pessoa, (porPessoa.get(v.pessoa) ?? 0) + 1);
  return [
    {
      nivel: 'atencao',
      modulo: 'treinamentos',
      titulo: `${plural(vencidos.length, 'treinamento obrigatório vencido', 'treinamentos obrigatórios vencidos')} (${plural(porPessoa.size, 'pessoa', 'pessoas')})`,
      detalhe: listaCurta([...porPessoa.entries()].map(([nome, n]) => `${nome} (${n})`)),
      rota: ROTAS_MANUTINHO.treinamentos,
    },
  ];
}

/* ------------------------------------------------------------------ ordem e contagem */

const ORDEM_NIVEL: Record<NivelManutinho, number> = { critico: 0, atencao: 1, info: 2 };
const ORDEM_MODULO: ModuloManutinho[] = [
  'preventivas',
  'valvulas',
  'bateladas',
  'aprovacoes',
  'solicitacoes',
  'medidores',
  'treinamentos',
];

/** Crítico, atenção, informação; dentro do nível, pela ordem das fontes e depois pelo título. */
export function ordenarItensManutinho(itens: ItemManutinho[]): ItemManutinho[] {
  return itens
    .slice()
    .sort(
      (a, b) =>
        ORDEM_NIVEL[a.nivel] - ORDEM_NIVEL[b.nivel] ||
        ORDEM_MODULO.indexOf(a.modulo) - ORDEM_MODULO.indexOf(b.modulo) ||
        a.titulo.localeCompare(b.titulo, 'pt', { numeric: true }),
    );
}

export function contarNiveisManutinho(itens: ItemManutinho[]): Record<NivelManutinho, number> {
  const c: Record<NivelManutinho, number> = { critico: 0, atencao: 0, info: 0 };
  for (const i of itens) c[i.nivel] += 1;
  return c;
}

/* ------------------------------------------------------------------ cobrança */

/** Modelo fixo do e-mail de cobrança (o texto não vem do navegador). O servidor escapa e monta o HTML. */
export function modeloCobranca(quemCobra: string, cursos: string[]): { assunto: string; paragrafos: string[] } {
  return {
    assunto: '[Lembrete] Treinamento pendente',
    paragrafos: [
      `${quemCobra} pediu que você conclua ${cursos.length === 1 ? 'este treinamento' : 'estes treinamentos'} na Plataforma de Manutenção:`,
      'Acesse a plataforma, em Treinamentos › Meus cursos.',
    ],
  };
}

/** Datas e texto usados pelas regras (o front reaproveita na tela e no export). */
export const utilManutinho = { diasEntre, somaDias, ehDia, dataBr, listaCurta } as const;
