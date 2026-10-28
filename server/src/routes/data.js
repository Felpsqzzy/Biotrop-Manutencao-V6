const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const workflow = require('./workflow');
const { MANAGERS: managers, buildReadScope } = require('./read-scope');
const { canDeleteProgress, exposeRecord, protectCourseWrite, protectRequestAttachments, protectProgressWrite } = require('./record-security');
const { protegerPayload, abrirLinha, abrirLinhas } = require('../crypto/registros');
const { registrarEvento } = require('../seguranca/eventos');
const { ehSimulado } = require('../simulacao/identidade');

const router = express.Router();
const FLUXO = new Set(['sci', 'scm']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ids de registro: só caracteres seguros (o id aparece em telas; nada de aspas, <, >, espaços).
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,299}$/;
const falhaCifra = user => (row, e) => registrarEvento('cifra.registro_ilegivel', user, { namespace: row.namespace, registro: String(row.record_id).slice(0, 120), codigo: e?.codigo || 'erro' });
function forbid(message) { const e = new Error('FORBIDDEN'); e.status = 403; e.userMessage = message; return e; }

/** SCI/SCM: aprovador decidido pelo banco e fluxo conferido (workflow.js). Devolve o payload a gravar. */
async function checkFlow(db, ns, req, current) {
  const incoming = { ...(req.body?.payload || {}) };
  const before = current && !current.deleted ? current.payload : null;
  if (!before && ns === 'scm') {
    const ap = UUID.test(String(req.user.id)) ? (await db.query('SELECT * FROM app.aprovador_de($1::uuid)', [req.user.id])).rows[0] : null;
    incoming.aprovadorId = ap?.id || null;
    incoming.solicitanteEmailLider = ap?.email || '';
    incoming.aprovadorOrigem = ap?.origem || 'gestao';
    incoming.aprovadorResolvido = true;
  }
  if (!before) incoming.historico = [];
  let lidera = false;
  if (before && UUID.test(String(before.solicitanteId || ''))) {
    lidera = (await db.query('SELECT app.eh_do_meu_grupo($1::uuid) AS ok', [before.solicitanteId])).rows[0]?.ok === true;
  }
  const actor = { id: req.user.id, email: req.user.email, perfilId: req.user.perfilId, lideraSolicitante: lidera };
  if (req.body?.deleted === true) {
    const erroExclusao = workflow.checkExclusao(ns, before, actor);
    if (erroExclusao) throw forbid(erroExclusao);
    // Exclusão grava o registro do BANCO (o payload do cliente é ignorado: trilha, aprovador e campos continuam os do
    // servidor) com o evento de exclusão no fim do histórico.
    const history = Array.isArray(before.historico) ? before.historico.slice(-199) : [];
    history.push({ de: workflow.norm(ns, before.status), para: 'excluida', evento: 'exclusao', em: new Date().toISOString(), porId: req.user.id,
      por: req.user.nome || req.user.email, perfil: req.user.perfilId, nota: '' });
    return { ...before, historico: history };
  }
  const erro = workflow.check(ns, before, incoming, actor);
  if (erro) throw forbid(erro);
  if (before) {
    // Identidade do aprovador e trilha de auditoria são dados do servidor.
    // O cliente pode enviar a tela inteira, mas não reescreve nenhum deles.
    if (ns === 'scm') {
      incoming.aprovadorId = before.aprovadorId || null;
      incoming.solicitanteEmailLider = before.solicitanteEmailLider || '';
      incoming.aprovadorOrigem = before.aprovadorOrigem || 'gestao';
      incoming.aprovadorResolvido = before.aprovadorResolvido === true;
    }
    const from = workflow.norm(ns, before.status);
    const to = workflow.norm(ns, incoming.status);
    const history = Array.isArray(before.historico) ? before.historico.slice(0, 200) : [];
    if (from !== to) {
      // nota da trilha: só o texto escrito NESTA mudança (a observação de uma etapa anterior continua no registro)
      const nova = k => String(incoming[k] || '').trim() && String(incoming[k] || '') !== String(before[k] || '');
      const note = incoming._resposta || ['observacaoLider', 'observacaoAlmoxarife'].filter(nova).map(k => incoming[k])[0] || '';
      history.push({ de: from, para: to, em: new Date().toISOString(), porId: req.user.id,
        por: req.user.nome || req.user.email, perfil: req.user.perfilId, nota: String(note).slice(0, 2000) });
    }
    incoming.historico = history.slice(-200);
    delete incoming._resposta;
  }
  return protectRequestAttachments(incoming);
}
const allowed = new Set(['sci','scm','utility_meters','utility_readings','groups','families','cost_centers','lms_courses','lms_progress']);
const writeRoles = {
  sci:new Set(['admin','gestor','pcm','almoxarife','lider','tecnico']),
  scm:new Set(['admin','gestor','pcm','almoxarife','lider','tecnico']),
  utility_meters:new Set(['admin','gestor','pcm']),
  utility_readings:new Set(['admin','gestor','pcm','tecnico']),
  groups:new Set(['admin']),
  families:new Set(['admin','gestor','almoxarife']),
  cost_centers:new Set(['admin','gestor','almoxarife']),
  lms_courses:new Set(['admin','gestor']),
  lms_progress:new Set(['admin','gestor','pcm','almoxarife','lider','tecnico','viewer'])
};

function namespace(value) {
  const name = String(value || '').trim();
  return allowed.has(name) ? name : null;
}

router.use(requireAuth);

async function getRecords(req, res, next) {
  const ns = namespace(req.params.namespace || req.query.namespace);
  if (!ns) return res.status(400).json({ ok:false, erro:'Módulo inválido.' });
  try {
    const brutas = await transaction(req.user, async db => {
      const scope = buildReadScope(req.user, ns, 2);
      const args = [ns, ...scope.params];
      return (await db.query(`SELECT * FROM app.sync_registro WHERE namespace=$1${scope.sql} ORDER BY updated_at,version`, args)).rows;
    });
    // Decifra fora da transação (o banco não fica esperando o KMS). Só linhas que o RLS e o escopo já liberaram.
    const rows = (await abrirLinhas(brutas, falhaCifra(req.user))).map(row => exposeRecord(row, req.user));
    res.set('Cache-Control','no-store').json({ ok:true, namespace:ns, rows });
  } catch (error) { next(error); }
}

async function putRecord(req, res, next) {
  const ns = namespace(req.params.namespace || req.body?.namespace);
  const recordId = String(req.params.recordId || req.body?.recordId || '').trim();
  const expected = req.body?.expectedVersion == null ? null : Number(req.body.expectedVersion);
  if (!ns || !RECORD_ID.test(recordId)) return res.status(400).json({ ok:false, erro:'Registro inválido.' });
  const idNoPayload = req.body?.payload?.id;
  if (idNoPayload != null && !RECORD_ID.test(String(idNoPayload))) return res.status(400).json({ ok:false, erro:'Identificador do registro inválido.' });
  if (!writeRoles[ns]?.has(req.user.perfilId)) return res.status(403).json({ ok:false, erro:'Seu perfil não pode alterar este módulo.' });
  // Curso não se exclui: desativa (status "arquivado"), e o histórico e os certificados continuam valendo.
  if (ns === 'lms_courses' && req.body?.deleted === true) {
    return res.status(403).json({ ok:false, erro:'Curso não pode ser excluído. Desative o curso: o histórico e os certificados continuam valendo.' });
  }
  if (ns === 'lms_progress' && req.body?.deleted === true && !canDeleteProgress(req.user)) {
    return res.status(403).json({ ok:false, erro:'O histórico de treinamento não pode ser apagado.' });
  }
  try {
    const row = await transaction(req.user, async db => {
      const current = await abrirLinha((await db.query(`SELECT * FROM app.sync_registro WHERE namespace=$1 AND record_id=$2 FOR UPDATE`,[ns,recordId])).rows[0], falhaCifra(req.user));
      if (!current) {
        // FOR UPDATE só devolve o que o banco deixa ALTERAR. Registro que a pessoa enxerga mas não pode alterar não
        // é um registro novo: recusa com o motivo do fluxo (ou um genérico), em vez de tentar criar outro por cima.
        const visivel = (await db.query(`SELECT * FROM app.sync_registro WHERE namespace=$1 AND record_id=$2`, [ns, recordId])).rows[0];
        if (visivel) {
          if (FLUXO.has(ns)) await checkFlow(db, ns, req, await abrirLinha(visivel, falhaCifra(req.user)));
          throw forbid('Seu perfil não pode alterar este registro nesta etapa.');
        }
      }
      const fluxo = FLUXO.has(ns) ? await checkFlow(db, ns, req, current) : null;
      if (!fluxo && current && req.user.perfilId === 'lider') {
        const currentGroup = String(current.payload?._groupId || current.payload?.grupoId || current.payload?.solicitanteGrupoId || '');
        if (!currentGroup || currentGroup !== String(req.user.grupoId || '')) {
          const forbidden = new Error('FORBIDDEN'); forbidden.status = 403; throw forbidden;
        }
      }
      if (!fluxo && current && !managers.has(req.user.perfilId) && req.user.perfilId !== 'lider') {
        const owner = String(current.payload?._ownerId || current.payload?.solicitanteId || current.payload?.usuarioId || '');
        const mail = String(current.payload?.solicitanteEmail || '').toLowerCase();
        if (owner && owner !== String(req.user.id) && mail !== String(req.user.email).toLowerCase()) {
          const forbidden = new Error('FORBIDDEN'); forbidden.status = 403; throw forbidden;
        }
      }
      // Alteração de registro que já existe exige a versão lida (a tela sempre manda): sem ela, "o último grava vence".
      if (current && expected === null) {
        throw Object.assign(new Error('PRECONDITION'), { status: 428 });
      }
      if (current && Number(current.version) !== expected) {
        const conflict = new Error('CONFLICT'); conflict.status = 409; conflict.current = exposeRecord(current, req.user); throw conflict;
      }
      const requestedPayload = fluxo || req.body?.payload || {};
      let course = null;
      if (ns === 'lms_progress') {
        const courseId = String(requestedPayload.course_id || current?.payload?.course_id || '');
        if (courseId) course = (await db.query(
          `SELECT payload FROM app.sync_registro WHERE namespace='lms_courses' AND record_id=$1 AND NOT deleted LIMIT 1`, [courseId]
        )).rows[0]?.payload || null;
      }
      let safePayload = ns === 'lms_progress' ? protectProgressWrite(req.user, current, requestedPayload, recordId, course)
        : ns === 'lms_courses' ? protectCourseWrite(requestedPayload, recordId) : requestedPayload;
      // Leituras de utilidade: o dono (usuarioId, usado pelo RLS) vem da SESSÃO na criação e nunca muda depois.
      // Antes o navegador não enviava esse campo e o RLS recusava a gravação do técnico.
      if (ns === 'utility_readings') safePayload = { ...safePayload, usuarioId: current?.payload?.usuarioId || req.user.id };
      // Medidor acumulativo: o técnico não aponta leitura menor que a anterior (até a data dele). PCM/gestor/admin
      // corrigem apontamentos errados sem essa trava. A tela confere o mesmo antes de enviar.
      if (ns === 'utility_readings' && req.body?.deleted !== true && !managers.has(req.user.perfilId)) {
        const leitura = Number(safePayload.reading), quando = new Date(safePayload.at || Date.now());
        if (!Number.isFinite(leitura) || leitura < 0) throw Object.assign(new Error('Leitura inválida.'), { status: 400 });
        if (Number.isNaN(quando.getTime())) throw Object.assign(new Error('Data da leitura inválida.'), { status: 400 });
        const anterior = (await db.query('SELECT app.ultima_leitura($1, $2, $3) AS v', [String(safePayload.meterId || ''), quando.toISOString(), recordId])).rows[0]?.v;
        if (anterior != null && leitura < Number(anterior)) {
          throw forbid(`A leitura não pode ser menor que a anterior (${Number(anterior).toLocaleString('pt-BR')}). Se o visor está menor, avise o PCM.`);
        }
      }
      // Marca do modo de teste: só o servidor decide (usuário virtual, ou registro que já era de teste).
      // Ninguém consegue esconder um registro real dos gestores mandando "_simulacao" pelo navegador.
      safePayload = { ...safePayload };
      if (ehSimulado(req.user) || current?.payload?._simulacao === true) safePayload._simulacao = true;
      else delete safePayload._simulacao;
      if (!current) {
        if (expected !== null && expected !== 0) { const conflict=new Error('CONFLICT'); conflict.status=409; throw conflict; }
        const payload = { ...safePayload, _ownerId:req.user.id, _ownerEmail:req.user.email, _groupId:req.user.grupoId || null };
        const gravado = await protegerPayload(ns, recordId, 1, payload);   // versão inicial da linha = 1
        const nova = (await db.query(`INSERT INTO app.sync_registro(namespace,record_id,payload,deleted,updated_by)
          VALUES($1,$2,$3::jsonb,$4,$5) RETURNING *`,[ns,recordId,JSON.stringify(gravado),req.body?.deleted===true,req.user.id])).rows[0];
        return exposeRecord({ ...nova, payload }, req.user);
      }
      const payload = { ...safePayload, _ownerId:current.payload?._ownerId || req.user.id,
        _ownerEmail:current.payload?._ownerEmail || req.user.email, _groupId:current.payload?._groupId || req.user.grupoId || null };
      // A linha está travada (FOR UPDATE): a próxima versão é exatamente a atual + 1, e entra no AAD.
      const gravado = await protegerPayload(ns, recordId, Number(current.version) + 1, payload);
      const nova = (await db.query(`UPDATE app.sync_registro SET payload=$3::jsonb,deleted=$4,version=version+1,updated_by=$5,updated_at=now()
        WHERE namespace=$1 AND record_id=$2 AND version=$6 RETURNING *`,[ns,recordId,JSON.stringify(gravado),req.body?.deleted===true,req.user.id,Number(current.version)])).rows[0];
      return exposeRecord({ ...nova, payload }, req.user);
    });
    res.json({ ok:true, row });
  } catch (error) {
    if (error.status === 428) return res.status(428).json({ ok:false, erro:'Informe a versão atual do registro (expectedVersion).' });
    if (error.status === 409) return res.status(409).json({ ok:false, conflito:true, erro:'O registro foi alterado por outro usuário.', row:error.current || null });
    if (error.status === 400) return res.status(400).json({ ok:false, erro:error.message || 'Registro inválido.' });
    if (error.status === 403) return res.status(403).json({ ok:false, erro:error.userMessage || error.message || 'Você não pode alterar um registro de outro usuário.' });
    next(error);
  }
}

router.get('/', getRecords);
router.get('/:namespace', getRecords);
router.post('/', putRecord);
router.put('/:namespace/:recordId', putRecord);

module.exports = router;
