'use strict';
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const WORKER_LOCK = 981001;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

class GraphError extends Error {
  constructor(message, { retryable = false, retryAfterMs = null, deliveryUnknown = false } = {}) {
    super(message); this.name = 'GraphError'; this.retryable = retryable;
    this.retryAfterMs = retryAfterMs; this.deliveryUnknown = deliveryUnknown;
  }
}
function required(env, name) { const value = String(env[name] || '').trim(); if (!value) throw new Error(`Variável obrigatória ausente: ${name}`); return value; }
function integer(value, fallback, min, max, name) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}`);
  return parsed;
}
function loadConfig(env = process.env) {
  const sender = required(env, 'EMAIL_REMETENTE').toLowerCase();
  if (!EMAIL_PATTERN.test(sender)) throw new Error('EMAIL_REMETENTE inválido');
  const tenantId = required(env, 'GRAPH_TENANT_ID'); const clientId = required(env, 'GRAPH_CLIENT_ID');
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('GRAPH_TENANT_ID e GRAPH_CLIENT_ID devem ser UUIDs válidos');
  const motives = new Set(required(env, 'EMAIL_MOTIVOS_ATIVOS').split(',').map(v => v.trim()).filter(Boolean));
  return Object.freeze({ databaseUrl: required(env, 'DATABASE_WORKER_URL'), databaseSsl: String(env.DATABASE_SSL || '').toLowerCase() === 'true', databaseSslCa: String(env.DATABASE_SSL_CA || ''), tenantId, clientId, clientSecret: required(env, 'GRAPH_CLIENT_SECRET'), sender, motives, dryRun: env.EMAIL_DRY_RUN === '1', interval: integer(env.EMAIL_INTERVALO_MS, 60000, 5000, 3600000, 'EMAIL_INTERVALO_MS'), batch: integer(env.EMAIL_LOTE, 20, 1, 100, 'EMAIL_LOTE'), maxAttempts: integer(env.EMAIL_TENTATIVAS_MAX, 5, 1, 10, 'EMAIL_TENTATIVAS_MAX'), requestTimeout: integer(env.EMAIL_TIMEOUT_MS, 15000, 1000, 60000, 'EMAIL_TIMEOUT_MS') });
}
function databaseOptions(cfg) {
  if (cfg.databaseSsl && !cfg.databaseSslCa.trim()) throw new Error('DATABASE_SSL_CA é obrigatório quando DATABASE_SSL=true');
  // Certificado em uma linha no .env ("\n" literal) vira PEM de várias linhas, como no pool.js.
  return { connectionString: cfg.databaseUrl, application_name: 'biotrop-email-worker', ssl: cfg.databaseSsl ? { ca: cfg.databaseSslCa.replace(/\\n/g, '\n'), rejectUnauthorized: true, minVersion: 'TLSv1.2' } : undefined };
}
function validEmail(value) { const email = String(value || '').trim().toLowerCase(); if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new Error('Endereço de e-mail inválido'); return email; }
function validateRow(row, cfg) {
  const sender = validEmail(row.remetente || cfg.sender); if (sender !== cfg.sender) throw new Error('Remetente da fila não é o remetente autorizado');
  const subject = String(row.assunto || '').trim(); const html = String(row.corpo_html || '');
  if (!subject || subject.length > 255) throw new Error('Assunto ausente ou maior que 255 caracteres');
  if (!html || Buffer.byteLength(html, 'utf8') > 3000000) throw new Error('Corpo HTML ausente ou maior que 3 MB');
  const to = validEmail(row.destinatario);
  // Endereço em cópia que não passa na validação é deixado de fora: a cópia nunca impede a mensagem principal.
  const cc = Array.isArray(row.copia) ? [...new Set(row.copia.map(v => { try { return validEmail(v); } catch { return null; } }))].filter(v => v && v !== to) : [];
  if (cc.length > 50) throw new Error('Quantidade de destinatários em cópia excede 50');
  return { sender, to, cc, subject, html };
}
function retryAfter(response) {
  const raw = response.headers.get('retry-after'); if (!raw) return null; const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60000); const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60000)) : null;
}
function createGraphClient(cfg, fetchImpl = globalThis.fetch) {
  let cachedToken = null;
  async function request(url, options) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), cfg.requestTimeout); timer.unref?.(); try { return await fetchImpl(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); } }
  async function token(force = false) {
    if (!force && cachedToken?.expiresAt > Date.now() + 60000) return cachedToken.value;
    const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: `${GRAPH_ORIGIN}/.default`, grant_type: 'client_credentials' }); let response;
    try { response = await request(`${LOGIN_ORIGIN}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
    catch (error) { throw new GraphError(`Falha de rede ao obter token: ${error.name}`, { retryable: true }); }
    if (!response.ok) throw new GraphError(`Token Graph recusado (${response.status})`, { retryable: response.status === 429 || response.status >= 500, retryAfterMs: retryAfter(response) });
    const data = await response.json(); if (!data.access_token) throw new GraphError('Resposta de token sem access_token');
    cachedToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 }; return cachedToken.value;
  }
  async function send(row, clientRequestId, refreshed = false) {
    const message = validateRow(row, cfg); let response;
    try { response = await request(`${GRAPH_ORIGIN}/v1.0/users/${encodeURIComponent(message.sender)}/sendMail`, { method: 'POST', headers: { Authorization: `Bearer ${await token(refreshed)}`, 'Content-Type': 'application/json', 'client-request-id': clientRequestId, 'return-client-request-id': 'true' }, body: JSON.stringify({ message: { subject: message.subject, body: { contentType: 'HTML', content: message.html }, toRecipients: [{ emailAddress: { address: message.to } }], ccRecipients: message.cc.map(address => ({ emailAddress: { address } })) }, saveToSentItems: true }) }); }
    catch (error) { if (error instanceof GraphError) throw error; throw new GraphError(`Resultado do envio desconhecido: ${error.name}`, { deliveryUnknown: true }); }
    if (response.status === 202) return { clientRequestId, requestId: response.headers.get('request-id') };
    if (response.status === 401 && !refreshed) { cachedToken = null; return send(row, clientRequestId, true); }
    await response.arrayBuffer();
    throw new GraphError(`Graph HTTP ${response.status}`, { retryable: response.status === 429 || [502, 503, 504].includes(response.status), retryAfterMs: retryAfter(response) });
  }
  return { send };
}
const SQL_CLAIM = `WITH alvo AS (SELECT id FROM core.email_fila WHERE status='pendente' ORDER BY criado_em LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE core.email_fila f SET status='enviando' FROM alvo WHERE f.id=alvo.id RETURNING f.id,f.destinatario::text,f.copia::text[] AS copia,f.remetente::text,f.assunto,f.corpo_html,f.motivo,f.tentativas`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function processBatch({ cfg, db, graph, sleepFn = sleep, uuid = randomUUID }) {
  const counts = { sent: 0, failed: 0, cancelled: 0 }; const lock = await db.query('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK]); if (!lock.rows[0]?.ok) return counts;
  try {
    if (cfg.dryRun) { const preview = await db.query(`SELECT id,destinatario::text,copia::text[] AS copia,remetente::text,assunto,corpo_html,motivo,tentativas FROM core.email_fila WHERE status='pendente' ORDER BY criado_em LIMIT $1`, [cfg.batch]); for (const row of preview.rows) validateRow(row, cfg); return { ...counts, previewed: preview.rowCount }; }
    await db.query(`UPDATE core.email_fila SET status='erro',erro='Processo interrompido durante envio; confira Itens Enviados antes de reenviar' WHERE status='enviando'`);
    for (let index = 0; index < cfg.batch; index += 1) {
      const claimed = await db.query(SQL_CLAIM); const row = claimed.rows[0]; if (!row) break;
      if (!cfg.motives.has(row.motivo)) { await db.query(`UPDATE core.email_fila SET status='cancelado',erro=$2 WHERE id=$1`, [row.id, 'Motivo não habilitado para envio']); counts.cancelled += 1; continue; }
      const clientRequestId = uuid(); let lastError;
      for (let attempt = Number(row.tentativas) + 1; attempt <= cfg.maxAttempts; attempt += 1) {
        try { const result = await graph.send(row, clientRequestId); await db.query(`UPDATE core.email_fila SET status='enviado',tentativas=$2,erro=NULL,enviado_em=now(),graph_message_id=$3 WHERE id=$1`, [row.id, attempt, `crid:${result.clientRequestId}${result.requestId ? ` rid:${result.requestId}` : ''}`]); counts.sent += 1; lastError = null; break; }
        catch (error) { lastError = error; if (!(error instanceof GraphError) || !error.retryable || error.deliveryUnknown || attempt >= cfg.maxAttempts) { await db.query(`UPDATE core.email_fila SET status='erro',tentativas=$2,erro=$3,graph_message_id=$4 WHERE id=$1`, [row.id, attempt, 'Falha no envio; consulte o código de correlação', `crid:${clientRequestId}`]); counts.failed += 1; break; } await sleepFn(error.retryAfterMs ?? Math.min(1000 * (2 ** (attempt - 1)), 30000)); }
      }
      if (lastError?.deliveryUnknown) console.error(`[EMAIL] ${row.id}: entrega incerta; revisão manual necessária`);
    }
    return counts;
  } finally { await db.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]).catch(() => {}); }
}
// Avisos que o próprio banco gera a cada ciclo (cobrança de treinamento, empréstimo do almoxarifado — migration 42). Cada
// função roda sozinha (autocommit): a falha de uma não impede a outra nem a entrega da fila; no log vai só o código do erro.
const ENFILEIRADORES = Object.freeze([['LMS', 'SELECT lms.enfileirar_cobrancas_treinamento()'], ['EMPRESTIMO', 'SELECT emprestimo.enfileirar_avisos()']]);
async function enfileirarAvisos(db, log = console.error) {
  for (const [nome, sql] of ENFILEIRADORES) await db.query(sql).catch(error => log(`[${nome}]`, error.code || 'WORKER_ERROR'));
}
async function ciclo({ cfg, db, graph, log = console.error, ...opcoes }) { await enfileirarAvisos(db, log); return processBatch({ cfg, db, graph, ...opcoes }); }
async function main(env = process.env) {
  const cfg = loadConfig(env); const graph = createGraphClient(cfg); let running = true;
  process.once('SIGTERM', () => { running = false; }); process.once('SIGINT', () => { running = false; });
  console.log(`Worker de e-mail BIOTROP iniciado${cfg.dryRun ? ' em modo de ensaio' : ''}.`);
  while (running) { const db = new Client(databaseOptions(cfg)); try { await db.connect(); const result = await ciclo({ cfg, db, graph }); if (result.sent || result.failed || result.cancelled || result.previewed) console.log('[EMAIL]', result); } catch (error) { console.error('[EMAIL]', error.code || 'WORKER_ERROR'); } finally { await db.end().catch(() => {}); } if (running) await sleep(cfg.interval); }
}
if (require.main === module) main().catch(error => { console.error('[EMAIL]', error.code || 'WORKER_ERROR'); process.exitCode = 1; });
module.exports = { GraphError, loadConfig, databaseOptions, validateRow, createGraphClient, processBatch, enfileirarAvisos, ciclo, ENFILEIRADORES, SQL_CLAIM };
