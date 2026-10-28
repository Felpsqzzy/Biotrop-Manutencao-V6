const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildReadScope } = require('../src/routes/read-scope');
const { canDeleteProgress, redactCourse, redactProgress, protectCourseWrite, protectRequestAttachments, protectProgressWrite, gradeQuiz, applyQuizAttempt } = require('../src/routes/record-security');

const tecnico = { id: 'user-1', nome: 'Técnico Teste', email: 'tecnico@example.test', perfilId: 'tecnico', grupoId: 'g1' };
const viewer = { ...tecnico, perfilId: 'viewer' };
const gestor = { ...tecnico, id: 'manager-1', perfilId: 'gestor' };
const course = {
  id: 'course-1', status: 'publicado', version: 2, validity_months: 12,
  sections: [{ lessons: [{ id: 'lesson-1', required: true }] }],
  quiz: { enabled: true, pass_score: 70, max_attempts: 2, questions: [
    { id: 'q1', statement: 'Questão', explanation: 'Explicação', weight: 1,
      options: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B', correct: false }] }
  ] }
};

test('realtime and regular reads share the same viewer and team scope', () => {
  const SEM_TESTE = " AND (payload->>'_simulacao' IS DISTINCT FROM 'true')";   // registros do modo de teste: só o admin vê
  assert.equal(buildReadScope(viewer, 'groups', 3).sql, ' AND false' + SEM_TESTE);
  assert.match(buildReadScope(viewer, 'scm', 3).sql, /solicitanteId/);
  const leader = buildReadScope({ ...tecnico, id: 'leader-1', perfilId: 'lider' }, 'scm', 3);
  assert.match(leader.sql, /\$3/);
  assert.match(leader.sql, /\$4/);
  assert.deepEqual(leader.params, ['g1', 'leader-1']);
  assert.match(buildReadScope(tecnico, 'lms_courses', 3).sql, /publicado/);
  assert.equal(buildReadScope(gestor, 'lms_courses', 3).sql, SEM_TESTE);
  assert.equal(buildReadScope({ ...gestor, perfilId: 'admin' }, 'sci', 3).sql, '', 'admin acompanha o modo de teste');
  assert.equal(buildReadScope({ ...tecnico, email: 'sim-tecnico-01@simulacao.biomanut.local' }, 'lms_courses', 3).sql, " AND payload->>'status'='publicado'", 'usuário virtual vê os próprios dados de teste');
});

test('course answer key is visible only to course managers', () => {
  const safe = redactCourse(course, tecnico);
  assert.equal('correct' in safe.quiz.questions[0].options[0], false);
  assert.equal('explanation' in safe.quiz.questions[0], false);
  assert.equal(redactCourse(course, gestor).quiz.questions[0].options[0].correct, true);
});

test('course writes are normalized and stored XSS payloads are rejected or neutralized', () => {
  const incoming = {
    id: 'course-1', title: 'Curso seguro', color: 'red" onmouseover="alert(1)', status: 'publicado', version: '2',
    cover: 'data:text/html;base64,PHNjcmlwdD4=', objectives: ['Objetivo'], audience: { groups: ['g1'], users: ['user-1'] },
    sections: [{ id: 'section-1', title: 'Módulo', lessons: [{ id: 'lesson-1', title: 'Aula', kind: 'link',
      url: 'javascript:alert(1)', media: 'data:text/html;base64,WA==', duration: '8', required: true,
      files: [{ name: 'Portal', url: 'https://example.test/material' }, { name: 'Ataque', url: 'javascript:alert(1)' }] }] }],
    quiz: { enabled: true, pass_score: '70" onmouseover="alert(1)', max_attempts: 3, questions: [{ id: 'q1',
      statement: 'Pergunta', options: [{ id: 'o1', label: 'Resposta', correct: true }] }] },
    unexpected: '<img src=x onerror=alert(1)>'
  };
  const safe = protectCourseWrite(incoming, 'course-1');
  assert.equal(safe.color, '#00634e');
  assert.equal(safe.cover, '');
  assert.equal(safe.sections[0].lessons[0].url, '');
  assert.equal(safe.sections[0].lessons[0].media, '');
  assert.deepEqual(safe.sections[0].lessons[0].files, [{ name: 'Portal', url: 'https://example.test/material' }]);
  assert.equal(safe.quiz.pass_score, 70);
  assert.equal('unexpected' in safe, false);
  assert.throws(() => protectCourseWrite({ ...incoming, id: 'other' }, 'course-1'), /não confere/);
});

test('request attachments accept only inert images and PDF data URLs', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const safe = protectRequestAttachments({ foto: png, anexos: [{ name: 'Foto', dataUrl: png }] });
  assert.equal(safe.foto, png);
  assert.equal(safe.anexos[0].dataUrl, png);
  assert.throws(() => protectRequestAttachments({ anexos: [{ name: 'HTML', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }] }), /Formato/);
  assert.throws(() => protectRequestAttachments({ foto: 'data:image/svg+xml;base64,PHN2Zz4=' }), /Formato/);
  assert.throws(() => protectRequestAttachments({ foto: 'data:image/png;base64,PGh0bWw+' }), /Formato/);
});

test('personal lesson notes never reach another user or a manager', () => {
  const progress = { usuarioId: tecnico.id, notes: { 'lesson-1': 'anotação privada' }, score: 80 };
  assert.deepEqual(redactProgress(progress, tecnico).notes, progress.notes);
  assert.equal('notes' in redactProgress(progress, gestor), false);
});

test('a learner cannot forge score, certificate, attempts, identity, or record id', () => {
  const current = { payload: { usuarioId: tecnico.id, course_id: course.id, attempts: [], completed_at: null,
    score: null, certificate_code: null, expires_at: null, extra_attempts: 0, history: [] } };
  const attack = { usuarioId: 'other', course_id: course.id, attempts: [{ passed: true }], completed_at: new Date().toISOString(),
    score: 100, certificate_code: 'FORGED', extra_attempts: 999, notes: { 'lesson-1': 'minha' } };
  const safe = protectProgressWrite(tecnico, current, attack, `${tecnico.id}__${course.id}`);
  assert.equal(safe.usuarioId, tecnico.id);
  assert.equal(safe.completed_at, null);
  assert.equal(safe.certificate_code, null);
  assert.equal(safe.extra_attempts, 0);
  assert.deepEqual(safe.attempts, []);
  assert.throws(() => protectProgressWrite(tecnico, current, attack, `other__${course.id}`), /Registro de progresso/);
});

test('managers can grant attempts but cannot manufacture certificates', () => {
  const current = { payload: { usuarioId: tecnico.id, course_id: course.id, attempts: [], completed_at: null,
    score: null, certificate_code: null, expires_at: null, extra_attempts: 0, history: [] } };
  const safe = protectProgressWrite(gestor, current, { ...current.payload, extra_attempts: 1,
    completed_at: new Date().toISOString(), score: 100, certificate_code: 'FORGED' }, `${tecnico.id}__${course.id}`);
  assert.equal(safe.extra_attempts, 1);
  assert.equal(safe.completed_at, null);
  assert.equal(safe.certificate_code, null);
});

test('server completes a published course without a quiz after required lessons', () => {
  const noQuiz = { ...course, quiz: { enabled: false }, validity_months: 0 };
  const incoming = { usuarioId: tecnico.id, course_id: course.id, lessons: { 'lesson-1': { done: true } } };
  const safe = protectProgressWrite(tecnico, null, incoming, `${tecnico.id}__${course.id}`, noQuiz, new Date('2026-09-25T12:00:00Z'));
  assert.equal(safe.completed_at, '2026-09-25T12:00:00.000Z');
  assert.match(safe.certificate_code, /^BT-[0-9A-F]{24}$/);
});

test('server grades the quiz and emits the certificate after required lessons', () => {
  const progress = { usuarioId: tecnico.id, course_id: course.id, lessons: { 'lesson-1': { done: true } }, attempts: [], extra_attempts: 0 };
  const graded = applyQuizAttempt(course, progress, { q1: ['a'] }, new Date('2026-09-25T12:00:00Z'));
  assert.equal(graded.result.score, 100);
  assert.equal(graded.result.passed, true);
  assert.match(graded.progress.certificate_code, /^BT-[0-9A-F]{24}$/);
  assert.equal(graded.progress.attempts.length, 1);
  assert.equal(graded.progress.expires_at, '2027-09-25T12:00:00.000Z');
});

test('failed grading does not disclose explanations and attempt limits are enforced', () => {
  const progress = { usuarioId: tecnico.id, course_id: course.id, lessons: { 'lesson-1': { done: true } }, attempts: [], extra_attempts: 0 };
  const failed = applyQuizAttempt(course, progress, { q1: ['b'] });
  assert.equal(failed.result.passed, false);
  assert.equal(failed.result.review[0].explanation, '');
  assert.throws(() => applyQuizAttempt(course, { ...progress, attempts: [{}, {}] }, { q1: ['a'] }), /Tentativas esgotadas/);
});

test('learners cannot delete progress to reset the attempt counter', () => {
  assert.equal(canDeleteProgress(tecnico), false);
  assert.equal(canDeleteProgress(viewer), false);
  assert.equal(canDeleteProgress({ ...tecnico, perfilId: 'lider' }), false);
  assert.equal(canDeleteProgress(gestor), true);
});

test('database migrations verify TLS certificates', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.match(source, /rejectUnauthorized: true/);
  assert.doesNotMatch(source, /rejectUnauthorized: false/);
});
