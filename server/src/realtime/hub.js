'use strict';
/*
 * Central de avisos do tempo real: UMA conexão do servidor escuta o PostgreSQL (LISTEN biomanut_sync, ver
 * migration 23) e avisa as conexões SSE abertas de que um módulo mudou. Cada conexão então busca a mudança com o
 * RLS da própria pessoa. Se o LISTEN não estiver disponível (banco sem a migration, pooler em modo transação,
 * queda de rede), as conexões voltam a conferir sozinhas a cada poucos segundos — o tempo real não para.
 */
const { EventEmitter } = require('node:events');
const { pool } = require('../db/pool');

const CANAL = 'biomanut_sync';
const avisos = new EventEmitter();
avisos.setMaxListeners(0);
let cliente = null, conectando = false, ativo = false, tentativa = 0;

async function conectar() {
  if (cliente || conectando || typeof pool?.connect !== 'function') return;
  conectando = true;
  try {
    const c = await pool.connect();
    if (typeof c.on !== 'function') { c.release?.(); return; }   // ambiente de teste sem LISTEN: fica no modo de conferência
    c.on('notification', msg => { if (msg.channel === CANAL) avisos.emit('mudou', String(msg.payload || '')); });
    c.on('error', () => cair(c));
    c.on('end', () => cair(c));
    await c.query(`LISTEN ${CANAL}`);
    cliente = c; ativo = true; tentativa = 0;
  } catch (e) {
    ativo = false;
    console.warn('[REALTIME] LISTEN indisponível, usando conferência periódica:', e.code || e.message);
    setTimeout(conectar, Math.min(60000, 2000 * 2 ** tentativa++)).unref?.();
  } finally { conectando = false; }
}
function cair(c) {
  if (cliente !== c) return;
  cliente = null; ativo = false;
  try { c.release(true); } catch { /* já fechada */ }
  setTimeout(conectar, 2000).unref?.();
}

module.exports = {
  avisos,
  /** true quando o banco está avisando as mudanças (sem precisar consultar de tempos em tempos). */
  escutando: () => ativo,
  iniciar: conectar
};
