const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { applyQuizAttempt, exposeRecord } = require('./record-security');
const { protegerPayload, abrirLinha } = require('../crypto/registros');

const router = express.Router();
router.use(requireAuth);

function cleanAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 200) return null;
  const out = {};
  for (const [question, options] of entries) {
    if (!question || question.length > 200 || !Array.isArray(options) || !options.length || options.length > 20) return null;
    out[question] = options.map(String);
    if (out[question].some(option => !option || option.length > 200)) return null;
  }
  return out;
}

// Pessoas e grupos que a sessão acompanha (Acompanhamento da equipe). O escopo é decidido no banco (migration 29).
router.get('/equipe', async (req, res, next) => {
  try {
    const out = await transaction(req.user, async db => ({
      pessoas: (await db.query('SELECT id, nome, email, perfil_id, grupo_id FROM lms.equipe_visivel()')).rows
        .map(r => ({ id: r.id, nome: r.nome, email: r.email, usuario: r.email, perfilId: r.perfil_id, grupoId: r.grupo_id })),
      grupos: (await db.query('SELECT id, codigo, nome, responsavel_id, responsavel_nome FROM lms.grupos_visiveis()')).rows
        .map(r => ({ id: r.id, codigo: r.codigo, nome: r.nome, responsavelId: r.responsavel_id, responsavelNome: r.responsavel_nome || '' }))
    }));
    res.set('Cache-Control', 'no-store').json({ ok: true, ...out });
  } catch (error) { next(error); }
});

router.post('/quiz/submit', async (req, res, next) => {
  const courseId = String(req.body?.courseId || '').trim();
  const answers = cleanAnswers(req.body?.answers);
  if (!courseId || courseId.length > 200 || !answers) return res.status(400).json({ ok: false, erro: 'Curso ou respostas inválidos.' });
  try {
    const output = await transaction(req.user, async db => {
      const courseRow = (await db.query(
        `SELECT * FROM app.sync_registro WHERE namespace='lms_courses' AND record_id=$1 AND NOT deleted LIMIT 1`, [courseId]
      )).rows[0];
      if (!courseRow) throw Object.assign(new Error('Curso não encontrado.'), { status: 404 });
      const progressId = `${req.user.id}__${courseId}`;
      const progressRow = await abrirLinha((await db.query(
        `SELECT * FROM app.sync_registro WHERE namespace='lms_progress' AND record_id=$1
          AND payload->>'usuarioId'=$2 AND payload->>'course_id'=$3 AND NOT deleted FOR UPDATE`,
        [progressId, String(req.user.id), courseId]
      )).rows[0]);
      if (!progressRow) throw Object.assign(new Error('Progresso ainda não sincronizado. Aguarde um instante e tente novamente.'), { status: 409 });
      if (progressRow.payload?.completed_at) throw Object.assign(new Error('Este curso já foi concluído.'), { status: 409 });
      const graded = applyQuizAttempt(courseRow.payload, progressRow.payload, answers);
      graded.progress._ownerId = progressRow.payload?._ownerId || req.user.id;
      graded.progress._ownerEmail = progressRow.payload?._ownerEmail || req.user.email;
      graded.progress._groupId = progressRow.payload?._groupId || req.user.grupoId || null;
      const gravado = await protegerPayload('lms_progress', progressId, Number(progressRow.version) + 1, graded.progress);
      const updated = (await db.query(
        `UPDATE app.sync_registro SET payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now()
          WHERE namespace='lms_progress' AND record_id=$1 AND id=$2 AND version=$5 RETURNING *`,
        [progressId, progressRow.id, JSON.stringify(gravado), req.user.id, Number(progressRow.version)]
      )).rows[0];
      if (!updated) throw Object.assign(new Error('O progresso foi alterado ao mesmo tempo. Tente de novo.'), { status: 409 });
      return { result: graded.result, row: exposeRecord({ ...updated, payload: graded.progress }, req.user) };
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, ...output });
  } catch (error) {
    if ([400, 404, 409].includes(error.status)) return res.status(error.status).json({ ok: false, erro: error.message });
    next(error);
  }
});

module.exports = router;
module.exports._test = { cleanAnswers };
