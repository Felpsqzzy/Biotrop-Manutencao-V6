const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireStepUpAdmin } = require('./twofa');

/*
 * PCM · Preventivas de válvulas diafragma (migration 15).
 *
 * O PCM lança uma folha para um equipamento (OM + data); técnico e líder preenchem
 * cada válvula: trocado S/N e vida 1–4. Quem preencheu é gravado AQUI, a partir da
 * sessão — o navegador não envia nome de técnico. As policies da migration 15 são a
 * segunda barreira para as mesmas regras.
 */
const router = express.Router();
const GESTAO = new Set(['admin', 'gestor', 'pcm']);
const EQUIPE = new Set(['admin', 'gestor', 'pcm', 'lider', 'tecnico']);
const ABERTA = new Set(['aberta', 'em_execucao']);
const STATUS = new Set(['aberta', 'em_execucao', 'concluida', 'cancelada']);
const CAMMS = new Set(['CAMM 1', 'CAMM 2', 'CAMM 3', 'C. LOG']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITENS = 200;

router.use(requireAuth);

function clean(value, maximum = 300) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum); }
function text(value, maximum = 2000) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, maximum); }
function uuid(value) { const v = String(value || ''); return UUID.test(v) ? v : null; }
function date(value) {
  const v = String(value || '');
  if (!DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}
function vida(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : undefined;
}
function trocado(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === 'S' || value === 'sim') return true;
  if (value === false || value === 'N' || value === 'nao') return false;
  return undefined;
}
function fail(status, message) { return Object.assign(new Error(message), { status, userMessage: message }); }
function gestao(user) { return GESTAO.has(user.perfilId); }
function equipe(user) { return EQUIPE.has(user.perfilId); }
// O driver pg entrega a coluna date como meia-noite LOCAL; toISOString() mudaria o dia fora de UTC.
function isoDay(v) {
  if (!v) return null;
  if (!(v instanceof Date)) return String(v).slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}

function exposeAtivo(row) {
  return { id: row.id, codigo: row.codigo, nome: row.nome, camm: row.camm || '', local: row.local || '', ativo: row.ativo !== false };
}
function exposeChecklist(row) {
  return {
    id: row.id, posicao: Number(row.posicao || 0), local: row.local_tanque, tag: row.tag, descricao: row.descricao,
    medida: row.medida, dn: row.dn, codigoMaterial: row.codigo_material, marca: row.marca, acao: row.acao, ativo: row.ativo !== false
  };
}
function exposePreventiva(row) {
  return {
    id: row.id, ativoId: row.ativo_id, ativoCodigo: row.ativo_codigo, ativoNome: row.ativo_nome, camm: row.camm || '',
    numeroOm: row.numero_om, dataPrevista: isoDay(row.data_prevista), status: row.status, origem: row.origem,
    observacoesPcm: row.observacoes_pcm, lancadaPor: row.lancada_por_nome, lancadaEm: row.lancada_em,
    concluidaPor: row.concluida_por_nome, concluidaEm: row.concluida_em, atualizadoEm: row.atualizado_em,
    itens: row.itens == null ? undefined : Number(row.itens),
    preenchidos: row.preenchidos == null ? undefined : Number(row.preenchidos),
    trocados: row.trocados == null ? undefined : Number(row.trocados)
  };
}
function exposeItem(row) {
  return {
    id: row.id, checklistItemId: row.checklist_item_id, posicao: Number(row.posicao || 0), local: row.local_tanque,
    tag: row.tag, descricao: row.descricao, medida: row.medida, dn: row.dn, codigoMaterial: row.codigo_material,
    marca: row.marca, acao: row.acao, trocado: row.trocado, vida: row.vida == null ? null : Number(row.vida),
    dataExecucao: isoDay(row.data_execucao), observacao: row.observacao, tecnico: row.tecnico_nome,
    registradoPor: row.registrado_por_nome && row.registrado_por_nome !== row.tecnico_nome ? row.registrado_por_nome : '',
    tecnicoId: row.tecnico_id, preenchidoEm: row.preenchido_em
  };
}
function exposeObs(row) { return { id: row.id, texto: row.texto, autor: row.autor_nome, autorId: row.autor_id, em: row.criado_em }; }

const PREVENTIVA_SQL = `SELECT p.*, a.codigo AS ativo_codigo, a.nome AS ativo_nome, a.camm::text AS camm,
    (SELECT count(*) FROM pcm.preventiva_item i WHERE i.preventiva_id=p.id) AS itens,
    (SELECT count(*) FROM pcm.preventiva_item i WHERE i.preventiva_id=p.id AND i.trocado IS NOT NULL AND i.vida IS NOT NULL) AS preenchidos,
    (SELECT count(*) FROM pcm.preventiva_item i WHERE i.preventiva_id=p.id AND i.trocado) AS trocados
  FROM pcm.preventiva p JOIN pcm.ativo a ON a.id=p.ativo_id`;

/* Estado atual de cada válvula = última folha preenchida (não cancelada).
   Diafragma trocado conta como novo (vida 4); senão vale a vida observada. */
const ULTIMO_SQL = `SELECT DISTINCT ON (i.checklist_item_id) i.checklist_item_id, i.vida, i.trocado,
    coalesce(i.data_execucao, p.data_prevista) AS data, i.tecnico_nome,
    CASE WHEN i.trocado THEN 4 ELSE i.vida END AS estado
  FROM pcm.preventiva_item i JOIN pcm.preventiva p ON p.id=i.preventiva_id
  WHERE p.status<>'cancelada' AND i.checklist_item_id IS NOT NULL AND (i.vida IS NOT NULL OR i.trocado IS NOT NULL)
  ORDER BY i.checklist_item_id, coalesce(i.data_execucao, p.data_prevista) DESC, i.preenchido_em DESC NULLS LAST`;

async function loadPreventiva(db, id, lock = false) {
  const row = (await db.query(`${PREVENTIVA_SQL} WHERE p.id=$1${lock ? ' FOR UPDATE OF p' : ''}`, [id])).rows[0];
  if (row) return row;
  // Para a equipe, a policy de UPDATE esconde do FOR UPDATE a folha já fechada.
  if (lock && (await db.query('SELECT 1 FROM pcm.preventiva WHERE id=$1', [id])).rowCount) {
    throw fail(409, 'Esta folha não está mais em aberto.');
  }
  throw fail(404, 'Preventiva não encontrada.');
}
async function fullPreventiva(db, id) {
  const row = await loadPreventiva(db, id);
  const itens = (await db.query('SELECT * FROM pcm.preventiva_item WHERE preventiva_id=$1 ORDER BY posicao,tag', [id])).rows;
  const obs = (await db.query('SELECT * FROM pcm.preventiva_observacao WHERE preventiva_id=$1 ORDER BY criado_em', [id])).rows;
  return { ...exposePreventiva(row), itens: itens.map(exposeItem), observacoes: obs.map(exposeObs) };
}

function handle(fn) {
  return async (req, res, next) => {
    try { await fn(req, res); } catch (error) {
      if (error.status && error.userMessage) return res.status(error.status).json({ ok: false, erro: error.userMessage, ...(error.extra || {}) });
      if (error.code === '23505') return res.status(409).json({ ok: false, erro: 'Já existe um equipamento com este código.' });
      if (error.code === '42501') return res.status(403).json({ ok: false, erro: 'Seu perfil não pode fazer esta alteração.' });
      next(error);
    }
  };
}
function needEquipe(req) { if (!equipe(req.user)) throw fail(403, 'Seu perfil não acessa as preventivas.'); }
function needGestao(req) { if (!gestao(req.user)) throw fail(403, 'Só o PCM, gestor ou administrador pode fazer isto.'); }

/* ---------------------------------------------------------------- painel */
router.get('/painel', handle(async (req, res) => {
  needEquipe(req);
  const data = await transaction(req.user, async db => {
    const equipamentos = (await db.query(`WITH ult AS (${ULTIMO_SQL})
      SELECT a.id,a.codigo,a.nome,a.camm::text AS camm,a.local,a.ativo,
        count(ci.id) AS itens,
        count(ci.id) FILTER (WHERE ci.acao='trocar') AS trocar,
        count(ci.id) FILTER (WHERE u.estado=1) AS v1,
        count(ci.id) FILTER (WHERE u.estado=2) AS v2,
        count(ci.id) FILTER (WHERE u.estado=3) AS v3,
        count(ci.id) FILTER (WHERE u.estado=4) AS v4,
        count(ci.id) FILTER (WHERE u.estado IS NULL) AS sem,
        (SELECT row_to_json(x) FROM (SELECT p.id, p.data_prevista, p.status, p.numero_om FROM pcm.preventiva p
           WHERE p.ativo_id=a.id AND p.status<>'cancelada' ORDER BY p.data_prevista DESC, p.lancada_em DESC LIMIT 1) x) AS ultima,
        (SELECT count(*) FROM pcm.preventiva p WHERE p.ativo_id=a.id AND p.status IN ('aberta','em_execucao')) AS abertas,
        (SELECT max(p.data_prevista) FROM pcm.preventiva p WHERE p.ativo_id=a.id AND p.status='concluida') AS ultima_concluida
      FROM pcm.ativo a
      LEFT JOIN pcm.checklist_item ci ON ci.ativo_id=a.id AND ci.ativo
      LEFT JOIN ult u ON u.checklist_item_id=ci.id
      WHERE a.ativo AND (a.local IN ('Fermentadores','Propagadores','Blenders')
        OR EXISTS (SELECT 1 FROM pcm.checklist_item c2 WHERE c2.ativo_id=a.id))
      GROUP BY a.id ORDER BY a.local, a.codigo`)).rows;
    const abertas = (await db.query(`${PREVENTIVA_SQL} WHERE p.status IN ('aberta','em_execucao') ORDER BY p.data_prevista, a.codigo`)).rows;
    const recentes = (await db.query(`${PREVENTIVA_SQL} WHERE p.status='concluida' ORDER BY p.concluida_em DESC NULLS LAST LIMIT 10`)).rows;
    const criticos = (await db.query(`WITH ult AS (${ULTIMO_SQL})
      SELECT a.id AS ativo_id, a.codigo AS ativo_codigo, a.nome AS ativo_nome, ci.id, ci.tag, ci.descricao, ci.dn,
        ci.codigo_material, ci.acao, u.vida, u.estado, u.data, u.tecnico_nome
      FROM ult u JOIN pcm.checklist_item ci ON ci.id=u.checklist_item_id AND ci.ativo
      JOIN pcm.ativo a ON a.id=ci.ativo_id AND a.ativo
      WHERE u.estado IN (1,2) ORDER BY u.estado, a.codigo, ci.posicao LIMIT 300`)).rows;
    // Últimos 12 meses: folhas concluídas e diafragmas trocados por mês (painel).
    const serie = (await db.query(`SELECT to_char(date_trunc('month', p.data_prevista),'YYYY-MM') AS mes,
        count(DISTINCT p.id) AS folhas, count(i.id) FILTER (WHERE i.trocado) AS trocados
      FROM pcm.preventiva p LEFT JOIN pcm.preventiva_item i ON i.preventiva_id=p.id
      WHERE p.status='concluida' AND p.data_prevista >= (date_trunc('month', current_date) - interval '11 months')::date
      GROUP BY 1 ORDER BY 1`)).rows;
    return { equipamentos, abertas, recentes, criticos, serie };
  });
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    podeGerir: gestao(req.user),
    equipamentos: data.equipamentos.map(r => ({
      ...exposeAtivo(r), itens: Number(r.itens), trocar: Number(r.trocar),
      vida: { 1: Number(r.v1), 2: Number(r.v2), 3: Number(r.v3), 4: Number(r.v4), sem: Number(r.sem) },
      abertas: Number(r.abertas),
      ultima: r.ultima ? { id: r.ultima.id, data: isoDay(r.ultima.data_prevista), status: r.ultima.status, numeroOm: r.ultima.numero_om } : null,
      ultimaConcluida: isoDay(r.ultima_concluida)
    })),
    abertas: data.abertas.map(exposePreventiva),
    recentes: data.recentes.map(exposePreventiva),
    serie: data.serie.map(r => ({ mes: r.mes, folhas: Number(r.folhas), trocados: Number(r.trocados) })),
    criticos: data.criticos.map(r => ({
      ativoId: r.ativo_id, ativoCodigo: r.ativo_codigo, ativoNome: r.ativo_nome, id: r.id, tag: r.tag, descricao: r.descricao,
      dn: r.dn, codigoMaterial: r.codigo_material, acao: r.acao, vida: r.vida, estado: r.estado, data: isoDay(r.data), tecnico: r.tecnico_nome
    }))
  });
}));

/* ---------------------------------------------------------------- equipamentos */
router.get('/equipamentos/:id', handle(async (req, res) => {
  needEquipe(req);
  const id = uuid(req.params.id);
  if (!id) throw fail(400, 'Equipamento inválido.');
  const data = await transaction(req.user, async db => {
    const ativo = (await db.query('SELECT id,codigo,nome,camm::text AS camm,local,ativo FROM pcm.ativo WHERE id=$1', [id])).rows[0];
    if (!ativo) throw fail(404, 'Equipamento não encontrado.');
    const itens = (await db.query(`WITH ult AS (${ULTIMO_SQL})
      SELECT ci.*, u.vida AS u_vida, u.trocado AS u_trocado, u.estado AS u_estado, u.data AS u_data, u.tecnico_nome AS u_tecnico
      FROM pcm.checklist_item ci LEFT JOIN ult u ON u.checklist_item_id=ci.id
      WHERE ci.ativo_id=$1 ORDER BY ci.ativo DESC, ci.posicao, ci.tag`, [id])).rows;
    const historico = (await db.query(`${PREVENTIVA_SQL} WHERE p.ativo_id=$1 ORDER BY p.data_prevista DESC, p.lancada_em DESC LIMIT 100`, [id])).rows;
    // Histórico de cada válvula: todas as avaliações nas folhas não canceladas deste equipamento.
    const linhas = (await db.query(`SELECT i.checklist_item_id, coalesce(i.data_execucao, p.data_prevista) AS data, i.trocado, i.vida,
        i.tecnico_nome, i.observacao, p.id AS preventiva_id, p.numero_om
      FROM pcm.preventiva_item i JOIN pcm.preventiva p ON p.id=i.preventiva_id
      WHERE p.ativo_id=$1 AND p.status<>'cancelada' AND i.checklist_item_id IS NOT NULL AND (i.vida IS NOT NULL OR i.trocado IS NOT NULL)
      ORDER BY coalesce(i.data_execucao, p.data_prevista) DESC, i.preenchido_em DESC NULLS LAST LIMIT 5000`, [id])).rows;
    return { ativo, itens, historico, linhas };
  });
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    equipamento: exposeAtivo(data.ativo),
    itens: data.itens.map(r => ({ ...exposeChecklist(r), ultimo: r.u_estado == null && r.u_trocado == null ? null
      : { vida: r.u_vida, trocado: r.u_trocado, estado: r.u_estado, data: isoDay(r.u_data), tecnico: r.u_tecnico } })),
    historico: data.historico.map(exposePreventiva),
    historicoItens: data.linhas.reduce((acc, r) => {
      (acc[r.checklist_item_id] = acc[r.checklist_item_id] || []).push({ data: isoDay(r.data), trocado: r.trocado,
        vida: r.vida == null ? null : Number(r.vida), tecnico: r.tecnico_nome, observacao: r.observacao, preventivaId: r.preventiva_id, numeroOm: r.numero_om });
      return acc;
    }, {})
  });
}));

// Cadastro de equipamento (prontuário) e importação do histórico são ações administrativas: pedem 2FA recente.
router.post('/equipamentos', requireStepUpAdmin(GESTAO), handle(async (req, res) => {
  needGestao(req);
  const body = req.body || {};
  const id = body.id ? uuid(body.id) : null;
  if (body.id && !id) throw fail(400, 'Equipamento inválido.');
  const codigo = clean(body.codigo, 40).toUpperCase();
  const nome = clean(body.nome, 160);
  const camm = CAMMS.has(clean(body.camm, 20)) ? clean(body.camm, 20) : null;
  const local = clean(body.local, 80);
  if (!codigo || !nome) throw fail(400, 'Código e nome do equipamento são obrigatórios.');
  if (!Array.isArray(body.itens) || body.itens.length > MAX_ITENS) throw fail(400, `Envie de 0 a ${MAX_ITENS} válvulas.`);
  const itens = body.itens.map((it, index) => ({
    id: it && it.id ? uuid(it.id) : null, posicao: index + 1, local: clean(it?.local, 60), tag: clean(it?.tag, 80),
    descricao: clean(it?.descricao, 300), medida: clean(it?.medida, 30), dn: clean(it?.dn, 20).toUpperCase(),
    codigoMaterial: clean(it?.codigoMaterial, 40).toUpperCase(), marca: clean(it?.marca, 40),
    acao: it?.acao === 'trocar' ? 'trocar' : 'avaliar'
  }));
  if (itens.some(it => !it.tag)) throw fail(400, 'Toda válvula precisa de TAG.');
  const saved = await transaction(req.user, async db => {
    let ativo;
    if (id) {
      ativo = (await db.query(`UPDATE pcm.ativo SET codigo=$2,nome=$3,camm=$4::core.camm,local=$5,ativo=$6,atualizado_em=now()
        WHERE id=$1 RETURNING id,codigo,nome,camm::text AS camm,local,ativo`, [id, codigo, nome, camm, local, body.ativo !== false])).rows[0];
      if (!ativo) throw fail(404, 'Equipamento não encontrado.');
    } else {
      ativo = (await db.query(`INSERT INTO pcm.ativo(codigo,nome,camm,local) VALUES($1,$2,$3::core.camm,$4)
        RETURNING id,codigo,nome,camm::text AS camm,local,ativo`, [codigo, nome, camm, local])).rows[0];
    }
    const kept = [];
    for (const it of itens) {
      const values = [ativo.id, it.posicao, it.local, it.tag, it.descricao, it.medida, it.dn, it.codigoMaterial, it.marca, it.acao];
      let row = null;
      if (it.id) {
        row = (await db.query(`UPDATE pcm.checklist_item SET posicao=$2,local_tanque=$3,tag=$4,descricao=$5,medida=$6,dn=$7,
          codigo_material=$8,marca=$9,acao=$10,ativo=true,atualizado_em=now() WHERE id=$11 AND ativo_id=$1 RETURNING id`, [...values, it.id])).rows[0];
      }
      if (!row) {
        row = (await db.query(`INSERT INTO pcm.checklist_item(ativo_id,posicao,local_tanque,tag,descricao,medida,dn,codigo_material,marca,acao)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, values)).rows[0];
      }
      kept.push(row.id);
    }
    // Válvula retirada do prontuário sai das próximas folhas, mas continua no histórico.
    await db.query(`UPDATE pcm.checklist_item SET ativo=false,atualizado_em=now()
      WHERE ativo_id=$1 AND ativo AND NOT (id = ANY($2::uuid[]))`, [ativo.id, kept]);
    return ativo;
  });
  res.json({ ok: true, equipamento: exposeAtivo(saved) });
}));

/* ---------------------------------------------------------------- folhas */
router.get('/preventivas', handle(async (req, res) => {
  needEquipe(req);
  const where = []; const args = [];
  const ativo = uuid(req.query.ativo);
  if (ativo) { args.push(ativo); where.push(`p.ativo_id=$${args.length}`); }
  const status = clean(req.query.status, 20);
  if (status === 'abertas') where.push("p.status IN ('aberta','em_execucao')");
  else if (STATUS.has(status)) { args.push(status); where.push(`p.status=$${args.length}`); }
  const de = date(req.query.de); const ate = date(req.query.ate);
  if (de) { args.push(de); where.push(`p.data_prevista>=$${args.length}`); }
  if (ate) { args.push(ate); where.push(`p.data_prevista<=$${args.length}`); }
  const rows = await transaction(req.user, db => db.query(
    `${PREVENTIVA_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY p.data_prevista DESC, p.lancada_em DESC LIMIT 500`, args));
  res.set('Cache-Control', 'no-store').json({ ok: true, rows: rows.rows.map(exposePreventiva) });
}));

router.get('/preventivas/:id', handle(async (req, res) => {
  needEquipe(req);
  const id = uuid(req.params.id);
  if (!id) throw fail(400, 'Preventiva inválida.');
  const preventiva = await transaction(req.user, db => fullPreventiva(db, id));
  res.set('Cache-Control', 'no-store').json({ ok: true, podeGerir: gestao(req.user), preventiva });
}));

/** PCM lança a folha: copia as válvulas ativas do prontuário do equipamento. */
router.post('/preventivas', handle(async (req, res) => {
  needGestao(req);
  const body = req.body || {};
  const ativoId = uuid(body.ativoId);
  const dataPrevista = date(body.dataPrevista);
  if (!ativoId || !dataPrevista) throw fail(400, 'Escolha o equipamento e a data da preventiva.');
  const preventiva = await transaction(req.user, async db => {
    const ativo = (await db.query('SELECT id FROM pcm.ativo WHERE id=$1 AND ativo', [ativoId])).rows[0];
    if (!ativo) throw fail(404, 'Equipamento não encontrado ou inativo.');
    const prev = (await db.query(`INSERT INTO pcm.preventiva(ativo_id,numero_om,data_prevista,observacoes_pcm,lancada_por,lancada_por_nome)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ativoId, clean(body.numeroOm, 40), dataPrevista, text(body.observacoesPcm), req.user.id, clean(req.user.nome || req.user.email, 160)])).rows[0];
    const copied = await db.query(`INSERT INTO pcm.preventiva_item(preventiva_id,checklist_item_id,posicao,local_tanque,tag,descricao,
        medida,dn,codigo_material,marca,acao)
      SELECT $1,id,posicao,local_tanque,tag,descricao,medida,dn,codigo_material,marca,acao
        FROM pcm.checklist_item WHERE ativo_id=$2 AND ativo ORDER BY posicao`, [prev.id, ativoId]);
    if (!copied.rowCount) throw fail(400, 'Este equipamento ainda não tem válvulas no prontuário. Cadastre as válvulas antes de lançar.');
    return fullPreventiva(db, prev.id);
  });
  res.status(201).json({ ok: true, preventiva });
}));

/** PCM corrige OM, data e observação, cancela ou reabre. */
router.patch('/preventivas/:id', handle(async (req, res) => {
  needGestao(req);
  const id = uuid(req.params.id);
  if (!id) throw fail(400, 'Preventiva inválida.');
  const body = req.body || {};
  const preventiva = await transaction(req.user, async db => {
    const current = await loadPreventiva(db, id, true);
    const next = {
      numeroOm: body.numeroOm === undefined ? current.numero_om : clean(body.numeroOm, 40),
      dataPrevista: body.dataPrevista === undefined ? isoDay(current.data_prevista) : date(body.dataPrevista),
      observacoesPcm: body.observacoesPcm === undefined ? current.observacoes_pcm : text(body.observacoesPcm),
      status: body.status === undefined ? current.status : clean(body.status, 20)
    };
    if (!next.dataPrevista) throw fail(400, 'Data inválida.');
    if (!STATUS.has(next.status) || next.status === 'concluida' && current.status !== 'concluida') {
      throw fail(400, 'Para concluir, use o botão Concluir da folha.');
    }
    const reopening = current.status === 'concluida' && next.status !== 'concluida';
    await db.query(`UPDATE pcm.preventiva SET numero_om=$2,data_prevista=$3,observacoes_pcm=$4,status=$5,atualizado_em=now()
      ${reopening ? ",concluida_em=NULL,concluida_por=NULL,concluida_por_nome=''" : ''} WHERE id=$1`,
    [id, next.numeroOm, next.dataPrevista, next.observacoesPcm, next.status]);
    return fullPreventiva(db, id);
  });
  res.json({ ok: true, preventiva });
}));

/**
 * Técnico/líder preenche linhas. Só as linhas que mudaram são regravadas, com o
 * nome de quem está logado — duas pessoas preenchendo a mesma folha não apagam uma
 * à outra.
 */
router.put('/preventivas/:id/itens', handle(async (req, res) => {
  needEquipe(req);
  const id = uuid(req.params.id);
  if (!id) throw fail(400, 'Preventiva inválida.');
  const incoming = Array.isArray(req.body?.itens) ? req.body.itens : null;
  if (!incoming || incoming.length > MAX_ITENS) throw fail(400, 'Lista de válvulas inválida.');
  const hoje = new Date().toISOString().slice(0, 10);
  const quem = clean(req.user.nome || req.user.email, 160);
  // Transcrição de folha de papel: só a gestão informa outro técnico e a data em que ele executou.
  const transc = gestao(req.user) ? clean(req.body?.tecnicoNome, 160) : '';
  const dataPapel = gestao(req.user) && req.body?.dataExecucao ? date(req.body.dataExecucao) : null;
  if (gestao(req.user) && req.body?.dataExecucao && !dataPapel) throw fail(400, 'Data da execução inválida.');
  if (dataPapel && dataPapel > hoje) throw fail(400, 'A data da execução não pode ser futura.');
  const executor = transc || quem;
  const result = await transaction(req.user, async db => {
    const current = await loadPreventiva(db, id, true);
    if (!ABERTA.has(current.status)) throw fail(409, 'Esta folha não está mais em aberto.');
    const rows = (await db.query('SELECT * FROM pcm.preventiva_item WHERE preventiva_id=$1', [id])).rows;
    const byId = new Map(rows.map(r => [r.id, r]));
    let changed = 0;
    for (const it of incoming) {
      const row = byId.get(uuid(it?.id));
      if (!row) throw fail(400, 'Válvula não pertence a esta folha.');
      const t = it.trocado === undefined ? row.trocado : trocado(it.trocado);
      const v = it.vida === undefined ? (row.vida == null ? null : Number(row.vida)) : vida(it.vida);
      if (t === undefined || v === undefined) throw fail(400, `Valor inválido na válvula ${row.tag}.`);
      const obs = it.observacao === undefined ? row.observacao : text(it.observacao, 500);
      const dataExec = it.dataExecucao === undefined ? isoDay(row.data_execucao) : (it.dataExecucao ? date(it.dataExecucao) : null);
      if (it.dataExecucao && !dataExec) throw fail(400, `Data inválida na válvula ${row.tag}.`);
      const vazio = t === null && v === null && !obs;
      const execucao = vazio ? null : (dataExec || (it.dataExecucao === undefined && dataPapel) || isoDay(row.data_execucao) || hoje);
      const before = [row.trocado, row.vida == null ? null : Number(row.vida), row.observacao, isoDay(row.data_execucao), row.tecnico_nome];
      if (JSON.stringify(before) === JSON.stringify([t, v, obs, execucao, vazio ? '' : executor])) continue;
      await db.query(`UPDATE pcm.preventiva_item SET trocado=$2,vida=$3,observacao=$4,data_execucao=$5,
        tecnico_id=$6,tecnico_nome=$7,preenchido_em=$8,registrado_por=$9,registrado_por_nome=$10 WHERE id=$1`,
      [row.id, t, v, obs, execucao, vazio || transc ? null : req.user.id, vazio ? '' : executor, vazio ? null : new Date(),
        vazio ? null : req.user.id, vazio ? '' : quem]);
      changed += 1;
    }
    if (changed && current.status === 'aberta') {
      await db.query("UPDATE pcm.preventiva SET status='em_execucao',atualizado_em=now() WHERE id=$1", [id]);
    } else if (changed) {
      await db.query('UPDATE pcm.preventiva SET atualizado_em=now() WHERE id=$1', [id]);
    }
    return { changed, preventiva: await fullPreventiva(db, id) };
  });
  res.json({ ok: true, alterados: result.changed, preventiva: result.preventiva });
}));

router.post('/preventivas/:id/observacoes', handle(async (req, res) => {
  needEquipe(req);
  const id = uuid(req.params.id);
  const texto = text(req.body?.texto);
  if (!id || !texto) throw fail(400, 'Escreva a observação.');
  const preventiva = await transaction(req.user, async db => {
    const current = await loadPreventiva(db, id, true);
    if (!ABERTA.has(current.status) && !gestao(req.user)) throw fail(409, 'Esta folha não está mais em aberto.');
    await db.query('INSERT INTO pcm.preventiva_observacao(preventiva_id,texto,autor_id,autor_nome) VALUES($1,$2,$3,$4)',
      [id, texto, req.user.id, clean(req.user.nome || req.user.email, 160)]);
    await db.query('UPDATE pcm.preventiva SET atualizado_em=now() WHERE id=$1', [id]);
    return fullPreventiva(db, id);
  });
  res.status(201).json({ ok: true, preventiva });
}));

router.post('/preventivas/:id/concluir', handle(async (req, res) => {
  needEquipe(req);
  const id = uuid(req.params.id);
  if (!id) throw fail(400, 'Preventiva inválida.');
  const preventiva = await transaction(req.user, async db => {
    const current = await loadPreventiva(db, id, true);
    if (!ABERTA.has(current.status)) throw fail(409, 'Esta folha não está mais em aberto.');
    // Válvula pela metade (só Trocado ou só a vida) nunca fecha a folha. Válvula toda em branco pode ficar
    // vazia — diafragma que não foi feito nesta preventiva — se quem conclui confirmar (vazias: true).
    const c = (await db.query(`SELECT
        count(*) FILTER (WHERE (trocado IS NULL) <> (vida IS NULL)) AS meio,
        count(*) FILTER (WHERE trocado IS NULL AND vida IS NULL) AS vazias,
        count(*) AS total,
        string_agg(tag, ', ' ORDER BY posicao) FILTER (WHERE trocado IS NULL AND vida IS NULL) AS tags
      FROM pcm.preventiva_item WHERE preventiva_id=$1`, [id])).rows[0];
    const meio = Number(c.meio), vazias = Number(c.vazias);
    if (meio) throw fail(400, `${meio} válvula(s) estão pela metade: marque Trocado e a vida, ou deixe a válvula toda em branco.`);
    if (vazias && vazias === Number(c.total)) throw fail(400, 'Nenhuma válvula foi preenchida. Se a preventiva não foi feita, cancele a folha.');
    if (vazias && req.body?.vazias !== true) {
      throw Object.assign(fail(409, `${vazias} válvula(s) ficarão vazias (não feitas nesta preventiva).`), { extra: { vazias } });
    }
    // Na transcrição, a folha fica em nome de quem executou; quem registrou aparece junto.
    const quem = clean(req.user.nome || req.user.email, 160);
    const executor = gestao(req.user) ? clean(req.body?.tecnicoNome, 160) : '';
    if (vazias) {
      await db.query('INSERT INTO pcm.preventiva_observacao(preventiva_id,texto,autor_id,autor_nome) VALUES($1,$2,$3,$4)',
        [id, `Concluída com ${vazias} válvula(s) vazia(s), não feitas nesta preventiva: ${String(c.tags || '').slice(0, 1800)}`, req.user.id, quem]);
    }
    await db.query(`UPDATE pcm.preventiva SET status='concluida',concluida_em=now(),concluida_por=$2,
      concluida_por_nome=$3,atualizado_em=now() WHERE id=$1`, [id, req.user.id, executor && executor !== quem ? `${executor} · registrado por ${quem}`.slice(0, 200) : quem]);
    return fullPreventiva(db, id);
  });
  res.json({ ok: true, preventiva });
}));

/* ---------------------------------------------------------------- importação de folhas transcritas
 * Folhas preenchidas no papel (PDF/foto) transcritas para um arquivo e lançadas de uma vez pelo PCM.
 * Cada folha: { equipamento, data, om?, tecnico?, observacao?, valvulas: [{ posicao?, tag?, trocado, vida, obs?, data? }] }.
 * Válvula fora da lista fica vazia (não feita). Folha já concluída no mesmo dia é pulada; folha aberta no
 * mesmo dia é preenchida e concluída. simular=true confere tudo e desfaz (nada é gravado).
 */
const MAX_IMPORT = 200;
const MAX_VALVULAS_IMPORT = 6000;
class Simulacao extends Error {}
function codigoEquipamento(value) {
  const v = clean(value, 40).toUpperCase().replace(/\s+/g, '');
  const m = /^(FTD|PGD|BLD|BLR|TLP|TLF)\D*0*(\d{1,3})$/.exec(v);
  if (!m) return v;
  return `${m[1] === 'BLR' ? 'BLD' : m[1]}${m[2].padStart(2, '0')}`;
}
function tagChave(value) { return clean(value, 80).toUpperCase().replace(/[\s–—]+/g, '').replace(/-+/g, '-'); }
function dataBr(value) {
  const v = clean(value, 20);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  return date(br ? `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}` : v);
}

// A prévia (simular: true) roda na transação desfeita e não grava: não pede código. A importação real pede.
const stepUpImportar = requireStepUpAdmin(GESTAO);
function stepUpSalvoPrevia(req, res, next) { return req.body?.simular === true ? next() : stepUpImportar(req, res, next); }
router.post('/importar', stepUpSalvoPrevia, handle(async (req, res) => {
  needGestao(req);
  const folhas = Array.isArray(req.body?.folhas) ? req.body.folhas : null;
  if (!folhas || !folhas.length || folhas.length > MAX_IMPORT) throw fail(400, `Envie de 1 a ${MAX_IMPORT} folhas.`);
  const totalValvulas = folhas.reduce((n, f) => n + (Array.isArray(f?.valvulas) ? f.valvulas.length : 0), 0);
  if (totalValvulas > MAX_VALVULAS_IMPORT) throw fail(400, `Arquivo grande demais: ${totalValvulas} válvulas (máximo ${MAX_VALVULAS_IMPORT} por importação). Divida em partes.`);
  const simular = req.body?.simular === true;
  const hoje = new Date().toISOString().slice(0, 10);
  const quem = clean(req.user.nome || req.user.email, 160);
  const relatorio = [];
  const executar = async db => {
    await db.query("SET LOCAL statement_timeout = '60s'");
    for (const [n, f] of folhas.entries()) {
      const linha = { n: n + 1, equipamento: codigoEquipamento(f?.equipamento), data: dataBr(f?.data), situacao: '', avisos: [] };
      relatorio.push(linha);
      await db.query('SAVEPOINT folha');
      try {
        if (!linha.data) throw fail(400, 'data inválida (use AAAA-MM-DD ou DD/MM/AAAA)');
        if (linha.data > hoje) throw fail(400, 'data no futuro');
        const ativo = (await db.query('SELECT id,codigo FROM pcm.ativo WHERE upper(codigo)=$1', [linha.equipamento])).rows[0];
        if (!ativo) throw fail(400, `equipamento ${linha.equipamento} não existe no site`);
        const valvulas = Array.isArray(f.valvulas) ? f.valvulas : [];
        if (!valvulas.length || valvulas.length > MAX_ITENS) throw fail(400, 'informe as válvulas feitas');
        const tecnico = clean(f.tecnico, 160);
        let prev = (await db.query(`SELECT id,status FROM pcm.preventiva WHERE ativo_id=$1 AND data_prevista=$2 AND status<>'cancelada'
          ORDER BY lancada_em DESC LIMIT 1`, [ativo.id, linha.data])).rows[0];
        if (prev && prev.status === 'concluida') { linha.situacao = 'ja_existe'; await db.query('RELEASE SAVEPOINT folha'); continue; }
        if (!prev) {
          prev = (await db.query(`INSERT INTO pcm.preventiva(ativo_id,numero_om,data_prevista,status,origem,observacoes_pcm,lancada_por,lancada_por_nome)
            VALUES($1,$2,$3,'em_execucao','planilha',$4,$5,$6) RETURNING id,status`,
          [ativo.id, clean(f.om, 40), linha.data, text(f.observacao), req.user.id, `${quem} · importação de folhas transcritas`.slice(0, 160)])).rows[0];
          const copiadas = await db.query(`INSERT INTO pcm.preventiva_item(preventiva_id,checklist_item_id,posicao,local_tanque,tag,descricao,
              medida,dn,codigo_material,marca,acao)
            SELECT $1,id,posicao,local_tanque,tag,descricao,medida,dn,codigo_material,marca,acao
              FROM pcm.checklist_item WHERE ativo_id=$2 AND ativo ORDER BY posicao`, [prev.id, ativo.id]);
          if (!copiadas.rowCount) throw fail(400, `${linha.equipamento} não tem válvulas no prontuário`);
          linha.situacao = 'criada';
        } else {
          if (f.om) await db.query('UPDATE pcm.preventiva SET numero_om=$2 WHERE id=$1', [prev.id, clean(f.om, 40)]);
          linha.situacao = 'preenchida';
        }
        const itens = (await db.query('SELECT id,posicao,tag FROM pcm.preventiva_item WHERE preventiva_id=$1 ORDER BY posicao', [prev.id])).rows;
        const porTag = new Map();
        for (const it of itens) { const k = tagChave(it.tag); porTag.set(k, porTag.has(k) ? null : it); }
        const usados = new Set();
        let feitas = 0;
        for (const v of valvulas) {
          const pos = Number(v?.posicao);
          let item = Number.isInteger(pos) && pos > 0 ? itens.find(i => Number(i.posicao) === pos) : undefined;
          if (!item && v?.tag) {
            item = porTag.get(tagChave(v.tag));
            if (item === null) { linha.avisos.push(`TAG ${clean(v.tag, 80)} aparece mais de uma vez: informe a posição`); continue; }
          }
          if (!item) { linha.avisos.push(`válvula ${clean(v?.tag || v?.posicao, 80)} não está no prontuário`); continue; }
          if (usados.has(item.id)) { linha.avisos.push(`válvula ${item.tag} repetida no arquivo`); continue; }
          const t = trocado(typeof v.trocado === 'string' ? v.trocado.trim().toUpperCase().slice(0, 1) : v.trocado);
          const vi = vida(v.vida);
          if (t === undefined || vi === undefined) { linha.avisos.push(`valor inválido em ${item.tag}`); continue; }
          if ((t === null) !== (vi === null)) { linha.avisos.push(`${item.tag} pela metade (precisa de Trocado e da vida): ficou vazia`); continue; }
          if (t === null) continue;
          usados.add(item.id);
          const execucao = dataBr(v.data) || linha.data;
          await db.query(`UPDATE pcm.preventiva_item SET trocado=$2,vida=$3,observacao=$4,data_execucao=$5,tecnico_id=NULL,tecnico_nome=$6,
            preenchido_em=now(),registrado_por=$7,registrado_por_nome=$8 WHERE id=$1`,
          [item.id, t, vi, text(v.obs, 500), execucao, tecnico || quem, req.user.id, quem]);
          feitas += 1;
        }
        if (!feitas) throw fail(400, 'nenhuma válvula válida no arquivo');
        const vazias = itens.length - feitas;
        linha.feitas = feitas; linha.vazias = vazias;
        await db.query('INSERT INTO pcm.preventiva_observacao(preventiva_id,texto,autor_id,autor_nome) VALUES($1,$2,$3,$4)', [prev.id,
          `Folha transcrita do papel e importada por ${quem}: ${feitas} válvula(s) lançada(s)${vazias ? `, ${vazias} vazia(s) (não feitas nesta preventiva)` : ''}.`, req.user.id, quem]);
        await db.query(`UPDATE pcm.preventiva SET status='concluida',concluida_em=$2::date::timestamptz + interval '12 hours',concluida_por=$3,
          concluida_por_nome=$4,atualizado_em=now() WHERE id=$1`,
        [prev.id, linha.data, req.user.id, (tecnico && tecnico !== quem ? `${tecnico} · registrado por ${quem}` : quem).slice(0, 200)]);
        await db.query('RELEASE SAVEPOINT folha');
      } catch (error) {
        if (!error.userMessage) throw error;
        // folha com erro não deixa nada pela metade
        await db.query('ROLLBACK TO SAVEPOINT folha');
        linha.situacao = 'erro'; linha.erro = error.userMessage; delete linha.feitas; delete linha.vazias;
      }
    }
    if (simular) throw new Simulacao();
  };
  try { await transaction(req.user, executar); } catch (error) { if (!(error instanceof Simulacao)) throw error; }
  const conta = s => relatorio.filter(l => l.situacao === s).length;
  res.json({ ok: true, simulado: simular, relatorio,
    resumo: { criadas: conta('criada'), preenchidas: conta('preenchida'), jaExistiam: conta('ja_existe'), erros: conta('erro') } });
}));

/** Prontuário completo: a folha mais recente (não cancelada) de cada equipamento no período. */
async function relatorioTodos(user, de, ate) {
  return transaction(user, async db => {
    const args = []; let filtro = "p.status<>'cancelada'";
    if (de) { args.push(de); filtro += ` AND p.data_prevista>=$${args.length}`; }
    if (ate) { args.push(ate); filtro += ` AND p.data_prevista<=$${args.length}`; }
    const ultimas = (await db.query(`SELECT DISTINCT ON (p.ativo_id) p.id FROM pcm.preventiva p
      WHERE ${filtro} ORDER BY p.ativo_id, p.data_prevista DESC, p.lancada_em DESC`, args)).rows.map(r => r.id);
    const folhas = [];
    for (const id of ultimas) folhas.push(await fullPreventiva(db, id));
    return { ok: true, preventivas: folhas };
  });
}

/** Dados completos para a exportação em Excel (uma aba por folha). */
router.get('/relatorio', handle(async (req, res) => {
  needEquipe(req);
  const ativo = uuid(req.query.ativo);
  const de = date(req.query.de); const ate = date(req.query.ate);
  if (req.query.todos === '1') return res.set('Cache-Control', 'no-store').json(await relatorioTodos(req.user, de, ate));
  if (!ativo) throw fail(400, 'Escolha o equipamento.');
  const data = await transaction(req.user, async db => {
    const equipamento = (await db.query('SELECT id,codigo,nome,camm::text AS camm,local,ativo FROM pcm.ativo WHERE id=$1', [ativo])).rows[0];
    if (!equipamento) throw fail(404, 'Equipamento não encontrado.');
    const args = [ativo]; let filtro = " AND p.status<>'cancelada'";
    if (de) { args.push(de); filtro += ` AND p.data_prevista>=$${args.length}`; }
    if (ate) { args.push(ate); filtro += ` AND p.data_prevista<=$${args.length}`; }
    const folhas = (await db.query(`${PREVENTIVA_SQL} WHERE p.ativo_id=$1${filtro} ORDER BY p.data_prevista, p.lancada_em LIMIT 120`, args)).rows;
    const ids = folhas.map(f => f.id);
    const itens = ids.length ? (await db.query('SELECT * FROM pcm.preventiva_item WHERE preventiva_id = ANY($1::uuid[]) ORDER BY posicao,tag', [ids])).rows : [];
    const obs = ids.length ? (await db.query('SELECT * FROM pcm.preventiva_observacao WHERE preventiva_id = ANY($1::uuid[]) ORDER BY criado_em', [ids])).rows : [];
    return { equipamento, folhas, itens, obs };
  });
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    equipamento: exposeAtivo(data.equipamento),
    preventivas: data.folhas.map(f => ({
      ...exposePreventiva(f),
      itens: data.itens.filter(i => i.preventiva_id === f.id).map(exposeItem),
      observacoes: data.obs.filter(o => o.preventiva_id === f.id).map(exposeObs)
    }))
  });
}));

module.exports = router;
module.exports.ULTIMO_SQL = ULTIMO_SQL;   // Manutinho (válvulas críticas) usa a mesma regra de vida
module.exports._test = { clean, date, vida, trocado, gestao, equipe, GESTAO, EQUIPE };
