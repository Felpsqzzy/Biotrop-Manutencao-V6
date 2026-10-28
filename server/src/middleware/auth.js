const { verifySession, precisaRenovar, setSession, clearSession, COOKIE } = require('../auth/session');
const crypto = require('node:crypto');
const { transaction } = require('../db/pool');

/** Hash do sid: é o que fica na lista de sessões encerradas (o cookie nunca é guardado). */
function sidHash(sid) { return crypto.createHash('sha256').update(String(sid)).digest('hex'); }

/**
 * Valida a sessão a cada requisição, no banco: usuário ativo, não bloqueado, e-mail ainda autorizado e
 * versão da sessão igual à do cookie (sair de todos os aparelhos, bloqueio ou troca de perfil derrubam na hora).
 * A consulta passa por app.sessao_usuario() (SECURITY DEFINER): antes de existir identidade na transação,
 * o RLS de core.usuario/core.email_autorizado não devolve linha nenhuma.
 */
async function requireAuth(req, res, next) {
  const sessao = verifySession(req.cookies?.[COOKIE]);
  if (!sessao) return res.status(401).json({ ok: false, erro: 'Sessão Microsoft ausente ou expirada.' });
  try {
    const user = await transaction(null, async client => (await client.query(
      'SELECT u.*, app.sessao_encerrada($2) AS encerrada FROM app.sessao_usuario($1::uuid) u', [sessao.sub, sidHash(sessao.sid)])).rows[0] || null);
    // "Sair" encerrou esta sessão no servidor (migration 26): o cookie copiado antes do logout não vale mais
    if (!user || Number(user.sessao_versao) !== sessao.sv || user.encerrada) {
      clearSession(res);
      return res.status(401).json({ ok: false, erro: 'Sessão encerrada. Entre novamente.' });
    }
    req.sessao = sessao;
    req.user = {
      id: user.id, nome: user.nome, email: user.email, perfilId: user.perfil_id, grupoId: user.grupo_id,
      time: user.time || ''
    };
    // Telefone fica cifrado; só /auth/me o abre (a validação de sessão não depende do KMS).
    Object.defineProperty(req.user, 'telefoneCifrado', { value: user.telefone || '', enumerable: false });
    // Renovação deslizante (inatividade); a validade absoluta do login original é mantida.
    if (precisaRenovar(sessao)) setSession(res, { id: user.id, sessaoVersao: user.sessao_versao, sid: sessao.sid, iat: sessao.iat, exp: sessao.exp });
    next();
  } catch (error) { next(error); }
}

module.exports = { requireAuth, sidHash };
