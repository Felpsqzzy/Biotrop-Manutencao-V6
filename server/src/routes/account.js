const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { cifrarPessoal, abrirPessoal } = require('../crypto/pessoais');

// Foto e telefone ficam cifrados no banco (envelope + AAD do próprio usuário); abrem só nesta rota.
async function abrirPerfil(userId, p) {
  if (!p) return {};
  return { ...p, foto: (await abrirPessoal(userId, 'foto', p.foto)) || null, telefone: await abrirPessoal(userId, 'telefone', p.telefone) };
}

// Minha conta: a própria pessoa lê e altera foto, telefone, tema, notificações e
// preferências. Perfil de acesso, grupo e e-mail não passam por aqui.
const router = express.Router();
const { validate } = require('./account-rules');
const { requireStepUp } = require('./twofa');

// Trocar o telefone (meio de contato) pede a verificação em duas etapas, quando ativa.
function stepUpForContact(req, res, next) {
  return req.body && req.body.telefone !== undefined ? requireStepUp(req, res, next) : next();
}

router.use(requireAuth);

router.get('/perfil', async (req, res, next) => {
  try {
    const perfil = await transaction(req.user, async db => (await db.query('SELECT app.meu_perfil() AS p')).rows[0]?.p);
    res.set('Cache-Control', 'no-store').json({ ok: true, perfil: await abrirPerfil(req.user.id, perfil) });
  } catch (error) { next(error); }
});

router.patch('/perfil', stepUpForContact, async (req, res, next) => {
  const { errors, values } = validate(req.body || {});
  if (errors.length) return res.status(400).json({ ok: false, erro: errors.join(' ') });
  try {
    const gravar = [...values];
    gravar[0] = await cifrarPessoal(req.user.id, 'foto', values[0]);       // p_foto
    gravar[2] = await cifrarPessoal(req.user.id, 'telefone', values[2]);   // p_telefone ('' limpa)
    const perfil = await transaction(req.user, async db => (await db.query(
      'SELECT app.atualizar_meu_perfil($1,$2,$3,$4,$5,$6::jsonb) AS p', gravar)).rows[0]?.p);
    res.set('Cache-Control', 'no-store').json({ ok: true, perfil: await abrirPerfil(req.user.id, perfil) });
  } catch (error) { next(error); }
});

module.exports = router;
