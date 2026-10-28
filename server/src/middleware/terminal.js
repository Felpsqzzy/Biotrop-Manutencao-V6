'use strict';
// Porta da API do terminal (/api/terminal). Só aceita o cookie do terminal — nunca o do site — e confere no banco, a cada
// requisição: sessão não encerrada, dentro da inatividade (emprestimo.config) e da validade de 30 min, versão da
// credencial igual à do cookie, colaborador ativo e sem bloqueio. Passou: renova a inatividade. Falhou: 401 e o cookie sai.
// A identidade que segue para as transações é só id + e-mail: o perfil do site não vale aqui (o canal 'terminal' faz
// o banco tratar qualquer perfil como colaborador).
const { transaction } = require('../db/pool');
const { COOKIE, verificarSessaoTerminal, sidHash, limparCookieTerminal } = require('../auth/terminal-sessao');

async function requireTerminal(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const negar = () => { limparCookieTerminal(res); return res.status(401).json({ ok: false, erro: 'Sessão do terminal encerrada.' }); };
  const s = verificarSessaoTerminal(req.cookies?.[COOKIE]);
  if (!s) return negar();
  try {
    const hash = sidHash(s.sid);
    const r = await transaction(null, async db => (await db.query('SELECT * FROM emprestimo.terminal_sessao_validar($1,$2::uuid,$3)', [hash, s.sub, s.cv])).rows[0] || null);
    if (!r) return negar();
    req.terminal = {
      sidHash: hash, inatividadeSegundos: r.inatividade, expiraEm: r.expira_em,
      colaborador: { nome: r.nome, matricula: r.matricula, setor: r.setor, centroCusto: r.centro_custo, cargo: r.cargo }
    };
    req.terminalUser = { id: r.usuario_id, email: r.email };
    next();
  } catch (error) { next(error); }
}

module.exports = { requireTerminal };
