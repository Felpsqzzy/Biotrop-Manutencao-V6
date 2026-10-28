'use strict';
// API do terminal do almoxarifado (tablet na porta): matrícula + senha próprias e sessão curta, separada do site.
//  • O colaborador é sempre o da sessão: o corpo nunca escolhe a pessoa. Tudo roda no canal 'terminal', em que o banco
//    trata qualquer perfil (até admin) como colaborador: retira e devolve só para si e só vê o que é seu.
//  • Só ferramenta: material do catálogo MAN (REG.0306) é retirado e devolvido no balcão, pelo painel.
//  • Login: mesma resposta para matrícula inexistente, senha errada, bloqueado, inativo, sem senha e bloqueio temporário;
//    sempre o mesmo trabalho de scrypt (tempo igual, também com hash de custo antigo). Limites: por matrícula e por
//    aparelho no banco (migration 41; a tentativa é reservada ANTES do scrypt, então pedidos simultâneos não passam do
//    limite e o aparelho barrado recebe 429 sem hash nenhum) e por IP aqui (app.js). Saída administrativa: senha do
//    terminal + código do autenticador do site (2FA) de admin/gestor/almoxarife.
const express = require('express');
const { transaction } = require('../db/pool');
const totp = require('../auth/totp');
const { abrirSegredo2fa } = require('../crypto/pessoais');
const senhas = require('../lib/senha-terminal');
const sessao = require('../auth/terminal-sessao');
const { requireTerminal } = require('../middleware/terminal');
const { _lib: E } = require('./emprestimo');

const router = express.Router();
const ERRO_LOGIN = 'Matrícula ou senha inválidas.';
const ERRO_CODIGO = 'Código inválido ou expirado.';
const ERRO_SAIDA = 'Não autorizado.';
const ERRO_LIMITE = 'Muitas tentativas. Aguarde alguns minutos.';
const MATRICULA = /^[A-Za-z0-9]{3,20}$/;
const CHAVE = /^[A-Za-z0-9_-]{8,80}$/;
const PODE_SAIR = new Set(['admin', 'gestor', 'almoxarife']);

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const ipHash = req => senhas.hashIp(req.ip || req.socket?.remoteAddress || '');
// objeto no lugar do texto ({"toString":1}) vira vazio, não TypeError/500
const matriculaDe = v => { const m = senhas.textoDe(v).trim(); return MATRICULA.test(m) ? m : ''; };
const colaborador = r => ({ nome: r.nome, matricula: r.matricula, setor: r.setor, centroCusto: r.centro_custo, cargo: r.cargo });
const PRAZO = 'SELECT emprestimo.terminal_prazo_padrao() AS p';   // prazo padrão da retirada: o tablet mostra a data prevista

// Parâmetros dos hashes gravados (custo do scrypt), relidos do banco no máximo a cada minuto: toda conferência calcula
// um scrypt de cada conjunto (senhas.verificar), com ou sem matrícula. A releitura não depende de quem tenta entrar.
let parametros = { lista: [], ate: 0 };

/** Encerra no servidor a sessão do terminal que este navegador ainda tiver (troca de pessoa no tablet, saída administrativa). */
async function encerrarAtual(req, motivo) {
  const s = sessao.verificarSessaoTerminal(req.cookies?.[sessao.COOKIE]);
  if (s) await transaction(null, db => db.query('SELECT emprestimo.terminal_sessao_encerrar($1,$2)', [sessao.sidHash(s.sid), motivo]));
}

/* ---------------------------------------------------------------- login em duas metades (senha conferida aqui) */
// Semáforo do scrypt (lib/senha-terminal.js): conferirSenha roda dentro de senhas.naVez, que pega a vaga ANTES de
// reservar a tentativa no banco e a segura até o último hash. "Ocupado" (503) sai antes da reserva e não conta como erro
// da matrícula nem do aparelho; depois da reserva, nenhum hash do pedido fica sem vaga.
async function conferirSenha(req, tipo, vez) {
  const ip = ipHash(req);
  const ini = await transaction(null, async db => {
    const r = (await db.query('SELECT * FROM emprestimo.terminal_login_inicio($1,$2,$3)', [matriculaDe(req.body?.matricula), ip, tipo])).rows[0];
    if (r.situacao !== 'limite_ip' && Date.now() >= parametros.ate) {
      parametros = { lista: (await db.query('SELECT emprestimo.terminal_parametros_hash() AS p')).rows[0].p || [], ate: Date.now() + 60_000 };
    }
    return r;
  });
  if (ini.situacao === 'limite_ip') return { limite: true };
  const conferir = ini.situacao === 'verificar';
  // Sempre o mesmo trabalho: com o hash real ou só com fictícios (inexistente, sem senha, bloqueado...).
  const confere = await senhas.verificar(req.body?.senha, conferir ? ini.senha_hash : null, parametros.lista, vez);
  return { ip, ini, resultado: conferir ? (confere ? 'ok' : 'senha') : ini.situacao };
}
function concluir(c, tipo, resultado, { sidHash = null, novoHash = null } = {}) {
  return transaction(null, async db => {
    const r = (await db.query('SELECT * FROM emprestimo.terminal_login_fim($1::uuid,$2,$3,$4,$5,$6,$7)',
      [c.ini.usuario_id || null, c.ip, tipo, resultado, c.ini.versao ?? null, sidHash, novoHash])).rows[0] || null;
    if (r?.usuario_id && tipo === 'entrar') r.prazo = (await db.query(PRAZO)).rows[0].p;
    return r;
  });
}

router.post('/entrar', E.handle(async (req, res) => {
  // a regravação do hash (custo antigo) usa a mesma vaga da conferência
  const c = await senhas.naVez(async vez => {
    const x = await conferirSenha(req, 'entrar', vez);
    if (x.resultado === 'ok' && senhas.precisaRehash(x.ini.senha_hash)) x.novoHash = await senhas.gerarHash(req.body.senha, vez);
    return x;
  });
  if (c.limite) return res.status(429).json({ ok: false, erro: ERRO_LIMITE });
  let r = null, sid = null;
  if (c.resultado === 'ok') {
    sid = sessao.novoSid();
    await encerrarAtual(req, 'troca');
    r = await concluir(c, 'entrar', 'ok', { sidHash: sessao.sidHash(sid), novoHash: c.novoHash || null });
  } else await concluir(c, 'entrar', c.resultado);
  if (!r?.usuario_id) return res.status(401).json({ ok: false, erro: ERRO_LOGIN });
  const s = sessao.criarSessaoTerminal({ usuarioId: r.usuario_id, versao: r.versao, sid });
  sessao.gravarCookieTerminal(res, s.valor, s.dados.exp);
  res.json({ ok: true, colaborador: colaborador(r), inatividadeSegundos: r.inatividade, expiraEm: r.expira_em, prazoPadraoHoras: r.prazo });
}));

/** Primeiro acesso e redefinição: código do convite + senha nova; a senha fraca é recusada antes de olhar o convite. */
router.post('/primeiro-acesso', E.handle(async (req, res) => {
  const b = req.body || {};
  const fraca = senhas.validarSenha(b.senha, senhas.textoDe(b.matricula));
  if (fraca) return res.status(400).json({ ok: false, erro: fraca });
  // Limite do aparelho ANTES do scrypt (128 MiB): passou dele, 429 sem calcular nada; dentro dele, a tentativa fica
  // reservada (conta no limite mesmo com pedidos simultâneos) e o hash é sempre calculado (mesmo tempo com ou sem
  // convite válido). terminal_primeiro_acesso conclui a reserva. A vaga do scrypt vem antes da reserva (senhas.naVez).
  const ip = ipHash(req);
  const hash = await senhas.naVez(async vez => {
    const livre = await transaction(null, async db => (await db.query('SELECT emprestimo.terminal_reservar_tentativa($1,$2) AS ok', ['primeiro_acesso', ip])).rows[0].ok);
    return livre ? senhas.gerarHash(b.senha, vez) : null;
  });
  if (!hash) return res.status(429).json({ ok: false, erro: ERRO_LIMITE });
  const sid = sessao.novoSid();
  const r = await transaction(null, async db => {
    const x = (await db.query('SELECT * FROM emprestimo.terminal_primeiro_acesso($1,$2,$3,$4,$5)',
      [matriculaDe(b.matricula), senhas.hashCodigo(b.codigo), hash, ip, sessao.sidHash(sid)])).rows[0];
    if (x.situacao === 'ok') x.prazo = (await db.query(PRAZO)).rows[0].p;
    return x;
  });
  if (r.situacao === 'limite_ip') return res.status(429).json({ ok: false, erro: ERRO_LIMITE });
  if (r.situacao !== 'ok') { res.locals.falhaCredencial = true; return res.status(400).json({ ok: false, erro: ERRO_CODIGO }); }   // conta no limite por matrícula (security.js)
  await encerrarAtual(req, 'troca');
  const s = sessao.criarSessaoTerminal({ usuarioId: r.usuario_id, versao: r.versao, sid });
  sessao.gravarCookieTerminal(res, s.valor, s.dados.exp);
  res.json({ ok: true, colaborador: colaborador(r), inatividadeSegundos: r.inatividade, expiraEm: r.expira_em, prazoPadraoHoras: r.prazo });
}));

router.post('/sair', async (req, res) => {
  sessao.limparCookieTerminal(res);   // no tablet compartilhado o cookie sai sempre, mesmo se o banco falhar
  try {
    await encerrarAtual(req, 'logout');
    res.json({ ok: true });
  } catch (error) {
    console.error('[TERMINAL SAIR] não registrou o encerramento:', error.code || error.name);
    res.status(503).json({ ok: false, erro: 'Não foi possível encerrar a sessão no servidor. Ela expira sozinha em instantes.' });
  }
});

/* ---------------------------------------------------------------- saída administrativa do modo tablet */
/** Código do autenticador do site, com a mesma regra do twofa.js: passo novo, gravado de forma atômica (não vale duas vezes). */
async function conferir2fa(usuario, valor) {
  const codigo = senhas.textoDe(valor).replace(/\s/g, '');
  if (!/^\d{6}$/.test(codigo)) return '2fa';
  const s = await transaction(usuario, async db => (await db.query('SELECT app.twofa_estado() AS s')).rows[0]?.s || {});
  if (!s.ativo) return 'sem_2fa';
  const { segredo } = await abrirSegredo2fa(usuario.id, s.segredo);
  const passo = segredo ? totp.verify(segredo, codigo, { lastStep: Number(s.ultimo_passo || 0) }) : null;
  if (passo === null) return '2fa';
  const ok = await transaction(usuario, async db => (await db.query('SELECT app.twofa_registrar_passo($1) AS ok', [passo])).rows[0]?.ok === true);
  return ok ? 'ok' : '2fa';
}
router.post('/saida-admin', E.handle(async (req, res) => {
  const c = await senhas.naVez(vez => conferirSenha(req, 'saida_admin', vez));
  if (c.limite) return res.status(429).json({ ok: false, erro: ERRO_LIMITE });
  let resultado = c.resultado;
  if (resultado === 'ok') resultado = PODE_SAIR.has(c.ini.perfil_id) ? await conferir2fa({ id: c.ini.usuario_id, email: c.ini.email }, req.body?.codigo) : 'perfil';
  const r = await concluir(c, 'saida_admin', resultado);
  if (resultado !== 'ok' || !r?.usuario_id) return res.status(401).json({ ok: false, erro: ERRO_SAIDA });
  // nada de sessão administrativa no tablet: a sessão do terminal aberta neste aparelho também acaba
  await encerrarAtual(req, 'saida_admin');
  sessao.limparCookieTerminal(res);
  res.json({ ok: true, liberado: true });
}));

/* ---------------------------------------------------------------- colaborador logado */
router.use(requireTerminal);

router.get('/eu', E.handle(async (req, res) => {
  const prazo = await transaction(null, async db => (await db.query(PRAZO)).rows[0].p);
  res.json({ ok: true, colaborador: req.terminal.colaborador, inatividadeSegundos: req.terminal.inatividadeSegundos, expiraEm: req.terminal.expiraEm, prazoPadraoHoras: prazo });
}));

router.get('/ferramentas', E.handle(async (req, res) => {
  const rows = await E.emTransacao(req.terminalUser, 'terminal', async db => {
    const lista = await E.buscarFerramentas(db, { q: req.query.q, situacao: 'ativas', categoria: req.query.categoria });
    const ids = lista.filter(f => f.controle === 'individual').map(f => f.id);
    const unidades = ids.length ? (await db.query(`SELECT id, ferramenta_id, identificador FROM emprestimo.ferramenta_unidade
      WHERE ferramenta_id = ANY($1::uuid[]) AND estado = 'disponivel' ORDER BY identificador`, [ids])).rows : [];
    return lista.map(f => ({ id: f.id, codigo: f.codigo, nome: f.nome, descricao: f.descricao, categoria: f.categoria, marca: f.marca, modelo: f.modelo,
      controle: f.controle, localizacao: f.localizacao, conservacao: f.conservacao, saldo: f.saldo, foto: f.foto,
      ...(f.controle === 'individual' ? { unidadesDisponiveis: unidades.filter(u => u.ferramenta_id === f.id).map(u => ({ id: u.id, identificador: u.identificador })) } : {}) }));
  });
  res.json({ ok: true, rows });
}));
// Miniatura (?mini=1) e foto da ferramenta nos cartões do tablet: só leitura, e só de ferramenta ativa (o RLS do canal
// terminal esconde a de inativa: 404). Enviar, trocar e remover a foto é só no painel.
router.get('/ferramentas/:id/foto', E.handle(async (req, res) => {
  await E.enviarFoto(req, res, req.terminalUser, 'terminal');
}));

// Até 200 (os abertos primeiro, depois os fechados do mais novo para o mais antigo); passou disso, "cortado: true" e a tela
// avisa que o histórico mais antigo fica com o almoxarifado (o painel pagina com ?limite= e ?pagina=).
const MAX_MEUS = 200;
router.get('/emprestimos', E.handle(async (req, res) => {
  const abertos = req.query.situacao !== 'todos';
  let cortado = false;
  const rows = await E.emTransacao(req.terminalUser, 'terminal', async db => {
    const lista = await E.listarEmprestimos(db, { colaboradorId: req.terminalUser.id, status: abertos ? 'abertos' : '', limite: MAX_MEUS + 1 });
    if (lista.length > MAX_MEUS) { cortado = true; lista.length = MAX_MEUS; }
    const ids = lista.map(e => e.id);
    const itens = ids.length ? (await db.query(`SELECT i.*, (i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa) AS pendente
      FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = ANY($1::uuid[]) ORDER BY i.codigo`, [ids])).rows : [];
    return lista.map(e => ({ id: e.id, numero: e.numero, status: e.status, criadoEm: e.criadoEm, prazo: e.prazo, encerradoEm: e.encerradoEm,
      atrasado: e.atrasado, pendente: e.pendente, emConferencia: e.emConferencia, itens: e.itens,
      itensLista: itens.filter(i => i.emprestimo_id === e.id).map(i => ({ id: i.id, tipo: i.tipo, codigo: i.codigo, descricao: i.descricao,
        quantidade: Number(i.quantidade), devolvida: Number(i.qtd_devolvida), emConferencia: Number(i.qtd_conferencia), baixa: Number(i.qtd_baixa),
        pendente: E.pendenteItem(e.status, i), unidadeId: i.unidade_id, ferramentaId: i.ferramenta_id })) }));
  });
  res.json({ ok: true, rows, cortado });
}));

router.get('/emprestimos/:id', E.handle(async (req, res) => {
  const eid = E.id(req.params.id);
  const emprestimo = await E.emTransacao(req.terminalUser, 'terminal', async db => {
    const d = await E.detalhe(db, eid);   // o RLS do canal terminal já esconde o que não é dele; a conferência abaixo é a segunda trava
    if (d.colaboradorId !== req.terminalUser.id) throw E.fail(404, 'Empréstimo não encontrado.');
    return d;
  });
  res.json({ ok: true, emprestimo });
}));

router.post('/emprestimos', E.handle(async (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.itens) && b.itens.some(i => i && typeof i === 'object' && (i.materialCodigo != null || !i.ferramentaId))) {
    throw E.fail(400, 'O terminal empresta só ferramentas. Material é retirado no balcão do almoxarifado.');
  }
  const chave = E.texto(b.chave, 80);
  if (!CHAVE.test(chave)) throw E.fail(400, 'Chave de operação inválida.');
  // colaboradorId do corpo é ignorado: no canal terminal o banco registra para quem está logado
  const r = await E.executar(req.terminalUser, 'terminal', 'emprestar', { itens: E.itensEmprestimo(b.itens), chave, observacao: E.texto(b.observacao, 1000) });
  res.status(r.repetido ? 200 : 201).json({ ok: true, ...r });
}));

router.post('/emprestimos/:id/devolucoes', E.handle(async (req, res) => {
  const eid = E.id(req.params.id);
  const b = req.body || {};
  const chave = E.texto(b.chave, 80);
  if (!CHAVE.test(chave)) throw E.fail(400, 'Chave de operação inválida.');
  const itens = E.itensMovimento(b.itens, ['condicao', 'observacao']);
  for (const i of itens) {
    if (!['boa', 'avaria'].includes(i.condicao)) throw E.fail(400, 'Informe a condição da ferramenta: boa ou avaria.');
    if (i.condicao === 'avaria' && String(i.observacao || '').trim().length < 5) throw E.fail(400, 'Descreva a avaria (pelo menos 5 caracteres).');
  }
  const r = await E.emTransacao(req.terminalUser, 'terminal', async db => {
    const dono = (await db.query('SELECT colaborador_id FROM emprestimo.emprestimo WHERE id = $1', [eid])).rows[0];
    if (!dono || dono.colaborador_id !== req.terminalUser.id) throw E.fail(404, 'Empréstimo não encontrado.');
    const material = (await db.query(`SELECT 1 FROM emprestimo.emprestimo_item WHERE emprestimo_id = $1 AND tipo = 'material' AND id::text = ANY($2::text[])`,
      [eid, itens.map(i => i.itemId.toLowerCase())])).rows.length;
    if (material) throw E.fail(400, 'Material é devolvido no balcão do almoxarifado.');
    return (await db.query('SELECT emprestimo.executar($1,$2::jsonb) AS r', ['devolver', JSON.stringify({ emprestimoId: eid, itens, chave })])).rows[0].r;
  });
  res.json({ ok: true, ...r });
}));

module.exports = router;
