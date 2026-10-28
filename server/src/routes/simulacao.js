const express = require('express');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const { simulacao, PERFIS, ROTULO, LIMITES, equipeReal } = require('../simulacao/motor');
const { registrarEvento } = require('../seguranca/eventos');
const { requireStepUpAdmin } = require('./twofa');

/*
 * Modo de teste (simulação de vários usuários ao mesmo tempo) — SÓ ADMIN.
 * Em produção fica desligado até alguém decidir ligar (SIMULACAO_PERMITIDA=1): a simulação grava registros
 * de teste (isolados, só o admin vê) e aumenta a carga do servidor e do banco enquanto roda.
 */
const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.user.perfilId !== 'admin') return res.status(403).json({ ok: false, erro: 'O modo de teste é exclusivo do administrador.' });
  next();
});
const permitido = () => !config.production || process.env.SIMULACAO_PERMITIDA === '1';
function falhou(res, e) { return res.status(e.status || 500).json({ ok: false, erro: e.message || 'Falha no modo de teste.' }); }

router.get('/estado', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json({ ok: true, permitido: permitido(), perfis: PERFIS.map(id => ({ id, rotulo: ROTULO[id] })), limites: LIMITES,
      equipeReal: await equipeReal(req.user).catch(() => ({})), ...simulacao.resumo(true) });
  } catch (e) { falhou(res, e); }
});

// Iniciar e limpar pedem 2FA recente; parar não: é o freio de emergência e não grava nada.
const stepUp = requireStepUpAdmin(new Set(['admin']));
router.post('/iniciar', stepUp, async (req, res) => {
  if (!permitido()) return res.status(403).json({ ok: false, erro: 'Modo de teste desligado neste servidor (produção). Para ligar, defina SIMULACAO_PERMITIDA=1 e reinicie.' });
  try {
    const base = `http://127.0.0.1:${req.socket.localPort}`;
    const r = await simulacao.iniciar(req.user, base, req.body || {});
    registrarEvento('simulacao.iniciada', req.user, { usuarios: r.config?.total, minutos: r.config?.minutos, ritmo: r.config?.ritmo, rede: r.config?.rede });
    res.json({ ok: true, ...r });
  } catch (e) { falhou(res, e); }
});

router.post('/parar', (req, res) => { simulacao.parar(); res.json({ ok: true, ...simulacao.resumo(false) }); });

router.post('/limpar', stepUp, async (req, res) => {
  try {
    const r = await simulacao.limpar(req.user);
    registrarEvento('simulacao.limpa', req.user, r);
    res.json({ ok: true, ...r });
  } catch (e) { falhou(res, e); }
});

module.exports = router;
