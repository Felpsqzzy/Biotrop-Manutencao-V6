'use strict';
// Avisos automáticos do empréstimo por e-mail (migration 42). Quem enfileira é o banco: o worker de e-mail chama
// emprestimo.enfileirar_avisos() a cada ciclo, sem ninguém com o site aberto. Aqui ficam só a configuração dos avisos
// (gestão lê; gravar é da gerência, por emprestimo.avisos_config_salvar(), que confere de novo no banco e audita) e o
// registro do que foi enfileirado. Lembrete e intervalo de atraso continuam no PUT /api/emprestimo/config (fase 3).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireStepUpAdmin } = require('./twofa');
const { _lib } = require('./emprestimo');

const { emTransacao, handle, fail } = _lib;   // mesma transação com canal e mesmos códigos de erro do painel
const router = express.Router();
const GESTAO = new Set(['admin', 'gestor', 'almoxarife']);
const GERENCIA = new Set(['admin', 'gestor']);
const OPCOES = ['avisosAtivos', 'avisoNoVencimento', 'avisoDevolucao'];

function gestao(req) { if (!GESTAO.has(req.user.perfilId)) throw fail(403, 'Somente almoxarifado, gestão e administração.'); }
function gerencia(req) { if (!GERENCIA.has(req.user.perfilId)) throw fail(403, 'Somente gestor e administrador.'); }
function configRow(c) {
  return { avisosAtivos: c.avisos_ativos, avisoNoVencimento: c.aviso_no_vencimento, escalarAposHoras: c.escalar_apos_horas, avisoDevolucao: c.aviso_devolucao,
    lembreteAntesHoras: c.lembrete_antes_horas, atrasoIntervaloHoras: c.atraso_intervalo_horas };
}
/** Só os quatro campos dos avisos, com o tipo conferido: nada de payload arbitrário chegando à função do banco. */
function entrada(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Dados inválidos.');
  const p = {};
  for (const k of OPCOES) {
    if (body[k] === undefined) continue;
    if (body[k] !== true && body[k] !== false && body[k] !== 'true' && body[k] !== 'false') throw fail(400, 'Use sim ou não nas opções de aviso.');
    p[k] = body[k] === true || body[k] === 'true';
  }
  if (body.escalarAposHoras !== undefined) {
    const v = body.escalarAposHoras;   // tipo antes de converter: Number({toString:1}) lança e virava 500
    const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v)) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 720) throw fail(400, 'Escalonamento: de 1 a 720 horas (número inteiro).');
    p.escalarAposHoras = n;
  }
  if (!Object.keys(p).length) throw fail(400, 'Nada para salvar.');
  return p;
}

router.use(requireAuth);

router.get('/config', handle(async (req, res) => {
  gestao(req);
  const c = await emTransacao(req.user, 'painel', async db => (await db.query('SELECT * FROM emprestimo.config WHERE id')).rows[0]);
  if (!c) throw fail(404, 'Configuração não encontrada.');
  res.json({ ok: true, config: configRow(c) });
}));
router.put('/config', requireStepUpAdmin(GERENCIA), handle(async (req, res) => {   // configuração dos avisos: ação administrativa, 2FA recente
  gerencia(req);
  const p = entrada(req.body);
  const config = await emTransacao(req.user, 'painel', async db => (await db.query('SELECT emprestimo.avisos_config_salvar($1::jsonb) AS r', [JSON.stringify(p)])).rows[0].r);
  res.json({ ok: true, config });
}));

// Avisos enviados (mais novos primeiro): situação na fila, sem assunto nem corpo do e-mail.
router.get('/', handle(async (req, res) => {
  gestao(req);
  const limite = Math.min(Math.max(Number.parseInt(typeof req.query.limite === 'string' ? req.query.limite : '', 10) || 200, 1), 500);
  const rows = await emTransacao(req.user, 'painel', async db => (await db.query('SELECT * FROM emprestimo.avisos_log($1)', [limite])).rows);
  res.json({ ok: true, rows: rows.map(r => ({ id: r.id, emprestimoId: r.emprestimo_id, emprestimoNumero: r.emprestimo_numero, tipo: r.tipo,
    destinatario: r.destinatario, copias: Number(r.copias || 0), status: r.status, tentativas: Number(r.tentativas || 0), criadoEm: r.criado_em,
    enviadoEm: r.enviado_em, observacao: r.observacao || '' })) });
}));

module.exports = router;
