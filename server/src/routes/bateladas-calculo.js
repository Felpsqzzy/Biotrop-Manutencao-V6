'use strict';
// Regras do controle de bateladas (as mesmas da planilha "CONTROLE DE BATELADAS"), em funções puras.
//   contador acumulado → vale da data do apontamento até o próximo;
//   bateladas num período = contador no fim − contador no fim do período anterior;
//   desde a preventiva = contador atual − contador na data da última preventiva.

const TIPOS = ['PGD', 'FTD', 'BLD'];
function tipoDe(codigo) { const t = String(codigo || '').slice(0, 3).toUpperCase(); return t === 'BLR' ? 'BLD' : t; }
function pad(n) { return String(n).padStart(2, '0'); }
function iso(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function dia(s) { return new Date(`${s}T00:00:00Z`); }
function somaDias(s, n) { const d = dia(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function diasEntre(a, b) { return Math.round((dia(b) - dia(a)) / 86400000); }

/** Semana ISO (segunda a domingo): { ano, semana, inicio, fim }. */
function semanaIso(s) {
  const d = dia(s), wd = (d.getUTCDay() + 6) % 7;
  const seg = new Date(d); seg.setUTCDate(d.getUTCDate() - wd);
  const qui = new Date(seg); qui.setUTCDate(seg.getUTCDate() + 3);
  const ano = qui.getUTCFullYear(), jan4 = new Date(Date.UTC(ano, 0, 4));
  const semana = 1 + Math.round((qui - jan4) / 86400000 / 7 - ((jan4.getUTCDay() + 6) % 7 - 3) / 7);
  return { ano, semana, inicio: iso(seg), fim: somaDias(iso(seg), 6) };
}

/**
 * Semana como a planilha conta (aba SEMANAL: WEEKNUM(data;2) e o ano da data): começa na segunda-feira e
 * a semana 1 é a que contém 1º de janeiro — a semana da virada do ano fica dividida entre os dois anos.
 */
function semanaExcel(s) {
  const d = dia(s), ano = d.getUTCFullYear(), jan1 = new Date(Date.UTC(ano, 0, 1));
  const doy = Math.round((d - jan1) / 86400000), off = (jan1.getUTCDay() + 6) % 7;
  const semana = Math.floor((doy + off) / 7) + 1;
  const ini = new Date(Math.max(jan1, d - ((d.getUTCDay() + 6) % 7) * 86400000));
  const fim = new Date(Math.min(Date.UTC(ano, 11, 31), ini.getTime() + (6 - (ini.getUTCDay() + 6) % 7) * 86400000));
  return { ano, semana, inicio: iso(ini), fim: iso(fim) };
}

/** Contador em vigor numa data (último apontamento ≤ data). `lista` ordenada por data. */
function valorEm(lista, data) {
  let lo = 0, hi = lista.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lista[m].data <= data) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? 0 : lista[ans].acumulado;
}

/**
 * O histórico começa com o contador já alto (ex.: 105 em jul/2025). Antes do primeiro apontamento o contador não é
 * "zero": para os tanques que já existiam quando o histórico começou, vale o primeiro valor conhecido. Sem isso, o
 * primeiro mês/dia somaria o contador inteiro como bateladas. Tanque que entrou depois (ex.: PGD13) começa do zero.
 * Recebe as listas já ordenadas e acrescenta um apontamento-âncora antes do primeiro (data '0000-01-01').
 */
function ancorarInicio(listas) {
  const primeiros = listas.filter(l => l.length && l[0].data !== '0000-01-01').map(l => l[0].data);
  if (!primeiros.length) return listas;
  const inicio = primeiros.reduce((m, d) => (d < m ? d : m));
  for (const l of listas) if (l.length && l[0].data === inicio) l.unshift({ data: '0000-01-01', acumulado: l[0].acumulado, ancora: true });
  return listas;
}

function faixa(n, cfg) {
  if (!cfg) return 'ok';
  if (n >= cfg.frequencia) return 'vencido';
  if (n >= cfg.faixa_alerta) return 'alerta';
  if (n >= cfg.faixa_atencao) return 'atencao';
  return 'ok';
}

/**
 * Programação: 'executado' quando a última preventiva aconteceu a partir de 7 dias antes do início previsto
 * (antecipar poucos dias cumpre a programação) ou foi lançada DEPOIS que a programação foi feita (a preventiva
 * programada foi feita, mesmo bem adiantada); 'programado' quando ainda está à frente; 'realizado' sem
 * programação; '' sem nada. `ultima` = { data, registradoEm? }.
 */
const TOLERANCIA_DIAS = 7;
function statusProgramacao(prog, ultima) {
  const u = ultima && typeof ultima === 'object' ? ultima : ultima ? { data: ultima } : null;
  if (prog && prog.inicio) {
    if (u && u.data >= somaDias(prog.inicio, -TOLERANCIA_DIAS)) return 'executado';
    if (u && u.registradoEm && prog.atualizado_em && new Date(u.registradoEm) > new Date(prog.atualizado_em)) return 'executado';
    return 'programado';
  }
  return u ? 'realizado' : '';
}

/**
 * Situação como na coluna "Status" da planilha (lista da aba DADOS). O PCM pode fixar uma (ex.: PENDENTE
 * REPROGRAMAÇÃO); sem ela, sai do cálculo. Preventiva executada sempre vale EXECUTADO.
 */
const SITUACOES = ['PROGRAMADO', 'PENDENTE PROGRAMAÇÃO', 'PENDENTE REPROGRAMAÇÃO', 'REPROGRAMADO', 'EXECUTADO'];
function situacaoEfetiva(status, manual) {
  if (status === 'executado') return 'EXECUTADO';
  if (manual && SITUACOES.includes(manual)) return manual;
  return status === 'programado' ? 'PROGRAMADO' : status === 'realizado' ? 'EXECUTADO' : '';
}

/**
 * Monta o painel inteiro.
 *   ativos: [{id,codigo,nome,local}]
 *   leituras: [{ativo_id,data,acumulado,registrado_por_nome,origem}]
 *   preventivas: [{ativo_id,data,exata,origem,observacao,id}]  (registro/calendário)
 *   folhas: [{ativo_id,data,id}]                                  (folhas de diafragma concluídas)
 */
function calcularPainel({ ativos, leituras, preventivas, folhas, programacao, config, hoje, meses = 15, semanas = 16, dias = 31 }) {
  const cfgPor = Object.fromEntries((config || []).map(c => [c.tipo, { ...c, frequencia: Number(c.frequencia), faixa_atencao: Number(c.faixa_atencao), faixa_alerta: Number(c.faixa_alerta) }]));
  const porAtivo = new Map(ativos.map(a => [a.id, []]));
  for (const l of leituras) if (porAtivo.has(l.ativo_id) && l.data <= hoje) porAtivo.get(l.ativo_id).push({ data: l.data, acumulado: Number(l.acumulado), por: l.registrado_por_nome, origem: l.origem });
  for (const lista of porAtivo.values()) lista.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  ancorarInicio([...porAtivo.values()]);
  const eventos = new Map(ativos.map(a => [a.id, []]));
  for (const p of preventivas || []) if (eventos.has(p.ativo_id)) eventos.get(p.ativo_id).push({ data: p.data, fonte: p.origem === 'planilha' ? 'calendario' : 'registro', exata: p.exata !== false, id: p.id, observacao: p.observacao || '', registradoEm: p.registrado_em || null });
  for (const f of folhas || []) if (eventos.has(f.ativo_id) && f.data) eventos.get(f.ativo_id).push({ data: f.data, fonte: 'folha', exata: true, id: f.id, registradoEm: f.registrado_em || null });
  const progPor = new Map((programacao || []).map(p => [p.ativo_id, p]));

  const saida = ativos.map(a => {
    const lista = porAtivo.get(a.id) || [];
    const tipo = tipoDe(a.codigo), cfg = cfgPor[tipo] || null;
    const ultimoAp = lista[lista.length - 1] || null;
    const atual = ultimoAp ? ultimoAp.acumulado : 0;
    // eventos até hoje, mais recente primeiro; mesma data em fontes diferentes conta uma vez (folha tem prioridade)
    const ev = (eventos.get(a.id) || []).filter(e => e.data <= hoje).sort((x, y) => (x.data < y.data ? 1 : x.data > y.data ? -1 : (x.fonte === 'folha' ? -1 : 1)));
    const unicos = ev.filter((e, i) => i === 0 || e.data !== ev[i - 1].data);
    const ultima = unicos[0] || null, penultima = unicos[1] || null;
    // sem preventiva registrada: conta desde o começo do histórico (a âncora), não desde zero
    const base = valorEm(lista, ultima ? ultima.data : '0000-01-01');
    const desde = Math.max(0, atual - base);
    const prog = progPor.get(a.id) || null;
    const prox = cfg ? Math.max(0, cfg.frequencia - desde) : null;
    return {
      id: a.id, codigo: a.codigo, nome: a.nome, local: a.local || '', tipo,
      acumulado: atual, apontadoEm: ultimoAp ? ultimoAp.data : null,
      desdePreventiva: desde, faixa: faixa(desde, cfg), frequencia: cfg ? cfg.frequencia : null, faltam: prox,
      ultimaPreventiva: ultima, penultimaPreventiva: penultima,
      intervaloDias: ultima && penultima ? diasEntre(penultima.data, ultima.data) : null,
      diasDesdePreventiva: ultima ? diasEntre(ultima.data, hoje) : null,
      programacao: prog ? { inicio: prog.inicio || null, fim: prog.fim || null, bacteria: prog.bacteria || '', comentario: prog.comentario || '', situacao: prog.situacao || '', atualizadoPor: prog.atualizado_por_nome || '', atualizadoEm: prog.atualizado_em || null } : null,
      status: statusProgramacao(prog, ultima),
      situacao: situacaoEfetiva(statusProgramacao(prog, ultima), prog && prog.situacao),
      preventivas: unicos.slice(0, 60).map(e => ({ data: e.data, fonte: e.fonte, exata: e.exata, id: e.id || null, observacao: e.observacao || '' }))
    };
  });

  // séries: mensal, semanal e diária (bateladas iniciadas no período, por tanque e por tipo)
  const listas = ativos.map(a => ({ a, lista: porAtivo.get(a.id) || [], tipo: tipoDe(a.codigo) }));
  function periodo(chave, fim, inicioAnterior) {
    const porTipo = { PGD: 0, FTD: 0, BLD: 0 }, porAtivo_ = {};
    let total = 0;
    for (const { a, lista, tipo } of listas) {
      const n = Math.max(0, valorEm(lista, fim) - valorEm(lista, inicioAnterior));
      if (n) { porAtivo_[a.codigo] = n; porTipo[tipo] = (porTipo[tipo] || 0) + n; total += n; }
    }
    return { chave, total, porTipo, porAtivo: porAtivo_ };
  }
  const mensal = [];
  const [ha, hm] = hoje.split('-').map(Number);
  for (let k = meses - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(ha, hm - 1 - k, 1));
    const ini = iso(d), fimMes = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    mensal.push({ ...periodo(ini.slice(0, 7), fimMes > hoje ? hoje : fimMes, somaDias(ini, -1)), inicio: ini });
  }
  const semanal = [];
  for (let k = 0, d = hoje; k < semanas; k++) {
    const s = semanaExcel(d);
    semanal.unshift({ ...periodo(`${s.ano}-S${pad(s.semana)}`, s.fim > hoje ? hoje : s.fim, somaDias(s.inicio, -1)), ano: s.ano, semana: s.semana, inicio: s.inicio, fim: s.fim });
    d = somaDias(s.inicio, -1);
  }
  const diario = [];
  for (let k = dias - 1; k >= 0; k--) { const dd = somaDias(hoje, -k); diario.push(periodo(dd, dd, somaDias(dd, -1))); }

  const cont = { ok: 0, atencao: 0, alerta: 0, vencido: 0 };
  for (const s of saida) cont[s.faixa]++;
  return { hoje, config: Object.values(cfgPor), ativos: saida, contagem: cont, mensal, semanal, diario };
}

module.exports = { ancorarInicio, TIPOS, SITUACOES, situacaoEfetiva, tipoDe, valorEm, faixa, statusProgramacao, calcularPainel, semanaIso, semanaExcel, somaDias, diasEntre, iso };
