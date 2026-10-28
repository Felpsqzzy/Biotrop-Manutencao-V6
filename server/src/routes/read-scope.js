const { vePlanoDeTeste } = require('../simulacao/identidade');

const MANAGERS = new Set(['admin', 'gestor', 'pcm', 'almoxarife']);
const PERSONAL = new Set(['sci', 'scm', 'utility_readings', 'lms_progress']);
const VIEWER_PUBLIC = new Set(['utility_meters', 'lms_courses']);

/**
 * Filtro de leitura aplicado pela API além do RLS do PostgreSQL.
 * `firstParameter` é o número do próximo placeholder SQL disponível.
 */
function buildReadScope(user, namespace, firstParameter = 1) {
  const escopo = escopoBase(user, namespace, firstParameter);
  // Modo de teste: registros dos usuários virtuais só aparecem para o admin (e para eles mesmos).
  if (!vePlanoDeTeste(user)) escopo.sql += " AND (payload->>'_simulacao' IS DISTINCT FROM 'true')";
  return escopo;
}

function escopoBase(user, namespace, firstParameter) {
  // Perfil do terminal do almoxarifado: não lê nenhum dado do site (lista fechada, nunca o caminho "sem filtro").
  if (user.perfilId === 'terminal') return { sql: ' AND false', params: [] };
  if (MANAGERS.has(user.perfilId)) return { sql: '', params: [] };
  if (namespace === 'lms_courses') return { sql: " AND payload->>'status'='publicado'", params: [] };
  if (user.perfilId === 'lider') {
    const group = firstParameter;
    const actor = firstParameter + 1;
    return {
      sql: ` AND (payload->>'_groupId'=$${group} OR payload->>'grupoId'=$${group} OR payload->>'solicitanteGrupoId'=$${group} OR payload->>'_ownerId'=$${actor} OR payload->>'solicitanteId'=$${actor} OR payload->>'aprovadorId'=$${actor})`,
      params: [String(user.grupoId || ''), String(user.id)]
    };
  }
  if (PERSONAL.has(namespace)) {
    const actor = firstParameter;
    const email = firstParameter + 1;
    return {
      sql: ` AND (payload->>'_ownerId'=$${actor} OR payload->>'solicitanteId'=$${actor} OR payload->>'usuarioId'=$${actor} OR payload->>'aprovadorId'=$${actor} OR lower(payload->>'solicitanteEmail')=lower($${email}))`,
      params: [String(user.id), String(user.email || '')]
    };
  }
  if (user.perfilId === 'viewer' && !VIEWER_PUBLIC.has(namespace)) return { sql: ' AND false', params: [] };
  return { sql: '', params: [] };
}

module.exports = { MANAGERS, buildReadScope };
