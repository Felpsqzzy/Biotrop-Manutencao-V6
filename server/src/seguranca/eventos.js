'use strict';
// Trilha de eventos de segurança (seguranca.evento). Nunca recebe texto sensível, token, chave ou payload:
// só tipo, id do usuário e um detalhe curto (códigos, contagens, ids técnicos).
const { transaction } = require('../db/pool');

const PROIBIDO = /(senha|password|token|secret|segredo|cookie|authorization|bm1\.)/i;

function limparDetalhe(detalhe = {}) {
  const out = {};
  for (const [k, v] of Object.entries(detalhe || {})) {
    if (PROIBIDO.test(k)) continue;
    const s = typeof v === 'number' || typeof v === 'boolean' ? v : String(v ?? '').slice(0, 200);
    if (typeof s === 'string' && PROIBIDO.test(s)) continue;
    out[k] = s;
  }
  return out;
}

/** Registra em uma transação própria (ou na `db` informada). Falha de log não derruba a requisição. */
async function registrarEvento(tipo, usuario, detalhe, db) {
  const sql = 'INSERT INTO seguranca.evento(tipo, usuario_id, detalhe) VALUES($1,$2::uuid,$3::jsonb)';
  const params = [tipo, usuario?.id || null, JSON.stringify(limparDetalhe(detalhe))];
  try {
    if (db) await db.query(sql, params);
    else await transaction(usuario?.id ? usuario : null, q => q.query(sql, params));
  } catch (e) { console.error('[EVENTO]', tipo, e.code || e.name); }
}

module.exports = { registrarEvento, limparDetalhe };
