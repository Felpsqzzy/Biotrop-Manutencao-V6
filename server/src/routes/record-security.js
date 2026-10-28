const crypto = require('node:crypto');

const LMS_MANAGERS = new Set(['admin', 'gestor']);
const PROTECTED_PROGRESS = ['attempts', 'completed_at', 'score', 'certificate_code', 'expires_at', 'extra_attempts', 'history'];
const COURSE_COLORS = new Set(['#00634e', '#0f5f8a', '#6b3fa0', '#b45309', '#b42f37', '#1d7a8c', '#4d7c0f', '#334155']);
const LESSON_KINDS = new Set(['youtube', 'video', 'pdf', 'texto', 'imagem', 'link']);
const COURSE_STATUSES = new Set(['rascunho', 'publicado', 'arquivado']);
// Classificação dos cursos (decisão de 05/10/2026): área da manutenção + tipo de treinamento.
const COURSE_AREAS = new Set(['Segurança', 'PCM', 'Almoxarifado', 'Mecânica', 'Automação', 'Predial']);
const COURSE_TYPES = new Set(['Procedimento', 'Instrução de trabalho', 'Norma (NR)', 'Integração']);

function canDeleteProgress(user) { return LMS_MANAGERS.has(user.perfilId); }

function clone(value) { return JSON.parse(JSON.stringify(value || {})); }

function invalidCourse(message = 'Curso inválido.') {
  return Object.assign(new Error(message), { status: 400 });
}

function text(value, maximum, required = false) {
  const result = String(value ?? '').trim().slice(0, maximum);
  if (required && !result) throw invalidCourse('Preencha os campos obrigatórios do curso.');
  return result;
}

function number(value, minimum, maximum, fallback) {
  const result = Number(value);
  if (!Number.isFinite(result)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(result)));
}

function id(value, maximum = 200) {
  const result = text(value, maximum, true);
  if (!/^[A-Za-z0-9._:@-]+$/.test(result)) throw invalidCourse('Identificador do curso inválido.');
  return result;
}

function safeHttpsUrl(value, maximum = 2000) {
  const result = text(value, maximum);
  if (!result) return '';
  try {
    const parsed = new URL(result);
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch (_) { return ''; }
}

function safeMedia(value, kind) {
  const result = String(value ?? '');
  if (!result) return '';
  if (result.length > 1_600_000) throw invalidCourse('Arquivo de aula acima do limite permitido.');
  const allowed = kind === 'imagem' ? /^data:image\/(?:png|jpeg|webp|gif);base64,/i
    : kind === 'video' ? /^data:video\/(?:mp4|webm);base64,/i
      : kind === 'pdf' ? /^data:application\/pdf;base64,/i : /$a/;
  if (!allowed.test(result)) return '';
  const encoded = result.slice(result.indexOf(',') + 1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded) throw invalidCourse('Arquivo de aula inválido.');
  const bytes = Buffer.from(encoded, 'base64');
  const mime = result.slice(5, result.indexOf(';')).toLowerCase();
  const signature = bytes.subarray(0, 12).toString('hex');
  const valid = mime === 'image/png' ? signature.startsWith('89504e470d0a1a0a')
    : mime === 'image/jpeg' ? signature.startsWith('ffd8ff')
    : mime === 'image/webp' ? signature.startsWith('52494646') && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    : mime === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
    : mime === 'application/pdf' ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : mime === 'video/mp4' ? bytes.subarray(4, 8).toString('ascii') === 'ftyp'
    : mime === 'video/webm' ? signature.startsWith('1a45dfa3') : false;
  if (!valid) throw invalidCourse('O conteúdo não corresponde ao formato da aula.');
  return result;
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeRequestFile(value, { imageOnly = false } = {}) {
  const source = String(value || '');
  if (!source) return '';
  if (source.length > 1_600_000) throw Object.assign(new Error('Anexo acima do limite permitido.'), { status: 400 });
  const match = source.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/i);
  if (match && (!imageOnly || /^image\//i.test(match[1]))) {
    const bytes = Buffer.from(match[2], 'base64');
    const hex = bytes.subarray(0, 12).toString('hex');
    const real = (/^image\/png$/i.test(match[1]) && hex.startsWith('89504e470d0a1a0a'))
      || (/^image\/jpeg$/i.test(match[1]) && hex.startsWith('ffd8ff'))
      || (/^image\/webp$/i.test(match[1]) && hex.startsWith('52494646') && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
      || (/^application\/pdf$/i.test(match[1]) && bytes.subarray(0, 5).toString('ascii') === '%PDF-');
    if (real) return source;
  }
  throw Object.assign(new Error('Formato de anexo não permitido. Envie JPG, PNG, WebP ou PDF.'), { status: 400 });
}

function protectRequestAttachments(payload) {
  const next = clone(payload);
  if (next.foto) next.foto = safeRequestFile(next.foto, { imageOnly: true });
  if (next.anexos != null) {
    if (!Array.isArray(next.anexos) || next.anexos.length > 20) throw Object.assign(new Error('Quantidade de anexos inválida.'), { status: 400 });
    next.anexos = next.anexos.map(file => ({
      name: text(file?.name, 255, true), dataUrl: safeRequestFile(file?.dataUrl || file?.url)
    }));
  }
  return next;
}

/** Normaliza o documento inteiro antes de persistir. Campos desconhecidos são descartados. */
function protectCourseWrite(incoming, recordId) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw invalidCourse();
  const courseId = id(recordId);
  if (incoming.id != null && String(incoming.id) !== courseId) throw invalidCourse('Identificador do curso não confere.');
  const sections = Array.isArray(incoming.sections) ? incoming.sections.slice(0, 100).map(section => ({
    id: id(section?.id),
    title: text(section?.title, 160, true),
    lessons: (Array.isArray(section?.lessons) ? section.lessons : []).slice(0, 500).map(lesson => {
      const kind = LESSON_KINDS.has(lesson?.kind) ? lesson.kind : 'texto';
      return {
        id: id(lesson?.id), title: text(lesson?.title, 200, true), kind,
        url: safeHttpsUrl(lesson?.url), media: safeMedia(lesson?.media, kind), media_name: text(lesson?.media_name, 255),
        body: text(lesson?.body, 200_000), desc: text(lesson?.desc, 10_000),
        duration: number(lesson?.duration, 0, 600, 0), min_seconds: number(lesson?.min_seconds, 0, 7200, 0),
        required: lesson?.required !== false,
        files: (Array.isArray(lesson?.files) ? lesson.files : []).slice(0, 50).map(file => ({
          name: text(file?.name, 255, true), url: safeHttpsUrl(file?.url)
        })).filter(file => file.url)
      };
    })
  })) : [];
  const questions = (Array.isArray(incoming.quiz?.questions) ? incoming.quiz.questions : []).slice(0, 200).map(question => ({
    id: id(question?.id), statement: text(question?.statement, 5000, true),
    kind: question?.kind === 'multipla' ? 'multipla' : 'unica', weight: number(question?.weight, 1, 100, 1),
    explanation: text(question?.explanation, 10_000),
    options: (Array.isArray(question?.options) ? question.options : []).slice(0, 20).map(option => ({
      id: id(option?.id), label: text(option?.label, 2000, true), correct: option?.correct === true
    }))
  }));
  const color = String(incoming.color || '').toLowerCase();
  return {
    id: courseId, code: text(incoming.code, 50), title: text(incoming.title, 200, true),
    subtitle: text(incoming.subtitle, 500), description: text(incoming.description, 20_000),
    category: text(incoming.category, 120),
    area: COURSE_AREAS.has(incoming.area) ? incoming.area : '', tipo: COURSE_TYPES.has(incoming.tipo) ? incoming.tipo : '',
    level: text(incoming.level, 80), instructor: text(incoming.instructor, 200),
    objectives: (Array.isArray(incoming.objectives) ? incoming.objectives : []).slice(0, 50).map(value => text(value, 1000)).filter(Boolean),
    cover: safeMedia(incoming.cover, 'imagem'), color: COURSE_COLORS.has(color) ? color : '#00634e',
    mandatory: incoming.mandatory === true,
    audience: {
      groups: (Array.isArray(incoming.audience?.groups) ? incoming.audience.groups : []).slice(0, 1000).map(value => id(value)),
      users: (Array.isArray(incoming.audience?.users) ? incoming.audience.users : []).slice(0, 5000).map(value => id(value))
    },
    deadline_days: number(incoming.deadline_days, 0, 3650, 30), validity_months: number(incoming.validity_months, 0, 120, 12),
    status: COURSE_STATUSES.has(incoming.status) ? incoming.status : 'rascunho', version: number(incoming.version, 1, 10_000, 1),
    // Histórico de revisões: o que mudou, quem, quando. "retrain" = quem concluiu versão anterior precisa refazer.
    revisions: (Array.isArray(incoming.revisions) ? incoming.revisions : []).slice(-200).map(r => ({
      version: number(r?.version, 1, 10_000, 1), at: isoDate(r?.at), by: text(r?.by, 200), note: text(r?.note, 2000),
      retrain: r?.retrain === true, lessons: number(r?.lessons, 0, 100_000, 0), minutes: number(r?.minutes, 0, 1_000_000, 0),
      questions: number(r?.questions, 0, 100_000, 0)
    })),
    retrain_version: number(incoming.retrain_version, 0, 10_000, 0), retrain_at: isoDate(incoming.retrain_at),
    sections,
    quiz: { enabled: incoming.quiz?.enabled === true, pass_score: number(incoming.quiz?.pass_score, 0, 100, 70),
      max_attempts: number(incoming.quiz?.max_attempts, 0, 100, 3), shuffle: incoming.quiz?.shuffle === true, questions },
    created_at: isoDate(incoming.created_at), updated_at: new Date().toISOString(), published_at: isoDate(incoming.published_at)
  };
}

function redactCourse(payload, user) {
  const out = clone(payload);
  if (LMS_MANAGERS.has(user.perfilId)) return out;
  const questions = out.quiz?.questions;
  if (Array.isArray(questions)) {
    for (const question of questions) {
      delete question.explanation;
      if (Array.isArray(question.options)) for (const option of question.options) delete option.correct;
    }
  }
  return out;
}

function redactProgress(payload, user) {
  const out = clone(payload);
  if (String(out.usuarioId || '') !== String(user.id || '')) delete out.notes;
  return out;
}

function exposeRecord(row, user) {
  let payload = row.payload;
  if (row.namespace === 'lms_courses') payload = redactCourse(payload, user);
  if (row.namespace === 'lms_progress') payload = redactProgress(payload, user);
  return { id: row.id, namespace: row.namespace, recordId: row.record_id, payload, deleted: row.deleted,
    version: Number(row.version), updatedBy: row.updated_by, updatedAt: row.updated_at, createdAt: row.created_at };
}

function newCertificateCode() { return `BT-${crypto.randomBytes(12).toString('hex').toUpperCase()}`; }

function protectProgressWrite(user, current, incoming, recordId, course = null, now = new Date()) {
  const next = clone(incoming);
  const courseId = String(next.course_id || '').trim();
  if (!courseId || courseId.length > 200) throw Object.assign(new Error('Curso inválido.'), { status: 400 });
  const before = current?.payload || {};
  const targetUser = String(before.usuarioId || next.usuarioId || '');
  const manager = LMS_MANAGERS.has(user.perfilId);
  if (!manager && targetUser && targetUser !== String(user.id)) throw Object.assign(new Error('Registro de progresso inválido.'), { status: 403 });
  const owner = manager ? targetUser : String(user.id);
  if (!owner || String(recordId) !== `${owner}__${courseId}`) throw Object.assign(new Error('Registro de progresso inválido.'), { status: 403 });
  // Only one active lesson receives wall-clock credit; client seconds and completion are untrusted.
  const beat = incoming.lessonHeartbeat;
  const previousBeat = before._lessonHeartbeat;
  next._lessonHeartbeat = previousBeat ? clone(previousBeat) : null;
  delete next.lessonHeartbeat;
  next.lessons = {};
  for (const section of course?.sections || []) for (const lesson of section.lessons || []) {
    const old = before.lessons?.[lesson.id] || {};
    const requested = incoming.lessons?.[lesson.id] || {};
    if (lesson.kind !== 'video' && lesson.kind !== 'youtube') {
      next.lessons[lesson.id] = { seconds: Math.max(0, Number(old.seconds) || 0), pos: 0,
        done: old.done === true || (owner === String(user.id) && requested.done === true),
        done_at: old.done_at || (owner === String(user.id) && requested.done === true ? now.toISOString() : null) };
      continue;
    }
    let seconds = Math.max(0, Number(old._serverSeconds) || 0);
    let pos = old._serverSeconds != null ? Math.max(0, Number(old.pos) || 0) : 0;
    if (owner === String(user.id) && beat?.lessonId === lesson.id) {
      const elapsed = previousBeat?.lessonId === lesson.id
        ? (now.getTime() - new Date(previousBeat.at).getTime()) / 1000 : 0;
      const requestedPos = Number(beat.pos);
      const advancing = Number.isFinite(requestedPos) && requestedPos >= pos && requestedPos - pos <= Math.max(0, elapsed) + 2;
      if (advancing && elapsed > 0 && elapsed <= 15) {
        if (previousBeat.playing === true) seconds += Math.min(elapsed, Math.max(0, requestedPos - pos));
        pos = requestedPos;
      }
      next._lessonHeartbeat = { lessonId: lesson.id, at: now.toISOString(), playing: beat.playing === true && advancing };
    }
    const needed = Math.max(Number(lesson.min_seconds) || 0, (Number(lesson.duration) || 1) * 60 * 0.8);
    const done = seconds >= needed;
    next.lessons[lesson.id] = { seconds, _serverSeconds: seconds, pos, done, done_at: old.done_at || (done ? now.toISOString() : null) };
  }
  next.usuarioId = owner;
  next.user_name = manager ? String(before.user_name || next.user_name || '') : (user.nome || '');
  for (const key of PROTECTED_PROGRESS) {
    if (Object.prototype.hasOwnProperty.call(before, key)) next[key] = clone(before[key]);
    else delete next[key];
  }
  next.attempts = Array.isArray(before.attempts) ? clone(before.attempts) : [];
  next.completed_at = before.completed_at || null;
  next.score = before.score ?? null;
  next.certificate_code = before.certificate_code || null;
  next.expires_at = before.expires_at || null;
  next.extra_attempts = Number(before.extra_attempts) || 0;
  next.history = Array.isArray(before.history) ? clone(before.history) : [];

  // Gestores podem apenas acrescentar tentativas; nota e certificado continuam exclusivos do servidor.
  if (manager && Number(incoming.extra_attempts) > next.extra_attempts) {
    next.extra_attempts = Math.min(100, Math.floor(Number(incoming.extra_attempts)));
  }

  // O próprio aluno pode reiniciar um certificado já vencido, ou que ficou desatualizado por uma revisão
  // do curso que pediu para todos refazerem.
  const resetRequested = before.completed_at && incoming.completed_at == null &&
    incoming.certificate_code == null && incoming.score == null && Object.keys(incoming.lessons || {}).length === 0;
  const vencido = before.expires_at && new Date(before.expires_at) <= now;
  const desatualizado = Number(course?.retrain_version) > (Number(before.version) || 1);
  if (resetRequested && owner === String(user.id) && (vencido || desatualizado)) {
    next.history.push({ completed_at: before.completed_at, score: before.score, certificate_code: before.certificate_code,
      expires_at: before.expires_at, version: before.version });
    next.attempts = []; next.completed_at = null; next.score = null; next.certificate_code = null;
    next.expires_at = null; next.extra_attempts = 0; next.lessons = {}; next._lessonHeartbeat = null;
  }

  // Cursos sem prova também são concluídos pelo servidor, a partir das aulas obrigatórias salvas.
  if (!next.completed_at && course?.status === 'publicado' && !course.quiz?.enabled) {
    const required = requiredLessons(course);
    if (required.length && required.every(lesson => next.lessons?.[lesson.id]?.done === true)) {
      next.completed_at = now.toISOString();
      next.score = null;
      next.certificate_code = newCertificateCode();
      next.version = Number(course.version) || 1;
      if (Number(course.validity_months) > 0) {
        const expires = new Date(now); expires.setUTCMonth(expires.getUTCMonth() + Number(course.validity_months));
        next.expires_at = expires.toISOString();
      }
    }
  }
  return next;
}

function requiredLessons(course) {
  const all = [];
  for (const section of course.sections || []) for (const lesson of section.lessons || []) all.push(lesson);
  const required = all.filter(lesson => lesson.required !== false);
  return required.length ? required : all;
}

function gradeQuiz(course, answers) {
  const questions = course.quiz?.questions;
  if (!course.quiz?.enabled || !Array.isArray(questions) || !questions.length) throw Object.assign(new Error('Avaliação indisponível.'), { status: 409 });
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw Object.assign(new Error('Respostas inválidas.'), { status: 400 });
  let earned = 0, totalWeight = 0, right = 0;
  const review = questions.map(question => {
    const weight = Math.max(0, Number(question.weight) || 1);
    totalWeight += weight;
    const allowed = new Set((question.options || []).map(option => String(option.id)));
    const given = [...new Set(Array.isArray(answers[question.id]) ? answers[question.id].map(String) : [])].sort();
    if (!given.length || given.some(value => !allowed.has(value))) throw Object.assign(new Error('Respostas incompletas ou inválidas.'), { status: 400 });
    const expected = (question.options || []).filter(option => option.correct === true).map(option => String(option.id)).sort();
    const ok = given.length === expected.length && given.every((value, index) => value === expected[index]);
    if (ok) { earned += weight; right += 1; }
    return { id: question.id, statement: String(question.statement || ''), ok, explanation: ok ? String(question.explanation || '') : '' };
  });
  const score = totalWeight ? Math.round(earned / totalWeight * 100) : 0;
  return { score, passed: score >= (Number(course.quiz.pass_score) || 70), right, total: questions.length, review };
}

function applyQuizAttempt(course, progress, answers, now = new Date()) {
  if (course.status !== 'publicado') throw Object.assign(new Error('Curso não publicado.'), { status: 409 });
  const required = requiredLessons(course);
  const lessons = progress.lessons || {};
  if (!required.every(lesson => lessons[lesson.id]?.done === true &&
    (!['video', 'youtube'].includes(lesson.kind) || Number(lessons[lesson.id]?._serverSeconds) >= Math.max(Number(lesson.min_seconds) || 0, (Number(lesson.duration) || 1) * 60 * 0.8)))) throw Object.assign(new Error('Conclua as aulas obrigatórias antes da avaliação.'), { status: 409 });
  const attempts = Array.isArray(progress.attempts) ? progress.attempts : [];
  const configured = Number(course.quiz?.max_attempts) || 0;
  const maximum = configured > 0 ? configured + (Number(progress.extra_attempts) || 0) : Infinity;
  if (attempts.length >= maximum) throw Object.assign(new Error('Tentativas esgotadas.'), { status: 409 });
  const result = gradeQuiz(course, answers);
  if (!result.passed) result.review = result.review.map(item => ({ ...item, explanation: '' }));
  const next = clone(progress);
  next.attempts = attempts.concat([{ no: attempts.length + 1, score: result.score, passed: result.passed, at: now.toISOString() }]);
  if (result.passed && !next.completed_at) {
    next.completed_at = now.toISOString();
    next.score = result.score;
    next.certificate_code = newCertificateCode();
    next.version = Number(course.version) || 1;
    if (Number(course.validity_months) > 0) {
      const expires = new Date(now); expires.setUTCMonth(expires.getUTCMonth() + Number(course.validity_months));
      next.expires_at = expires.toISOString();
    } else next.expires_at = null;
  }
  return { progress: next, result: { ...result, left: Number.isFinite(maximum) ? Math.max(0, maximum - next.attempts.length) : null } };
}

module.exports = { COURSE_AREAS, COURSE_TYPES, LMS_MANAGERS, canDeleteProgress, exposeRecord, redactCourse, redactProgress, protectCourseWrite, protectRequestAttachments, protectProgressWrite, gradeQuiz, applyQuizAttempt };
