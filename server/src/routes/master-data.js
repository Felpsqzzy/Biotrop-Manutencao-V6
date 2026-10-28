const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireStepUpAdmin } = require('./twofa');

const router = express.Router();
const LISTS = new Set([
  'scm_time', 'scm_tipo_solicitacao', 'scm_urgencia',
  'scm_tipo_fornecedor', 'scm_tipo_pedido', 'scm_centro_custo'
]);
// Cadastros dos formulários são do ALMOXARIFADO (com gestão e administração). O PCM não edita (migration 24).
const EDITORS = new Set(['admin', 'gestor', 'almoxarife']);
const NAO_GRAVOU = 'O banco não gravou a alteração (registro não encontrado ou sem permissão). Atualize a tela e tente de novo.';

function clean(value, maximum = 300) {
  return String(value ?? '').trim().slice(0, maximum);
}

function expose(row) {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    posicao: Number(row.posicao || 0),
    ativo: row.ativo !== false,
    metadata: row.metadata || {},
    campos: row.campos || []
  };
}

function validateResource(query) {
  const resource = clean(query.resource, 60);
  const list = clean(query.list, 60);
  if (resource === 'camm' || resource === 'familias') return { resource, list: null };
  if (resource === 'lista' && LISTS.has(list)) return { resource, list };
  return null;
}

function canEdit(user) {
  return EDITORS.has(user.perfilId);
}

async function listRows(req, res, next) {
  const target = validateResource(req.query);
  if (!target) return res.status(400).json({ ok: false, erro: 'Cadastro inválido.' });
  try {
    const rows = await transaction(req.user, async db => {
      if (target.resource === 'camm') {
        return (await db.query('SELECT id,codigo,nome,posicao,ativo FROM core.camm_catalogo ORDER BY ativo DESC,posicao,nome')).rows;
      }
      if (target.resource === 'lista') {
        return (await db.query('SELECT id,codigo,nome,posicao,ativo,metadata FROM core.lista_catalogo WHERE lista=$1 ORDER BY ativo DESC,posicao,nome', [target.list])).rows;
      }
      return (await db.query(`SELECT f.id,f.id AS codigo,f.nome,f.posicao,f.ativo,
        COALESCE(json_agg(json_build_object('id',fc.id,'id_campo',fc.chave,'label',fc.rotulo,
          'obrigatorio',fc.obrigatorio,'posicao',fc.posicao) ORDER BY fc.posicao,fc.rotulo)
          FILTER (WHERE fc.id IS NOT NULL AND fc.ativo),'[]') AS campos
        FROM almox.familia f LEFT JOIN almox.familia_campo fc ON fc.familia_id=f.id
        GROUP BY f.id,f.nome,f.posicao,f.ativo ORDER BY f.ativo DESC,f.posicao,f.nome`)).rows;
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, rows: rows.map(expose) });
  } catch (error) { next(error); }
}

async function saveCatalog(db, target, body) {
  const codigo = clean(body.codigo, 120);
  const nome = clean(body.nome || codigo, 240);
  if (!codigo || !nome) return { error: 'Nome e código são obrigatórios.' };
  const values = [codigo, nome, Number(body.posicao || 0), body.ativo !== false];
  if (target.resource === 'camm') {
    const row = (await db.query(`INSERT INTO core.camm_catalogo(codigo,nome,posicao,ativo)
      VALUES($1,$2,$3,$4) ON CONFLICT(codigo) DO UPDATE SET nome=excluded.nome,
      posicao=excluded.posicao,ativo=excluded.ativo,atualizado_em=now()
      RETURNING id,codigo,nome,posicao,ativo`, values)).rows[0];
    return { row: expose(row) };
  }
  let metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  if (target.list === 'scm_centro_custo') {
    let costId = metadata.centro_custo_id ? Number(metadata.centro_custo_id) : null;
    if (!costId) {
      const existing = await db.query('SELECT id FROM almox.centro_custo WHERE lower(nome)=lower($1) LIMIT 1', [nome]);
      if (existing.rowCount) costId = Number(existing.rows[0].id);
      else {
        await db.query('LOCK TABLE almox.centro_custo IN EXCLUSIVE MODE');
        costId = Number((await db.query('SELECT coalesce(max(id),0)+1 id FROM almox.centro_custo')).rows[0].id);
        if (costId > 32767) return { error: 'Limite de centros de custo atingido.', status: 409 };
        await db.query('INSERT INTO almox.centro_custo(id,nome) VALUES($1,$2)', [costId, nome]);
      }
    } else await db.query('UPDATE almox.centro_custo SET nome=$1 WHERE id=$2', [nome, costId]);
    metadata = { ...metadata, centro_custo_id: costId };
  }
  const row = (await db.query(`INSERT INTO core.lista_catalogo(lista,codigo,nome,posicao,ativo,metadata)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(lista,codigo) DO UPDATE SET nome=excluded.nome,
    posicao=excluded.posicao,ativo=excluded.ativo,metadata=excluded.metadata,atualizado_em=now()
    RETURNING id,codigo,nome,posicao,ativo,metadata`,
  [target.list, ...values, JSON.stringify(metadata)])).rows[0];
  return { row: expose(row) };
}

async function camposDaFamilia(db, id) {
  return (await db.query(`SELECT id, chave AS id_campo, rotulo AS label, obrigatorio, posicao FROM almox.familia_campo
    WHERE familia_id=$1 AND ativo ORDER BY posicao, rotulo`, [id])).rows;
}

/** Só liga/desliga a família (o interruptor da tela), sem mexer nos campos. */
async function statusFamily(db, body) {
  const id = clean(body.id, 120), ativo = body.ativo !== false;
  const r = await db.query('UPDATE almox.familia SET ativo=$2,atualizado_em=now() WHERE id=$1 RETURNING id,nome,posicao,ativo', [id, ativo]);
  if (!r.rowCount) return { error: NAO_GRAVOU, status: 409 };
  let campos = await camposDaFamilia(db, id);
  // famílias desligadas antes desta correção tinham todos os campos desligados junto: ao religar, eles voltam
  if (ativo && !campos.length) {
    await db.query('UPDATE almox.familia_campo SET ativo=true WHERE familia_id=$1', [id]);
    campos = await camposDaFamilia(db, id);
  }
  return { row: { ...r.rows[0], codigo: id, posicao: Number(r.rows[0].posicao || 0), campos } };
}

async function saveFamily(db, body) {
  if (body.somenteStatus === true) return statusFamily(db, body);
  const id = clean(body.id, 120);
  const nome = clean(body.nome, 200);
  if (!id || !nome) return { error: 'ID e nome da família são obrigatórios.' };
  const fields = Array.isArray(body.campos) ? body.campos.slice(0, 100) : [];
  const salvo = await db.query(`INSERT INTO almox.familia(id,nome,posicao,ativo) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO UPDATE SET nome=excluded.nome,posicao=excluded.posicao,
    ativo=excluded.ativo,atualizado_em=now() RETURNING ativo`, [id, nome, Number(body.posicao || 0), body.ativo !== false]);
  if (!salvo.rowCount) return { error: NAO_GRAVOU, status: 409 };
  await db.query('UPDATE almox.familia_campo SET ativo=false WHERE familia_id=$1', [id]);
  for (let index = 0; index < fields.length; index += 1) {
    const key = clean(fields[index].id || fields[index].id_campo, 100);
    const label = clean(fields[index].label || fields[index].rotulo, 200);
    if (!key || !label) continue;
    await db.query(`INSERT INTO almox.familia_campo(familia_id,chave,rotulo,obrigatorio,posicao,ativo)
      VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(familia_id,chave) DO UPDATE SET rotulo=excluded.rotulo,
      obrigatorio=excluded.obrigatorio,posicao=excluded.posicao,ativo=true`,
    [id, key, label, fields[index].obrigatorio === true, index]);
  }
  return { row: { id, codigo: id, nome, posicao: Number(body.posicao || 0), ativo: body.ativo !== false, campos: fields } };
}

async function saveRow(req, res, next) {
  const target = validateResource(req.query);
  if (!target) return res.status(400).json({ ok: false, erro: 'Cadastro inválido.' });
  if (!canEdit(req.user, target.resource)) return res.status(403).json({ ok: false, erro: 'Seu perfil não pode editar este cadastro.' });
  try {
    const result = await transaction(req.user, db => target.resource === 'familias'
      ? saveFamily(db, req.body || {}) : saveCatalog(db, target, req.body || {}));
    if (result.error) return res.status(result.status || 400).json({ ok: false, erro: result.error });
    res.json({ ok: true, row: result.row });
  } catch (error) { next(error); }
}

async function deactivateRow(req, res, next) {
  const target = validateResource(req.query);
  const id = clean(req.query.id, 120);
  if (!target || !id) return res.status(400).json({ ok: false, erro: 'Cadastro e ID são obrigatórios.' });
  if (!canEdit(req.user, target.resource)) return res.status(403).json({ ok: false, erro: 'Seu perfil não pode editar este cadastro.' });
  try {
    const n = await transaction(req.user, async db => {
      if (target.resource === 'camm') return (await db.query('UPDATE core.camm_catalogo SET ativo=false,atualizado_em=now() WHERE id=$1', [id])).rowCount;
      if (target.resource === 'lista') return (await db.query('UPDATE core.lista_catalogo SET ativo=false,atualizado_em=now() WHERE id=$1 AND lista=$2', [id, target.list])).rowCount;
      // a família fica oculta, mas os campos continuam cadastrados: ao reativar ela volta inteira
      return (await db.query('UPDATE almox.familia SET ativo=false,atualizado_em=now() WHERE id=$1', [id])).rowCount;
    });
    // nenhuma linha alterada = não existe ou o banco recusou (RLS): nunca responder "ok" sem gravar
    if (!n) return res.status(409).json({ ok: false, erro: NAO_GRAVOU });
    res.json({ ok: true });
  } catch (error) { next(error); }
}

router.use(requireAuth);
router.get('/', listRows);
// Cadastro mestre é ação administrativa: 2FA ativo e confirmado nos últimos 10 minutos.
router.post('/', requireStepUpAdmin(EDITORS), saveRow);
router.delete('/', requireStepUpAdmin(EDITORS), deactivateRow);

module.exports = router;
module.exports._test = { clean, expose, validateResource, canEdit };
