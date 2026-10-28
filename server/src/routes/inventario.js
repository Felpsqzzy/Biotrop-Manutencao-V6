'use strict';
// Inventário do almoxarifado (migrations 34 e 36). Toda escrita passa por inventario.executar() no banco,
// que repete as regras desta rota: três contadores distintos por lista, contagem cega, justificativa de
// divergência e aprovação pela gestão (quem contou não acompanha nem aprova o inventário aberto).
const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireStepUpAdmin } = require('./twofa');
const { decimal, report, biDataset } = require('../lib/inventario');
const router = express.Router();
const MANAGERS = new Set(['admin', 'gestor', 'almoxarife']);
const APPROVERS = new Set(['admin', 'gestor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
function manager(req) { if (!MANAGERS.has(req.user.perfilId)) throw fail(403, 'Somente almoxarifado, gestão e administração.'); }
function id(value) { if (!UUID.test(String(value || ''))) throw fail(400, 'Identificador inválido.'); return String(value); }
function text(value, maximum, required = false) {
  const v = String(value ?? '').trim();
  if (v.length > maximum || (required && !v)) throw fail(400, 'Texto obrigatório ou acima do limite.');
  return v;
}
function date(value, required = true) {
  const v = String(value || '');
  if (!v && !required) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw fail(400, 'Data inválida.');
  return v;
}
function jsonObject(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 20000) throw fail(400, 'Dimensões extras ou origem do preço inválidas.');
  return value;
}
function amount(value, signed = true) { try { return decimal(value, signed); } catch (e) { throw fail(400, e.message); } }
function normalizeLine(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail(400, 'Linha inválida.');
  const codigo = text(v.codigo, 40, true).toUpperCase();
  if (!/^MAN[A-Z0-9._/-]*$/.test(codigo)) throw fail(400, 'Informe um código MAN do catálogo.');
  if (v.moeda != null && v.moeda !== 'BRL') throw fail(400, 'O inventário usa BRL.');
  const out = { codigo, descricao: text(v.descricao, 500, true), unidade: text(v.unidade, 20),
    saldo: amount(v.saldo), precoUnitario: v.precoUnitario == null || v.precoUnitario === '' ? null : amount(v.precoUnitario, false),
    dimensoesExtras: jsonObject(v.dimensoesExtras), origemPreco: jsonObject(v.origemPreco) };
  for (const k of ['site', 'deposito', 'localizacao', 'lote', 'serie', 'variante', 'status']) out[k] = text(v[k], 120, ['site', 'deposito', 'localizacao'].includes(k));
  return out;
}
// Pendências da importação: linha da planilha, código e motivo. Ficam guardadas na base, nunca viram saldo.
function normalizePending(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 20000) throw fail(400, 'Pendências inválidas.');
  const out = list.map(p => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw fail(400, 'Pendência inválida.');
    const linha = Number(p.linha);
    return { linha: Number.isSafeInteger(linha) && linha > 0 ? linha : null, codigo: text(p.codigo, 40), localizacao: text(p.localizacao, 120),
      motivo: text(p.motivo, 200, true), tipo: text(p.tipo, 40) };
  });
  if (JSON.stringify(out).length > 1500000) throw fail(400, 'Pendências acima do limite.');
  return out;
}
function handle(fn) { return async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); await fn(req, res); } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, erro: e.message });
    if (e.code === '42501') return res.status(403).json({ ok: false, erro: e.message.split('\n')[0] });
    if (e.code === 'P0002') return res.status(404).json({ ok: false, erro: e.message });
    if (e.code === 'P0001') return res.status(409).json({ ok: false, erro: e.message });
    if (e.code === '23505') return res.status(409).json({ ok: false, erro: 'Dimensão ou linha repetida. A parte inteira foi recusada.' });
    if (e.code === '23503') return res.status(400).json({ ok: false, erro: 'Código ausente do catálogo ou referência inválida.' });
    if (['22023', '22003', '22P02', '22007', '22008', '23514', '23502'].includes(e.code)) return res.status(400).json({ ok: false, erro: e.code === '22023' ? e.message.split('\n')[0] : 'Dados inválidos: confira dimensões, datas e números.' });
    next(e);
  }
}; }
async function execute(req, action, payload) {
  return transaction(req.user, async db => (await db.query('SELECT inventario.executar($1,$2::jsonb) AS resultado', [action, JSON.stringify(payload)])).rows[0].resultado);
}
function exposeItem(row, user, full) {
  const out = { id: row.id, campanhaId: row.campanha_id, codigo: row.codigo, descricao: row.descricao, unidade: row.unidade,
    site: row.site, deposito: row.deposito, localizacao: row.localizacao, lote: row.lote, serie: row.serie, variante: row.variante,
    status: row.status, dimensoesExtras: row.dimensoes_extras, camm: row.camm || '', etapa: row.etapa, encerrado: row.encerrado, versao: row.versao,
    contador1Id: row.contador1_id, contador2Id: row.contador2_id, contador3Id: row.contador3_id,
    minhaEtapa: !row.encerrado && [row.contador1_id, row.contador2_id, row.contador3_id][row.etapa - 1] === user.id };
  if (full) Object.assign(out, { linhaId: row.linha_id, saldo: row.saldo,
    precoUnitario: row.preco_unitario, origemPreco: row.origem_preco, quantidadeFinal: row.quantidade_final,
    contagens: row.contagens || [], justificativas: row.justificativas || [], moeda: 'BRL' });
  return out;
}
function snapshotLine(r) {
  return { id: r.id, snapshotId: r.snapshot_id, codigo: r.codigo, descricao: r.descricao, unidade: r.unidade,
    site: r.site, deposito: r.deposito, localizacao: r.localizacao, lote: r.lote, serie: r.serie, variante: r.variante,
    status: r.status, dimensoesExtras: r.dimensoes_extras, saldo: r.saldo, precoUnitario: r.preco_unitario, origemPreco: r.origem_preco, moeda: 'BRL' };
}
function snapshotRow(s) {
  return { id: s.id, nome: s.nome, data_referencia: s.data_referencia, data_exportacao: s.data_exportacao, fonte: s.fonte, estado: s.estado,
    criado_por: s.criado_por, criado_em: s.criado_em, finalizado_em: s.finalizado_em, arquivo_hash: s.arquivo_hash,
    resumo: s.resumo || {}, linhas: s.linhas, pendencias: s.qtd_pendencias };
}
const ITEM_FULL = `SELECT i.*,l.saldo::text AS saldo,l.preco_unitario::text AS preco_unitario,l.origem_preco,
  CASE WHEN i.encerrado THEN (SELECT x.quantidade::text FROM inventario.contagem x WHERE x.item_id=i.id ORDER BY x.etapa DESC LIMIT 1) END AS quantidade_final,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'etapa',x.etapa,'quantidade',x.quantidade::text,'por',x.por,'em',x.em) ORDER BY x.etapa) FROM inventario.contagem x WHERE x.item_id=i.id),'[]') AS contagens,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',j.id,'texto',j.texto,'por',j.por,'em',j.em) ORDER BY j.em) FROM inventario.justificativa j WHERE j.item_id=i.id),'[]') AS justificativas
  FROM inventario.item i JOIN inventario.snapshot_linha l ON l.id=i.linha_id`;

router.use(requireAuth);
router.get('/usuarios', handle(async (req, res) => {
  manager(req);
  const rows = await transaction(req.user, async db => (await db.query('SELECT * FROM inventario.usuarios()')).rows);
  res.json({ ok: true, usuarios: rows.map(r => ({ id: r.id, nome: r.nome, perfilId: r.perfil_id })) });
}));
router.get('/snapshots', handle(async (req, res) => {
  manager(req);
  const rows = await transaction(req.user, async db => (await db.query(`SELECT s.*, jsonb_array_length(s.pendencias) AS qtd_pendencias,
    (SELECT count(*)::int FROM inventario.snapshot_linha l WHERE l.snapshot_id=s.id) AS linhas FROM inventario.snapshot s ORDER BY criado_em DESC LIMIT 200`)).rows);
  res.json({ ok: true, snapshots: rows.map(snapshotRow) });
}));
router.post('/snapshots', handle(async (req, res) => {
  manager(req); const b = req.body || {};
  const hash = String(b.arquivoHash || '').toLowerCase();
  if (hash && !/^[0-9a-f]{64}$/.test(hash)) throw fail(400, 'Hash do arquivo inválido.');
  const resumo = jsonObject(b.resumo);
  res.status(201).json({ ok: true, snapshot: await execute(req, 'snapshot', { nome: text(b.nome, 160, true), dataReferencia: date(b.dataReferencia),
    dataExportacao: date(b.dataExportacao, false), fonte: text(b.fonte, 500), arquivoHash: hash, pendencias: normalizePending(b.pendencias), resumo }) });
}));
router.post('/snapshots/:id/linhas', handle(async (req, res) => {
  manager(req); const lines = req.body?.linhas;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 2000) throw fail(400, 'Envie entre 1 e 2000 linhas por parte.');
  res.status(201).json({ ok: true, ...await execute(req, 'importar', { id: id(req.params.id), linhas: lines.map(normalizeLine) }) });
}));
router.post('/snapshots/:id/finalizar', handle(async (req, res) => {
  manager(req); res.json({ ok: true, snapshot: await execute(req, 'finalizar', { id: id(req.params.id) }) });
}));
router.post('/snapshots/:id/descartar', handle(async (req, res) => {
  manager(req); res.json({ ok: true, ...await execute(req, 'descartar', { id: id(req.params.id) }) });
}));
router.get('/snapshots/:id/linhas', handle(async (req, res) => {
  manager(req); const snapshotId = id(req.params.id);
  const rows = await transaction(req.user, async db => (await db.query('SELECT *,saldo::text AS saldo,preco_unitario::text AS preco_unitario FROM inventario.snapshot_linha WHERE snapshot_id=$1 ORDER BY codigo,site,deposito,localizacao,id', [snapshotId])).rows);
  res.json({ ok: true, linhas: rows.map(snapshotLine) });
}));
router.get('/snapshots/:id/pendencias', handle(async (req, res) => {
  manager(req); const snapshotId = id(req.params.id);
  const row = await transaction(req.user, async db => (await db.query('SELECT pendencias FROM inventario.snapshot WHERE id=$1', [snapshotId])).rows[0]);
  if (!row) throw fail(404, 'Base não encontrada.');
  res.json({ ok: true, pendencias: row.pendencias });
}));
// Prévia da importação: quais códigos ainda não estão no catálogo de itens ("SEM CADASTRO" vira pendência).
router.post('/codigos', handle(async (req, res) => {
  manager(req); const list = req.body?.codigos;
  if (!Array.isArray(list) || list.length > 40000) throw fail(400, 'Envie até 40000 códigos.');
  const codes = [...new Set(list.map(c => String(c || '').trim().toUpperCase()).filter(c => c && c.length <= 40))];
  const found = await transaction(req.user, async db => (await db.query('SELECT codigo FROM almox.material WHERE codigo = ANY($1::text[])', [codes])).rows.map(r => r.codigo));
  const have = new Set(found);
  res.json({ ok: true, faltando: codes.filter(c => !have.has(c)) });
}));
function listsFrom(b) {
  if (Array.isArray(b.listas)) {
    if (!b.listas.length || b.listas.length > 200) throw fail(400, 'Informe de 1 a 200 listas.');
    let total = 0;
    const listas = b.listas.map(l => {
      if (!l || !Array.isArray(l.linhaIds) || !l.linhaIds.length) throw fail(400, 'Cada lista precisa de posições.');
      total += l.linhaIds.length;
      return { camm: text(l.camm, 80), linhaIds: l.linhaIds.map(id), contador1Id: id(l.contador1Id), contador2Id: id(l.contador2Id), contador3Id: id(l.contador3Id) };
    });
    if (total > 20000) throw fail(400, 'Selecione até 20000 posições.');
    return listas;
  }
  if (!Array.isArray(b.linhaIds) || !b.linhaIds.length || b.linhaIds.length > 20000) throw fail(400, 'Selecione de 1 a 20000 linhas.');
  return [{ camm: '', linhaIds: b.linhaIds.map(id), contador1Id: id(b.contador1Id), contador2Id: id(b.contador2Id), contador3Id: id(b.contador3Id) }];
}
router.post('/campanhas', handle(async (req, res) => {
  manager(req); const b = req.body || {};
  res.status(201).json({ ok: true, campanha: await execute(req, 'campanha', { nome: text(b.nome, 160, true), snapshotId: id(b.snapshotId),
    observacoes: text(b.observacoes, 2000), listas: listsFrom(b) }) });
}));
router.get('/campanhas', handle(async (req, res) => {
  const rows = await transaction(req.user, async db => (await db.query(`SELECT c.*, inventario.contador_em(c.id) AS sou_contador,
    (SELECT count(*)::int FROM inventario.item i WHERE i.campanha_id=c.id) AS itens,
    (SELECT count(*)::int FROM inventario.item i WHERE i.campanha_id=c.id AND i.encerrado) AS encerrados,
    (SELECT count(DISTINCT i.camm)::int FROM inventario.item i WHERE i.campanha_id=c.id) AS listas,
    (SELECT count(*)::int FROM inventario.item i WHERE i.campanha_id=c.id AND NOT i.encerrado
       AND app.usuario_atual() = CASE i.etapa WHEN 1 THEN i.contador1_id WHEN 2 THEN i.contador2_id ELSE i.contador3_id END) AS minhas
    FROM inventario.campanha c ORDER BY c.criado_em DESC LIMIT 200`)).rows);
  res.json({ ok: true, campanhas: rows });
}));
// Visão completa (saldo, contagens, custo) só para a gestão que não conta nesse inventário aberto.
async function fullView(db, user, campanha) {
  if (!MANAGERS.has(user.perfilId)) return false;
  if (campanha.estado !== 'aberta') return true;
  return !(await db.query('SELECT inventario.contador_em($1) AS c', [campanha.id])).rows[0].c;
}
async function items(req) {
  const campaignId = id(req.params.id);
  return transaction(req.user, async db => {
    const c = (await db.query('SELECT * FROM inventario.campanha WHERE id=$1', [campaignId])).rows[0];
    if (!c) throw fail(404, 'Inventário não encontrado.');
    const full = await fullView(db, req.user, c);
    const rows = (await db.query(full ? `${ITEM_FULL} WHERE i.campanha_id=$1 ORDER BY i.camm,i.localizacao,i.codigo,i.id`
      : 'SELECT * FROM inventario.item WHERE campanha_id=$1 ORDER BY camm,localizacao,codigo,id', [campaignId])).rows;
    return { campanha: c, completo: full, itens: rows.map(r => exposeItem(r, req.user, full)) };
  });
}
router.get('/campanhas/:id/itens', handle(async (req, res) => res.json({ ok: true, ...await items(req) })));
router.post('/itens/:id/contagens', handle(async (req, res) => {
  const expected = req.body?.expectedVersion;
  if (!Number.isSafeInteger(expected) || expected < 1) throw fail(400, 'Informe a versão atual do item.');
  const row = await execute(req, 'contar', { id: id(req.params.id), quantidade: amount(req.body?.quantidade, false), expectedVersion: expected });
  res.status(201).json({ ok: true, item: row });
}));
// Várias contagens de uma vez (colar do Excel / planilha preenchida). Cada uma na sua transação, com as mesmas
// regras da contagem avulsa: o que falhar (versão, etapa, quantidade) volta com o motivo e o resto fica gravado.
router.post('/contagens', handle(async (req, res) => {
  const list = req.body?.contagens;
  if (!Array.isArray(list) || !list.length || list.length > 500) throw fail(400, 'Envie de 1 a 500 contagens.');
  const vistos = new Set(), resultados = [];
  for (const c of list) {
    let itemId = null;
    try {
      itemId = id(c?.id);
      if (vistos.has(itemId)) throw fail(400, 'Posição repetida no envio.');
      vistos.add(itemId);
      if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1) throw fail(400, 'Informe a versão atual do item.');
      const item = await execute(req, 'contar', { id: itemId, quantidade: amount(c.quantidade, false), expectedVersion: c.expectedVersion });
      resultados.push({ id: itemId, ok: true, item });
    } catch (e) {
      if (!e.status && !['42501', 'P0001', 'P0002', '22023', '22P02', '23505'].includes(e.code)) throw e;
      resultados.push({ id: itemId, ok: false, erro: String(e.message || 'Falha').split('\n')[0] });
    }
  }
  res.status(201).json({ ok: true, gravadas: resultados.filter(r => r.ok).length, resultados });
}));
// Justificar divergência e aprovar são decisões da gestão: pedem 2FA recente (contar não pede).
router.post('/itens/:id/justificativas', requireStepUpAdmin(MANAGERS), handle(async (req, res) => {
  manager(req);
  res.status(201).json({ ok: true, ...await execute(req, 'justificar', { id: id(req.params.id), texto: text(req.body?.texto, 1000, true) }) });
}));
router.post('/campanhas/:id/fechar', requireStepUpAdmin(APPROVERS), handle(async (req, res) => {
  if (!APPROVERS.has(req.user.perfilId)) throw fail(403, 'A aprovação do inventário é da gestão.');
  res.json({ ok: true, campanha: await execute(req, 'fechar', { id: id(req.params.id), observacao: text(req.body?.observacao, 2000) }) });
}));
async function names(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  return Object.fromEntries((await db.query('SELECT * FROM inventario.nomes($1::uuid[])', [list])).rows.map(r => [r.id, r.nome]));
}
router.get('/campanhas/:id/relatorio', handle(async (req, res) => {
  manager(req); const out = await items(req);
  if (!out.completo) throw fail(403, 'Você conta neste inventário: o acompanhamento abre quando ele for aprovado.');
  const extra = await transaction(req.user, async db => {
    const snapshot = (await db.query('SELECT id,nome,data_referencia,data_exportacao,fonte,estado,criado_em,finalizado_em,resumo,jsonb_array_length(pendencias) AS pendencias FROM inventario.snapshot WHERE id=$1', [out.campanha.snapshot_id])).rows[0];
    const ids = [out.campanha.criado_por, out.campanha.fechado_por];
    for (const i of out.itens) { ids.push(i.contador1Id, i.contador2Id, i.contador3Id); for (const x of i.contagens) ids.push(x.por); for (const j of i.justificativas) ids.push(j.por); }
    return { snapshot, pessoas: await names(db, ids) };
  });
  res.json({ ok: true, campanha: out.campanha, snapshot: extra.snapshot, pessoas: extra.pessoas, relatorio: report(out.itens) });
}));
// Base para o Power BI: uma linha por posição de cada inventário (mais as contagens), para a gestão.
// Inventários abertos em que a pessoa conta ficam de fora (contagem cega).
router.get('/bi', handle(async (req, res) => {
  manager(req);
  const data = await transaction(req.user, async db => {
    const campanhas = (await db.query(`SELECT c.*, s.nome AS base_nome, s.data_referencia, s.data_exportacao, s.fonte FROM inventario.campanha c
      JOIN inventario.snapshot s ON s.id=c.snapshot_id WHERE c.estado<>'aberta' OR NOT inventario.contador_em(c.id) ORDER BY c.criado_em`)).rows;
    const ids = campanhas.map(c => c.id);
    const itens = ids.length ? (await db.query(`${ITEM_FULL} WHERE i.campanha_id = ANY($1::uuid[]) ORDER BY i.campanha_id,i.camm,i.localizacao,i.codigo`, [ids])).rows : [];
    const pessoaIds = campanhas.flatMap(c => [c.criado_por, c.fechado_por]);
    for (const i of itens) for (const x of i.contagens || []) pessoaIds.push(x.por);
    return { campanhas, itens, pessoas: await names(db, pessoaIds) };
  });
  const porCampanha = new Map(data.campanhas.map(c => [c.id, []]));
  for (const r of data.itens) porCampanha.get(r.campanha_id).push(exposeItem(r, req.user, true));
  const out = biDataset(data.campanhas.map(c => ({ campanha: c, itens: porCampanha.get(c.id) })), data.pessoas);
  res.json({ ok: true, geradoEm: new Date().toISOString(), ...out });
}));
module.exports = router;
module.exports._test = { normalizeLine, exposeItem, normalizePending };
