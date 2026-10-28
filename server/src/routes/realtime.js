const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { buildReadScope } = require('./read-scope');
const { exposeRecord } = require('./record-security');
const { abrirLinhas } = require('../crypto/registros');
const { registrarEvento } = require('../seguranca/eventos');
const hub = require('../realtime/hub');

/*
 * Tempo real: UMA conexão SSE por pessoa para todos os módulos (?namespaces=sci,scm,...).
 * O PostgreSQL avisa quando um módulo muda (hub.js / migration 23) e só então esta conexão busca as linhas
 * novas — com o RLS e o escopo de leitura da pessoa, decifradas como em /api/data. Sem aviso do banco,
 * confere a cada 4 s; com aviso, ainda confere a cada 30 s por garantia.
 */
const router = express.Router();
const ALLOWED = new Set(['sci', 'scm', 'utility_meters', 'utility_readings', 'groups', 'families', 'cost_centers', 'lms_courses', 'lms_progress']);

function cursorFor(row) {
  return { at: String(row.cursor_at || new Date(row.updated_at).toISOString()), namespace: row.namespace, recordId: row.record_id };
}
function encodeCursor(cursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function readCursor(value, since) {
  try {
    if (typeof value === 'string' && value.length <= 1200) {
      const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (typeof c.at === 'string' && c.at.length <= 80 && Number.isFinite(Date.parse(c.at)) &&
        ALLOWED.has(c.namespace) && typeof c.recordId === 'string' && c.recordId.length <= 300) return c;
    }
  } catch (_) {}
  const date = new Date(since || Date.now());
  return { at: Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(), namespace: null, recordId: null };
}
function pageQuery(user, lista, cursor) {
  const esc = escopoMulti(user, lista, 2), args = [cursor.at, ...esc.params];
  // Clientes antigos recriam EventSource apenas com since (milissegundos).
  // Reenvie a fronteira nessa primeira página; os ids tornam a aplicação idempotente.
  let after = 'updated_at >= $1';
  if (cursor.namespace !== null) {
    args.push(cursor.namespace, cursor.recordId);
    after = `(updated_at > $1 OR (updated_at = $1 AND (namespace, record_id) > ($${args.length - 1}, $${args.length})))`;
  }
  return { sql: `SELECT *, updated_at::text AS cursor_at FROM app.sync_registro WHERE ${after} AND (${esc.sql}) ORDER BY updated_at, namespace, record_id LIMIT 500`, args };
}

/** WHERE para vários módulos de uma vez, cada um com o seu escopo de leitura. */
function escopoMulti(user, lista, primeiro) {
  const partes = [], params = [];
  let n = primeiro;
  for (const ns of lista) {
    const s = buildReadScope(user, ns, n + 1);
    params.push(ns, ...s.params);
    partes.push(`(namespace=$${n}${s.sql})`);
    n += 1 + s.params.length;
  }
  return { sql: partes.join(' OR '), params };
}

// Teto de conexões: cada uma consulta o banco periodicamente; sem teto, uma sessão abrindo dezenas de abas
// (ou um script) esgotaria o pool. 4 por pessoa cobre abas + celular; 500 no total.
const MAX_POR_PESSOA = 4, MAX_TOTAL = 500;
const abertasPorPessoa = new Map();
let abertasTotal = 0;

router.get('/', requireAuth, async (req, res) => {
  let fechado = false;
  const quem = String(req.user.id), minhas = abertasPorPessoa.get(quem) || 0;
  if (minhas >= MAX_POR_PESSOA || abertasTotal >= MAX_TOTAL) {
    res.set('Retry-After', '30');
    return res.status(429).json({ ok: false, erro: 'Muitas conexões de tempo real abertas. Feche abas repetidas do sistema.' });
  }
  const pedidos = String(req.query.namespaces || req.query.namespace || '').split(',').map(x => x.trim()).filter(Boolean);
  const lista = [...new Set(pedidos)].filter(ns => ALLOWED.has(ns));
  if (!lista.length || lista.length !== new Set(pedidos).size) return res.status(400).json({ ok: false, erro: 'Módulo inválido.' });

  // no-transform: a compressão (gzip) do app segurava os eventos num buffer e eles não chegavam na hora
  abertasPorPessoa.set(quem, minhas + 1); abertasTotal++;
  let contada = true;
  const soltar = () => { if (!contada) return; contada = false; abertasTotal--; const n = (abertasPorPessoa.get(quem) || 1) - 1; if (n > 0) abertasPorPessoa.set(quem, n); else abertasPorPessoa.delete(quem); };
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const enviar = texto => { if (fechado) return; res.write(texto); if (typeof res.flush === 'function') res.flush(); };
  let last = readCursor(req.get('last-event-id'), req.query.since);
  let buscando = false, denovo = false, timer = null;

  const buscar = async () => {
    if (fechado) return;
    if (buscando) { denovo = true; return; }
    buscando = true;
    try {
      const page = pageQuery(req.user, lista, last);
      const rows = await transaction(req.user, db => db.query(page.sql, page.args).then(r => r.rows));
      const abertas = await abrirLinhas(rows, (row, e) => registrarEvento('cifra.registro_ilegivel', req.user, { namespace: row.namespace, codigo: e?.codigo || 'erro' }));
      for (const row of abertas) {
        if (fechado) break;
        const safe = exposeRecord(row, req.user);
        enviar(`id: ${encodeCursor(cursorFor(row))}\nevent: change\ndata: ${JSON.stringify({ namespace: row.namespace, recordId: safe.recordId, payload: safe.payload, deleted: safe.deleted, version: safe.version, updatedAt: safe.updatedAt })}\n\n`);
      }
      if (rows.length) last = cursorFor(rows[rows.length - 1]);
      if (rows.length === 500) denovo = true;   // muita coisa de uma vez: continua
    } catch {
      enviar('event: warning\ndata: {"erro":"reconectando"}\n\n');
    } finally {
      buscando = false;
      if (denovo && !fechado) { denovo = false; setImmediate(buscar); }
    }
  };
  // aviso do banco → junta avisos de 150 ms numa busca só
  const aoMudar = ns => { if (lista.includes(ns) && !timer) timer = setTimeout(() => { timer = null; buscar(); }, 150); };
  hub.avisos.on('mudou', aoMudar);
  hub.iniciar();
  let ciclo = 0;
  const relogio = setInterval(() => {
    ciclo++;
    // sem LISTEN: confere a cada 4 s; com LISTEN: a cada 30 s por garantia
    if (!hub.escutando() || ciclo % 8 === 0) buscar();
    if (ciclo % 6 === 0) enviar(`event: heartbeat\ndata: {"at":"${new Date().toISOString()}"}\n\n`);
  }, 4000);
  req.on('close', () => { fechado = true; soltar(); clearInterval(relogio); clearTimeout(timer); hub.avisos.off('mudou', aoMudar); });

  enviar(`event: ready\ndata: ${JSON.stringify({ namespaces: lista, modo: hub.escutando() ? 'aviso-do-banco' : 'conferencia' })}\n\n`);
  if (req.query.since || req.get('last-event-id')) buscar();   // recupera o que perdeu enquanto estava desconectado
});

module.exports = router;
module.exports._test = { escopoMulti, cursorFor, encodeCursor, readCursor, pageQuery };
