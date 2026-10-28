'use strict';
// Grava as bateladas apontadas no site na lista "Bateladas" do SharePoint (Inteligência de Dados), para os
// gráficos e a planilha que leem a lista continuarem funcionando sem o Forms. Roda na VM ao lado do worker de e-mail.
//
// Fila: pcm.batelada_sharepoint (migration 32) — cada dia cujo contador mudou. Para cada dia, o worker lê o contador
// em vigor de cada tanque (pcm.batelada_contadores_em) e grava UMA linha da lista: atualiza a do dia, se existir, ou
// cria. Colunas da lista: "Data" e uma por tanque ("PGD 01"…"PGD 15", "FTD 01"…"FTD 15", "BLR 02"…"BLR 05").
//
// Acesso: aplicativo do Entra com a permissão de aplicativo Sites.Selected e, no site InteligenciaDados, a concessão
// "write" para esse aplicativo (feita pela TI). Veja docs/SHAREPOINT-BATELADAS.md.
const { Client } = require('pg');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const LOCK = 981002;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function required(env, name) { const v = String(env[name] || '').trim(); if (!v) throw new Error(`Variável obrigatória ausente: ${name}`); return v; }
function loadConfig(env = process.env) {
  const tenantId = required(env, 'GRAPH_TENANT_ID'), clientId = required(env, 'GRAPH_CLIENT_ID');
  if (!GUID.test(tenantId) || !GUID.test(clientId)) throw new Error('GRAPH_TENANT_ID e GRAPH_CLIENT_ID devem ser UUIDs');
  const site = required(env, 'SHAREPOINT_SITE');           // ex.: bioaqua.sharepoint.com:/sites/InteligenciaDados
  if (!/^[a-z0-9.-]+\.sharepoint\.com:\/sites\/[A-Za-z0-9_-]+$/i.test(site)) throw new Error('SHAREPOINT_SITE no formato dominio.sharepoint.com:/sites/Nome');
  const lista = required(env, 'SHAREPOINT_LISTA_BATELADAS');
  if (!GUID.test(lista)) throw new Error('SHAREPOINT_LISTA_BATELADAS deve ser o id (GUID) da lista');
  return Object.freeze({
    tenantId, clientId, clientSecret: required(env, 'GRAPH_CLIENT_SECRET'), site, lista,
    databaseUrl: required(env, 'DATABASE_WORKER_URL'), databaseSsl: String(env.DATABASE_SSL || '').toLowerCase() === 'true',
    databaseSslCa: String(env.DATABASE_SSL_CA || ''), dryRun: env.SHAREPOINT_DRY_RUN === '1',
    interval: Math.max(30000, Number(env.SHAREPOINT_INTERVALO_MS) || 300000), batch: Math.min(60, Math.max(1, Number(env.SHAREPOINT_LOTE) || 20)),
    maxAttempts: Math.min(20, Math.max(1, Number(env.SHAREPOINT_TENTATIVAS_MAX) || 8))
  });
}

/** FTD01 → "FTD 01"; BLD02 → "BLR 02" (nome da coluna na lista). */
function colunaDoTanque(codigo) {
  const m = /^(FTD|PGD|BLD)(\d{2})$/.exec(String(codigo || ''));
  return m ? `${m[1] === 'BLD' ? 'BLR' : m[1]} ${m[2]}` : null;
}
/** Data gravada na lista (UTC) → dia em Brasília (UTC−3, sem horário de verão desde 2019). */
function diaBrasilia(valor) {
  const t = Date.parse(valor); if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 3600000).toISOString().slice(0, 10);
}
function somaDias(iso, n) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

class GraphError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

function createGraph(cfg, fetchImpl = globalThis.fetch) {
  let token = null, siteId = null, colunas = null;
  async function obterToken() {
    if (token && token.exp > Date.now() + 60000) return token.v;
    const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
    const r = await fetchImpl(`${LOGIN}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) throw new GraphError(`Token recusado (${r.status})`, r.status);
    const j = await r.json(); token = { v: j.access_token, exp: Date.now() + Number(j.expires_in || 3600) * 1000 }; return token.v;
  }
  async function chamar(method, url, body) {
    const r = await fetchImpl(url.startsWith('http') ? url : GRAPH + url, { method, headers: {
      Authorization: `Bearer ${await obterToken()}`, 'Content-Type': 'application/json', Accept: 'application/json',
      Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) token = null;
    if (!r.ok) throw new GraphError(`Graph ${r.status} em ${method}`, r.status);
    return r.status === 204 ? null : r.json();
  }
  async function site() { if (!siteId) siteId = (await chamar('GET', `/sites/${cfg.site}?$select=id`)).id; return siteId; }
  /** displayName → nome interno (ex.: "PGD 01" → "PGD_x0020_01"). */
  async function mapaColunas() {
    if (colunas) return colunas;
    const j = await chamar('GET', `/sites/${await site()}/lists/${cfg.lista}/columns?$select=name,displayName`);
    colunas = new Map((j.value || []).map(c => [String(c.displayName).trim(), c.name]));
    if (!colunas.has('Data')) throw new GraphError('A lista não tem a coluna "Data".', 0);
    return colunas;
  }
  async function itemDoDia(dia) {
    const col = (await mapaColunas()).get('Data');
    const filtro = `fields/${col} ge '${somaDias(dia, -1)}T00:00:00Z' and fields/${col} le '${somaDias(dia, 1)}T23:59:59Z'`;
    const j = await chamar('GET', `/sites/${await site()}/lists/${cfg.lista}/items?$expand=fields($select=${col})&$filter=${encodeURIComponent(filtro)}&$top=20`);
    const it = (j.value || []).find(x => diaBrasilia(x.fields && x.fields[col]) === dia);
    return it ? String(it.id) : null;
  }
  /** Grava o dia: atualiza o item (itemId ou o achado pela data) ou cria. Devolve o id do item. */
  async function gravarDia(dia, contadores, itemId) {
    const cols = await mapaColunas(), campos = {};
    for (const { codigo, acumulado } of contadores) { const nome = cols.get(colunaDoTanque(codigo)); if (nome) campos[nome] = Number(acumulado); }
    const id = itemId || await itemDoDia(dia);
    const base = `/sites/${await site()}/lists/${cfg.lista}/items`;
    if (id) {
      try { await chamar('PATCH', `${base}/${encodeURIComponent(id)}/fields`, campos); return id; }
      catch (e) { if (e.status !== 404) throw e; }      // item apagado na lista: cria de novo
    }
    campos[cols.get('Data')] = `${dia}T12:00:00Z`;
    return String((await chamar('POST', base, { fields: campos })).id);
  }
  return { gravarDia, itemDoDia, mapaColunas };
}

async function processar({ cfg, db, graph, log = console }) {
  const lock = await db.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
  if (!lock.rows[0]?.ok) return { enviados: 0, falhas: 0 };
  const out = { enviados: 0, falhas: 0 };
  try {
    const fila = (await db.query(`SELECT data::text AS data, item_id, tentativas, xmin::text AS revisao FROM pcm.batelada_sharepoint
      WHERE pendente AND tentativas < $1 ORDER BY data LIMIT $2`, [cfg.maxAttempts, cfg.batch])).rows;
    for (const f of fila) {
      const dia = String(f.data).slice(0, 10);
      const contadores = (await db.query('SELECT codigo, acumulado FROM pcm.batelada_contadores_em($1)', [dia])).rows;
      if (cfg.dryRun) { log.log(`[SHAREPOINT] ensaio ${dia}: ${contadores.length} tanques`); continue; }
      try {
        const id = await graph.gravarDia(dia, contadores, f.item_id);
        // A API pode reenfileirar o dia durante a chamada ao Graph. Preserve esse sinal;
        // xmin identifica a versão lida mesmo quando dois updates compartilham o mesmo now().
        await db.query(`UPDATE pcm.batelada_sharepoint SET pendente=(xmin::text <> $3), item_id=$2, erro=NULL, enviado_em=now(), atualizado_em=now() WHERE data=$1`, [dia, id, f.revisao]);
        out.enviados++;
      } catch (e) {
        const codigo = Number.isInteger(e.status) ? `Graph ${e.status}` : 'Falha ao sincronizar com SharePoint';
        await db.query(`UPDATE pcm.batelada_sharepoint SET tentativas=tentativas+1, erro=$2, atualizado_em=now() WHERE data=$1 AND xmin::text=$3`, [dia, codigo, f.revisao]);
        out.falhas++;
        if (e.status === 401 || e.status === 403) break;   // sem permissão: não adianta seguir o lote
      }
    }
  } finally { await db.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {}); }
  return out;
}

async function main(env = process.env) {
  const cfg = loadConfig(env), graph = createGraph(cfg);
  let ativo = true;
  process.once('SIGTERM', () => { ativo = false; }); process.once('SIGINT', () => { ativo = false; });
  console.log(`Worker do SharePoint (bateladas) iniciado${cfg.dryRun ? ' em modo de ensaio' : ''}.`);
  while (ativo) {
    const db = new Client({ connectionString: cfg.databaseUrl, application_name: 'biotrop-sharepoint-worker',
      ssl: cfg.databaseSsl ? { ca: cfg.databaseSslCa.replace(/\\n/g, '\n'), rejectUnauthorized: true, minVersion: 'TLSv1.2' } : undefined });
    try { await db.connect(); const r = await processar({ cfg, db, graph }); if (r.enviados || r.falhas) console.log('[SHAREPOINT]', r); }
    catch (e) { console.error('[SHAREPOINT]', e.code || e.name || 'erro'); }
    finally { await db.end().catch(() => {}); }
    if (ativo) await new Promise(r => setTimeout(r, cfg.interval));
  }
}
if (require.main === module) main().catch(e => { console.error('[SHAREPOINT]', e.code || e.name || 'erro'); process.exitCode = 1; });
module.exports = { loadConfig, colunaDoTanque, diaBrasilia, createGraph, processar };
