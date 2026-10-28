'use strict';
const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { buildReadScope } = require('./read-scope');
const { ULTIMO_SQL } = require('./pcm-preventivas');
const { carregar: carregarBateladas } = require('./pcm-bateladas');
const C = require('./bateladas-calculo');
// Regras do Manutinho (puras, as mesmas do front): packages/shared/src/manutinho, saída CommonJS do build do pacote.
const R = require('../../../packages/shared/dist/cjs/manutinho/index.js');

/*
 * Manutinho (substitui o Copiloto, 28/10/2026): assistente de manutenção SEM IA. Lê o banco na transação da sessão
 * (RLS) e aplica as regras do pacote compartilhado; nada sai do servidor para serviço externo.
 *   GET  /resumo                → avisos { nivel, modulo, titulo, detalhe, rota } das fontes que o perfil acessa
 *   GET  /relatorio-preventivas → situação das preventivas por equipamento, setor e CAMM (tela e export)
 *   POST /cobrar                → e-mail de cobrança de treinamento, modelo fixo (função lms.copiloto_cobrar, migration 39)
 *
 * Cada fonte só entra se o perfil passa na MESMA checagem da rota de origem (nunca mais permissiva):
 *   preventivas, válvulas e bateladas → equipe de manutenção (pcm-preventivas.js / pcm-bateladas.js);
 *   SCI e SCM paradas, aprovações     → solicitantes (data.js), com o escopo de read-scope.js;
 *   medidores sem leitura ontem       → PCM, gestão e administração (tela Pendências de apontamento);
 *   treinamentos vencidos             → lms.equipe_visivel() (cada um vê a si; líder, o grupo; gestão, todos).
 * Atualização na tela: o front pede de novo a cada 60 s com a aba visível (sem migration de realtime na fase 1).
 */
const router = express.Router();
router.use(requireAuth);

const EQUIPE = new Set(['admin', 'gestor', 'pcm', 'lider', 'tecnico']);
const SOLICITANTES = new Set(['admin', 'gestor', 'pcm', 'almoxarife', 'lider', 'tecnico']);
const MEDIDORES = new Set(['admin', 'gestor', 'pcm']);
const VE_PROGRESSO_DA_EQUIPE = new Set(['admin', 'gestor', 'pcm', 'lider']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(status, message) { return Object.assign(new Error(message), { status, userMessage: message }); }
function data(v) {
  const s = String(v || '');
  if (!DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}
// O driver pg entrega a coluna date como meia-noite LOCAL; toISOString() mudaria o dia fora de UTC.
function isoDay(v) {
  if (!v) return null;
  if (!(v instanceof Date)) return String(v).slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}
function hojeLocal() { return isoDay(new Date()); }
function iso(v) { const d = v instanceof Date ? v : new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; }
function texto(v, max = 160) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function handle(fn) {
  return async (req, res, next) => {
    try { await fn(req, res); } catch (error) {
      if (error.status && error.userMessage) return res.status(error.status).json({ ok: false, erro: error.userMessage });
      next(error);
    }
  };
}

/* ---------------------------------------------------------------- leituras (sempre dentro da transação da sessão) */

async function lerPreventivas(db) {
  const equipamentos = (await db.query(`SELECT a.id, a.codigo, a.nome, a.camm::text AS camm, a.local,
      (SELECT max(p.data_prevista) FROM pcm.preventiva p WHERE p.ativo_id=a.id AND p.status='concluida') AS ultima_concluida
    FROM pcm.ativo a
    WHERE a.ativo AND (a.local IN ('Fermentadores','Propagadores','Blenders')
      OR EXISTS (SELECT 1 FROM pcm.checklist_item c2 WHERE c2.ativo_id=a.id))`)).rows;
  const folhas = (await db.query(`SELECT p.id, p.ativo_id, p.numero_om, p.data_prevista, p.status
    FROM pcm.preventiva p WHERE p.status IN ('aberta','em_execucao')`)).rows;
  return {
    equipamentos: equipamentos.map(r => ({ id: r.id, codigo: r.codigo, nome: r.nome, camm: r.camm || '', local: r.local || '', ultimaConcluida: isoDay(r.ultima_concluida) })),
    folhas: folhas.map(r => ({ id: r.id, ativoId: r.ativo_id, numeroOm: r.numero_om || null, dataPrevista: isoDay(r.data_prevista), status: r.status }))
  };
}

async function lerValvulas(db) {
  // Mesma regra do painel das preventivas: última avaliação de cada válvula ativa; vida 1 ou 2 = crítica.
  return (await db.query(`WITH ult AS (${ULTIMO_SQL})
    SELECT a.codigo AS ativo_codigo, ci.tag, u.estado
    FROM ult u JOIN pcm.checklist_item ci ON ci.id=u.checklist_item_id AND ci.ativo
    JOIN pcm.ativo a ON a.id=ci.ativo_id AND a.ativo
    WHERE u.estado IN (1,2) ORDER BY u.estado, a.codigo, ci.posicao LIMIT 300`)).rows
    .map(r => ({ ativoCodigo: r.ativo_codigo, tag: r.tag, estado: Number(r.estado) }));
}

async function lerBateladas(db, hoje) {
  const painel = C.calcularPainel({ ...(await carregarBateladas(db)), hoje });
  return painel.ativos.map(a => ({ codigo: a.codigo, faixa: a.faixa, desdePreventiva: a.desdePreventiva, frequencia: a.frequencia }));
}

/** SCI e SCM no escopo de leitura da pessoa (só campos em claro: nada é decifrado aqui). */
async function lerSolicitacoes(db, user) {
  const out = [];
  for (const ns of ['sci', 'scm']) {
    const escopo = buildReadScope(user, ns, 2);
    const rows = (await db.query(`SELECT record_id, payload->>'status' AS status, payload->>'aprovadorId' AS aprovador, updated_at
      FROM app.sync_registro WHERE namespace=$1 AND NOT deleted${escopo.sql}
        AND (updated_at < now() - interval '3 days' OR payload->>'status'='pendente_aprovacao_lider')`, [ns, ...escopo.params])).rows;
    for (const r of rows) out.push({ namespace: ns, recordId: r.record_id, status: r.status || '', atualizadoEm: iso(r.updated_at), aprovador: r.aprovador || '' });
  }
  return out;
}

async function lerMedidores(db, user, ontem) {
  const em = buildReadScope(user, 'utility_meters', 1), el = buildReadScope(user, 'utility_readings', 2);
  const medidores = (await db.query(`SELECT coalesce(payload->>'id', record_id) AS id, payload->>'name' AS nome, payload->>'ativo' AS ativo
    FROM app.sync_registro WHERE namespace='utility_meters' AND NOT deleted${em.sql}`, em.params)).rows;
  // Leituras de anteontem em diante (o "at" é ISO em UTC; o dia local sai no JS, como no resto do servidor).
  const leituras = (await db.query(`SELECT payload->>'meterId' AS medidor, payload->>'at' AS em
    FROM app.sync_registro WHERE namespace='utility_readings' AND NOT deleted AND payload->>'at' >= $1${el.sql}`, [C.somaDias(ontem, -1), ...el.params])).rows;
  return {
    medidores: medidores.map(m => ({ id: String(m.id), nome: texto(m.nome) || 'Medidor', ativo: m.ativo !== 'false' })),
    leituras: leituras.map(l => ({ medidorId: String(l.medidor || ''), em: new Date(l.em) }))
      .filter(l => Number.isFinite(l.em.getTime())).map(l => ({ medidorId: l.medidorId, dia: isoDay(l.em) }))
  };
}

async function lerTreinamentos(db, user) {
  // A equipe vem de lms.equipe_visivel(); o progresso dos outros só é legível (RLS da 14) para admin, gestor, PCM e o
  // líder do grupo. Para os demais (ex.: almoxarife), progresso invisível pareceria "não concluído": fica só a própria pessoa.
  const pessoas = (await db.query('SELECT id, nome, grupo_id FROM lms.equipe_visivel()')).rows
    .map(p => ({ id: String(p.id), nome: p.nome, grupoId: p.grupo_id ? String(p.grupo_id) : null }))
    .filter(p => VE_PROGRESSO_DA_EQUIPE.has(user.perfilId) || p.id === String(user.id));
  const ec = buildReadScope(user, 'lms_courses', 1), ep = buildReadScope(user, 'lms_progress', 2);
  const cursos = (await db.query(`SELECT record_id, payload FROM app.sync_registro
    WHERE namespace='lms_courses' AND NOT deleted AND payload->>'status'='publicado' AND payload->>'mandatory'='true'${ec.sql}`, ec.params)).rows;
  const progressos = (await db.query(`SELECT payload->>'usuarioId' AS u, payload->>'course_id' AS c, payload->>'completed_at' AS concluido,
      payload->>'enrolled_at' AS inscrito, payload->>'version' AS versao, payload->>'expires_at' AS expira
    FROM app.sync_registro WHERE namespace='lms_progress' AND NOT deleted AND payload->>'usuarioId' = ANY($1::text[])${ep.sql}`,
  [pessoas.map(p => p.id), ...ep.params])).rows;
  const lista = v => (Array.isArray(v) ? v.map(String) : []);
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    pessoas,
    cursos: cursos.map(r => ({
      id: r.record_id, titulo: texto(r.payload?.title) || 'Curso', obrigatorio: r.payload?.mandatory === true || r.payload?.mandatory === 'true',
      publicado: r.payload?.status === 'publicado', publicadoEm: r.payload?.published_at || null, prazoDias: num(r.payload?.deadline_days),
      revisaoVersao: num(r.payload?.retrain_version), revisaoEm: r.payload?.retrain_at || null,
      publicoGrupos: lista(r.payload?.audience?.groups), publicoPessoas: lista(r.payload?.audience?.users)
    })),
    progressos: progressos.map(r => ({ usuarioId: r.u, cursoId: r.c, concluidoEm: r.concluido || null, inscritoEm: r.inscrito || null, versao: num(r.versao), expiraEm: r.expira || null }))
  };
}

/* ---------------------------------------------------------------- rotas */

router.get('/resumo', handle(async (req, res) => {
  const u = req.user, perfil = u.perfilId;
  const hoje = data(req.query.hoje) || hojeLocal(), ontem = C.somaDias(hoje, -1), agora = new Date().toISOString();
  const fontes = [];
  const itens = await transaction(u, async db => {
    const out = [];
    if (EQUIPE.has(perfil)) {
      const p = await lerPreventivas(db);
      out.push(...R.itensPreventivas(R.montarRelatorioManutinho(p.equipamentos, p.folhas, hoje)));
      out.push(...R.itensValvulas(await lerValvulas(db)));
      out.push(...R.itensBateladas(await lerBateladas(db, hoje)));
      fontes.push('preventivas', 'valvulas', 'bateladas');
    }
    if (SOLICITANTES.has(perfil)) {
      const regs = await lerSolicitacoes(db, u);
      out.push(...R.itensSolicitacoesParadas(regs, agora));
      out.push(...R.itensAprovacoes(regs.filter(r => r.aprovador === String(u.id)), agora));
      fontes.push('solicitacoes', 'aprovacoes');
    }
    if (MEDIDORES.has(perfil)) {
      const m = await lerMedidores(db, u, ontem);
      out.push(...R.itensMedidores(R.medidoresSemLeitura(m.medidores, m.leituras, ontem), ontem));
      fontes.push('medidores');
    }
    if (perfil !== 'terminal') {
      const t = await lerTreinamentos(db, u);
      out.push(...R.itensTreinamentos(R.treinamentosVencidos(t.cursos, t.pessoas, t.progressos, agora)));
      fontes.push('treinamentos');
    }
    return out;
  });
  const ordenados = R.ordenarItensManutinho(itens);
  res.set('Cache-Control', 'no-store').json({ ok: true, hoje, fontes, itens: ordenados, contagem: R.contarNiveisManutinho(ordenados) });
}));

/** Treinamentos vencidos com as pessoas (aba Pendências: escolher quem cobrar). Mesmo escopo do resumo. */
router.get('/treinamentos-vencidos', handle(async (req, res) => {
  if (req.user.perfilId === 'terminal') throw fail(403, 'Seu perfil não acessa os treinamentos.');
  const t = await transaction(req.user, db => lerTreinamentos(db, req.user));
  res.set('Cache-Control', 'no-store').json({ ok: true, vencidos: R.treinamentosVencidos(t.cursos, t.pessoas, t.progressos, new Date().toISOString()) });
}));

router.get('/relatorio-preventivas', handle(async (req, res) => {
  if (!EQUIPE.has(req.user.perfilId)) throw fail(403, 'Seu perfil não acessa as preventivas.');
  const hoje = data(req.query.hoje) || hojeLocal();
  const p = await transaction(req.user, lerPreventivas);
  res.set('Cache-Control', 'no-store').json({ ok: true, ...R.montarRelatorioManutinho(p.equipamentos, p.folhas, hoje) });
}));

/* ---------------------------------------------------------------- cobrança de treinamento */

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const limpa = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const RECUSAS = {
  sem_sessao: [401, 'Sessão inválida.'], sem_permissao: [403, 'Só administrador, gestor e líder de grupo enviam cobrança.'], proprio: [400, 'Você não pode cobrar a si mesmo.'],
  fora_da_equipe: [403, 'Essa pessoa não está na sua equipe.'], texto_invalido: [400, 'Texto da cobrança inválido.'],
  invalido: [400, 'Pessoa inválida.'], repetida: [409, 'Essa pessoa já recebeu uma cobrança nas últimas 24 horas.'], limite_do_dia: [429, 'Limite diário de cobranças atingido.']
};

/** E-mail da cobrança: modelo fixo do pacote compartilhado; só o nome de quem cobra e os títulos dos cursos entram, escapados. */
function corpoCobranca(quemCobra, cursos) {
  const m = R.modeloCobranca(quemCobra, cursos);
  return {
    assunto: m.assunto,
    html: '<div style="font-family:Arial,sans-serif;color:#173431;max-width:640px"><h2 style="color:#087b66">Lembrete de treinamento</h2>' +
      `<p>${esc(m.paragrafos[0])}</p>` +
      (cursos.length ? '<ul>' + cursos.map(c => `<li>${esc(c)}</li>`).join('') + '</ul>' : '') +
      `<p style="color:#55706d">${esc(m.paragrafos[1])}</p></div>`
  };
}

/** body: { itens: [{ pessoaId, cursos: ['Título', …] }] } — um e-mail por pessoa; cada uma passa pela regra do banco. */
router.post('/cobrar', async (req, res, next) => {
  try {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (!itens.length || itens.length > 25) return res.status(400).json({ ok: false, erro: 'Escolha de 1 a 25 pessoas.' });
    const resultado = [];
    for (const it of itens) {
      const id = String(it?.pessoaId || '');
      if (!UUID.test(id)) { resultado.push({ pessoaId: id.slice(0, 40), resultado: 'invalido' }); continue; }
      const cursos = (Array.isArray(it.cursos) ? it.cursos : []).slice(0, 10).map(c => limpa(c, 120)).filter(Boolean);
      const { assunto, html } = corpoCobranca(limpa(req.user.nome, 80), cursos);
      // A função do banco (nome da migration 39, mantido: a V5 usa o mesmo banco) confere perfil, equipe e limites.
      const r = await transaction(req.user, async db => (await db.query('SELECT lms.copiloto_cobrar($1, $2, $3) AS r', [id, assunto, html])).rows[0].r);
      resultado.push({ pessoaId: id, resultado: r });
    }
    const enviados = resultado.filter(x => x.resultado === 'ok').length;
    const primeira = resultado.find(x => x.resultado !== 'ok');
    if (!enviados && primeira && RECUSAS[primeira.resultado] && resultado.length === 1) return res.status(RECUSAS[primeira.resultado][0]).json({ ok: false, erro: RECUSAS[primeira.resultado][1], resultado });
    res.json({ ok: true, enviados, resultado, avisos: [...new Set(resultado.filter(x => x.resultado !== 'ok').map(x => (RECUSAS[x.resultado] || [0, 'Pessoa inválida.'])[1]))] });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports._test = { corpoCobranca, EQUIPE, SOLICITANTES, MEDIDORES };
