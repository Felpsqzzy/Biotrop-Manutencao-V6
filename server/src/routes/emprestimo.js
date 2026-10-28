'use strict';
// Empréstimo de ferramentas e de material (migration 40). Toda escrita passa por emprestimo.executar() no banco, que
// confere perfil e canal, trava as linhas e grava o histórico; esta rota valida a forma da entrada e lê sob RLS.
// O terminal do tablet (fase 4, routes/terminal.js) usa as mesmas funções com o canal 'terminal': lá todo mundo é só
// colaborador. O acesso ao terminal (convite, bloqueio) é administrado aqui, pela gestão (migration 41). Foto opcional
// da ferramenta (migration 43): a gestão envia, troca e remove aqui; o painel e o terminal leem pela rota da imagem.
const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireStepUpAdmin } = require('./twofa');
const { gerarCodigo, hashCodigo } = require('../lib/senha-terminal');
const { fotoDoCorpo } = require('../lib/imagem');

const router = express.Router();
const GESTAO = new Set(['admin', 'gestor', 'almoxarife']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABERTOS = ['em_andamento', 'parcialmente_devolvido', 'aguardando_conferencia'];
const STATUS = new Set([...ABERTOS, 'devolvido', 'encerrado', 'estornado']);
const fail = (status, message) => Object.assign(new Error(message), { status });

function id(v) { if (typeof v !== 'string' || !UUID.test(v)) throw fail(400, 'Identificador inválido.'); return v; }
/** Valor do corpo que o banco confere como texto (quantidade, prazo, total): objeto, lista ou sim/não viram vazio. */
function bruto(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : ''; }
/** Texto de uma linha: sem caracteres de controle (NUL derrubava a consulta) e objeto no lugar de texto vira vazio. */
function texto(v, max) {
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Dia AAAA-MM-DD da query string; objeto (?de[toString]=1) ou lista vira nulo em vez de 500. */
function dia(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; }
function gestao(req) { if (!GESTAO.has(req.user.perfilId)) throw fail(403, 'Somente almoxarifado, gestão e administração.'); }
/** "ativo" estrito: true/false (ou "true"/"false"); ausente ou nulo não mexe. 1, "sim" ou "x" não viram "desativar" calado. */
function ativoDe(p) {
  if (p.ativo == null) { delete p.ativo; return; }
  if (p.ativo !== true && p.ativo !== false && p.ativo !== 'true' && p.ativo !== 'false') throw fail(400, 'Informe se o cadastro fica ativo (true) ou inativo (false).');
  p.ativo = p.ativo === true || p.ativo === 'true';
}
/** Campos de texto do cadastro: texto (ou número, como a matrícula); objeto ou lista não viram texto por conversão. */
function textos(p, campos) {
  for (const k of campos) if (p[k] != null && typeof p[k] !== 'string' && typeof p[k] !== 'number') throw fail(400, 'Dados inválidos: confira os campos de texto.');
}
/** Objeto simples com chaves conhecidas: nada de payload arbitrário chegando à função do banco. */
function so(body, chaves) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Dados inválidos.');
  const out = {};
  for (const k of chaves) if (body[k] !== undefined) out[k] = body[k];
  if (JSON.stringify(out).length > 60000) throw fail(400, 'Dados acima do limite.');
  return out;
}
function lista(v, max) { if (!Array.isArray(v) || !v.length || v.length > max) throw fail(400, `Informe de 1 a ${max} itens.`); return v; }

function handle(fn) {
  return async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store'); await fn(req, res); } catch (e) {
      if (e.status) return res.status(e.status).json({ ok: false, erro: e.message });
      const msg = String(e.message || '').split('\n')[0];
      if (e.code === '42501') return res.status(403).json({ ok: false, erro: msg });
      if (e.code === 'P0002') return res.status(404).json({ ok: false, erro: msg });
      if (e.code === 'P0001') return res.status(409).json({ ok: false, erro: msg });
      if (e.code === '23505') return res.status(409).json({ ok: false, erro: 'Código, patrimônio ou matrícula já cadastrados.' });
      if (e.code === '23503') return res.status(400).json({ ok: false, erro: 'Referência inválida (item, unidade ou pessoa).' });
      if (e.code === '22023') return res.status(400).json({ ok: false, erro: msg });
      if (['22003', '22P02', '22007', '22008', '23514', '23502'].includes(e.code)) return res.status(400).json({ ok: false, erro: 'Dados inválidos: confira código, quantidades, datas e campos obrigatórios.' });
      // NUL (U+0000) que o PostgreSQL não guarda em texto nem em jsonb
      if (e.code === '22021' || e.code === '22P05') return res.status(400).json({ ok: false, erro: 'Texto com caractere inválido.' });
      // impasse ou conflito de serialização com outra operação nas mesmas ferramentas: nada foi gravado (rollback)
      if (e.code === '40P01' || e.code === '40001') return res.status(409).json({ ok: false, erro: 'Outra operação mexeu nos mesmos itens ao mesmo tempo. Tente de novo.' });
      next(e);
    }
  };
}

/** Transação com a identidade da sessão e o canal; o banco decide o que o canal permite. */
function emTransacao(user, canal, fn) {
  return transaction(user, async db => {
    await db.query("SELECT set_config('app.canal', $1, true)", [canal === 'terminal' ? 'terminal' : 'painel']);
    return fn(db);
  });
}
function executar(user, canal, acao, p) {
  return emTransacao(user, canal, async db => (await db.query('SELECT emprestimo.executar($1,$2::jsonb) AS r', [acao, JSON.stringify(p)])).rows[0].r);
}

/* ---------------------------------------------------------------- leituras (RLS decide o que cada um vê) */
const SALDO = `s.total, s.disponivel, s.emprestada, s.em_conferencia, s.manutencao, s.baixada`;
// Foto (migration 43): nas listas vão só o id (versão da URL) e as dimensões; a imagem sai pela rota própria. O RLS do
// canal terminal só mostra a foto de ferramenta ativa.
const FOTO = 'ff.id AS foto_id, ff.largura AS foto_largura, ff.altura AS foto_altura';
const COM_FOTO = 'LEFT JOIN emprestimo.ferramenta_foto ff ON ff.ferramenta_id = f.id';
function ferramentaRow(r) {
  return { id: r.id, codigo: r.codigo, nome: r.nome, descricao: r.descricao, categoria: r.categoria, marca: r.marca, modelo: r.modelo,
    controle: r.controle, localizacao: r.localizacao, conservacao: r.conservacao, ativo: r.ativo, criadoEm: r.criado_em,
    saldo: { total: r.total, disponivel: r.disponivel, emprestada: r.emprestada, emConferencia: r.em_conferencia, manutencao: r.manutencao, baixada: r.baixada },
    foto: r.foto_id ? { id: r.foto_id, largura: r.foto_largura, altura: r.foto_altura } : null };
}
async function buscarFerramentas(db, { q = '', situacao = 'ativas', categoria = '', limite = 200 } = {}) {
  const where = [], args = [];
  if (situacao === 'ativas') where.push('f.ativo'); else if (situacao === 'inativas') where.push('NOT f.ativo');
  const termos = texto(q, 80).toLowerCase().split(' ').filter(Boolean).slice(0, 6);
  for (const t of termos) {
    args.push(`%${t.replace(/[\\%_]/g, m => '\\' + m)}%`);
    where.push(`unaccent(lower(f.codigo || ' ' || f.nome || ' ' || f.descricao || ' ' || f.categoria || ' ' || f.localizacao || ' ' || f.marca || ' ' || f.modelo)) LIKE unaccent($${args.length})`);
  }
  const cat = texto(categoria, 80);
  if (cat) { args.push(cat); where.push(`f.categoria = $${args.length}`); }
  args.push(Math.min(Math.max(Number(limite) || 200, 1), 500));
  const rows = (await db.query(`SELECT f.*, ${SALDO}, ${FOTO} FROM emprestimo.ferramenta f JOIN emprestimo.ferramenta_saldo s ON s.ferramenta_id = f.id ${COM_FOTO}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.nome, f.codigo LIMIT $${args.length}`, args)).rows;
  return rows.map(ferramentaRow);
}
/**
 * Imagem da foto da ferramenta (?mini=1 → miniatura JPEG). Com ?v=<id da foto atual> o navegador guarda por 7 dias
 * (cada envio muda o id e a URL); sem v, ou com um v antigo, ele confere de novo (ETag). Cabeçalhos do catálogo:
 * nosniff, inline e CSP fechada. Quem lê decide o RLS do canal (painel: gestão; terminal: só ferramenta ativa).
 */
async function enviarFoto(req, res, user, canal) {
  const fid = id(req.params.id), mini = req.query.mini === '1';
  const f = await emTransacao(user, canal, async db => (await db.query(`SELECT id, mime, sha256, ${mini ? 'miniatura' : 'imagem'} AS b
    FROM emprestimo.ferramenta_foto WHERE ferramenta_id = $1`, [fid])).rows[0]);
  if (!f) throw fail(404, 'Foto não encontrada.');
  res.set({ 'Content-Type': mini ? 'image/jpeg' : f.mime, 'Cache-Control': String(req.query.v || '') === f.id ? 'private, max-age=604800, immutable' : 'private, no-cache',
    ETag: `"${f.sha256.slice(0, 32)}${mini ? 'm' : ''}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.send(Buffer.isBuffer(f.b) ? f.b : Buffer.from(f.b.buffer, f.b.byteOffset, f.b.byteLength));   // send (e não end): 304 quando o ETag bate
}
function emprestimoRow(r) {
  const pendente = Number(r.pendente || 0);
  return { id: r.id, numero: r.numero, colaboradorId: r.colaborador_id, matricula: r.matricula, setor: r.setor, centroCusto: r.centro_custo,
    atendenteId: r.atendente_id, origem: r.origem, finalidade: r.finalidade, finalidadeRef: r.finalidade_ref, prazo: r.prazo, observacao: r.observacao,
    status: r.status, criadoEm: r.criado_em, encerradoEm: r.encerrado_em, pendente, emConferencia: Number(r.em_conferencia || 0),
    atrasado: ABERTOS.includes(r.status) && pendente > 0 && new Date(r.prazo) < new Date(), itens: Number(r.itens || 0) };
}
// Estornado não tem nada pendente: o estorno devolve o saldo sem mexer nas quantidades do item (ver pendenteItem).
const RESUMO = `CASE WHEN e.status = 'estornado' THEN 0 ELSE (SELECT coalesce(sum(i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa), 0)
    FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = e.id) END AS pendente,
  (SELECT coalesce(sum(i.qtd_conferencia), 0) FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = e.id) AS em_conferencia,
  (SELECT count(*) FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = e.id) AS itens`;
/**
 * Lista com filtros. "Atrasado" = aberto, prazo vencido e COM pendência (a mesma regra da linha, do Resumo e dos e-mails:
 * o que voltou inteiro e espera conferência não é atraso). Período (de/ate) pelo dia de Brasília, não pelo fuso da
 * sessão do banco (UTC): a retirada das 22:30 fica no próprio dia. Ordem: abertos primeiro (prazo mais próximo), depois
 * os fechados do mais novo para o mais antigo. limite de 1 a 500 (padrão 200) e pagina (1, 2...) para trazer tudo.
 */
async function listarEmprestimos(db, f = {}) {
  const where = [], args = [];
  const aberto = `e.status IN ('${ABERTOS.join("','")}')`;
  if (f.colaboradorId) { args.push(f.colaboradorId); where.push(`e.colaborador_id = $${args.length}`); }
  // ferramenta exata (Relatórios): o q é busca por trecho e FER-0001 traria também FER-0001-B
  if (f.ferramentaId) { args.push(f.ferramentaId); where.push(`EXISTS (SELECT 1 FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = e.id AND i.ferramenta_id = $${args.length})`); }
  if (f.status === 'abertos') where.push(aberto);
  else if (f.status && STATUS.has(f.status)) { args.push(f.status); where.push(`e.status = $${args.length}`); }
  if (f.atrasados) where.push(`${aberto} AND e.prazo < now() AND EXISTS (SELECT 1 FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = e.id
    AND i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa > 0)`);
  if (f.de) { args.push(f.de); where.push(`e.criado_em >= ($${args.length}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`); }
  if (f.ate) { args.push(f.ate); where.push(`e.criado_em < ($${args.length}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`); }
  for (const k of ['setor', 'centroCusto']) { const v = texto(f[k], 120); if (v) { args.push(v); where.push(`e.${k === 'centroCusto' ? 'centro_custo' : k} = $${args.length}`); } }
  const mat = texto(f.matricula, 120);
  if (mat) { args.push(mat); where.push(`upper(e.matricula) = upper($${args.length})`); }   // matrícula sem diferenciar maiúsculas (como no cadastro)
  const q = texto(f.q, 60).toLowerCase();
  if (q) { args.push(`%${q.replace(/[\\%_]/g, m => '\\' + m)}%`); where.push(`(lower(e.numero) LIKE $${args.length} OR EXISTS (SELECT 1 FROM emprestimo.emprestimo_item i WHERE i.emprestimo_id = e.id AND lower(i.codigo || ' ' || i.descricao) LIKE $${args.length}))`); }
  const limite = Math.min(Math.max(Number.parseInt(bruto(f.limite), 10) || 200, 1), 500);   // bruto: objeto na query string não vira 500
  const pagina = Math.min(Math.max(Number.parseInt(bruto(f.pagina), 10) || 1, 1), 2000);
  args.push(limite, (pagina - 1) * limite);
  const rows = (await db.query(`SELECT e.*, ${RESUMO} FROM emprestimo.emprestimo e ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (${aberto}) DESC, CASE WHEN ${aberto} THEN e.prazo END, e.criado_em DESC, e.id LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
  return rows.map(emprestimoRow);
}
/** Pendente do item para a tela: quantidade − conferência − devolvida − baixa; 0 no estornado (nada ficou com a pessoa). */
const pendenteItem = (statusEmprestimo, i) => (statusEmprestimo === 'estornado' ? 0 : Number(i.pendente));
async function nomes(db, ids) {
  const u = [...new Set(ids.filter(Boolean))];
  if (!u.length) return {};
  return Object.fromEntries((await db.query('SELECT id, nome FROM emprestimo.nomes($1::uuid[])', [u])).rows.map(r => [r.id, r.nome]));
}
async function detalhe(db, emprestimoId) {
  const e = (await db.query(`SELECT e.*, ${RESUMO} FROM emprestimo.emprestimo e WHERE e.id = $1`, [emprestimoId])).rows[0];
  if (!e) throw fail(404, 'Empréstimo não encontrado.');
  const itens = (await db.query(`SELECT i.*, (i.quantidade - i.qtd_conferencia - i.qtd_devolvida - i.qtd_baixa) AS pendente FROM emprestimo.emprestimo_item i
    WHERE i.emprestimo_id = $1 ORDER BY i.codigo`, [emprestimoId])).rows;
  const eventos = (await db.query('SELECT * FROM emprestimo.emprestimo_evento WHERE emprestimo_id = $1 ORDER BY em, id', [emprestimoId])).rows;
  const n = await nomes(db, [e.colaborador_id, e.atendente_id, ...eventos.map(v => v.por)]);
  return { ...emprestimoRow(e), colaboradorNome: n[e.colaborador_id] || '', atendenteNome: n[e.atendente_id] || '',
    itensLista: itens.map(i => ({ id: i.id, tipo: i.tipo, ferramentaId: i.ferramenta_id, unidadeId: i.unidade_id, materialCodigo: i.material_codigo,
      codigo: i.codigo, descricao: i.descricao, quantidade: Number(i.quantidade), emConferencia: Number(i.qtd_conferencia), devolvida: Number(i.qtd_devolvida),
      baixa: Number(i.qtd_baixa), pendente: pendenteItem(e.status, i), numeroBaixa: i.numero_baixa })),
    eventos: eventos.map(v => ({ id: v.id, itemId: v.item_id, tipo: v.tipo, quantidade: v.quantidade == null ? null : Number(v.quantidade), condicao: v.condicao,
      justificativa: v.justificativa, por: n[v.por] || '', em: v.em })) };
}

/* ---------------------------------------------------------------- rotas do painel (site principal) */
router.use(requireAuth);

router.get('/ferramentas', handle(async (req, res) => {
  gestao(req);
  const situacao = ['ativas', 'inativas', 'todas'].includes(req.query.situacao) ? req.query.situacao : 'ativas';
  const rows = await emTransacao(req.user, 'painel', db => buscarFerramentas(db, { q: req.query.q, situacao, categoria: req.query.categoria }));
  res.json({ ok: true, rows });
}));
router.get('/ferramentas/:id', handle(async (req, res) => {
  gestao(req);
  const fid = id(req.params.id);
  const out = await emTransacao(req.user, 'painel', async db => {
    const f = (await db.query(`SELECT f.*, ${SALDO}, ${FOTO}, octet_length(ff.imagem) AS foto_tamanho, ff.enviada_em AS foto_em, ff.enviada_por AS foto_por
      FROM emprestimo.ferramenta f JOIN emprestimo.ferramenta_saldo s ON s.ferramenta_id = f.id ${COM_FOTO} WHERE f.id = $1`, [fid])).rows[0];
    if (!f) throw fail(404, 'Ferramenta não encontrada.');
    const unidades = (await db.query('SELECT id, identificador, estado FROM emprestimo.ferramenta_unidade WHERE ferramenta_id = $1 ORDER BY identificador', [fid])).rows;
    const auditoria = (await db.query('SELECT tipo, detalhe, por, em FROM emprestimo.auditoria WHERE ferramenta_id = $1 ORDER BY em DESC LIMIT 200', [fid])).rows;
    const movimentos = (await db.query(`SELECT v.tipo, v.quantidade, v.condicao, v.justificativa, v.por, v.em, e.numero, e.colaborador_id
      FROM emprestimo.emprestimo_evento v JOIN emprestimo.emprestimo_item i ON i.id = v.item_id JOIN emprestimo.emprestimo e ON e.id = v.emprestimo_id
      WHERE i.ferramenta_id = $1 ORDER BY v.em DESC LIMIT 200`, [fid])).rows;
    const n = await nomes(db, [...auditoria.map(a => a.por), ...movimentos.map(m => m.por), ...movimentos.map(m => m.colaborador_id), f.foto_por]);
    const linha = ferramentaRow(f);
    if (linha.foto) Object.assign(linha.foto, { tamanho: Number(f.foto_tamanho || 0), enviadaEm: f.foto_em, enviadaPor: n[f.foto_por] || '' });
    return { ...linha, unidades,
      historico: [...auditoria.map(a => ({ tipo: a.tipo, detalhe: a.detalhe, por: n[a.por] || '', em: a.em })),
        ...movimentos.map(m => ({ tipo: m.tipo, quantidade: m.quantidade == null ? null : Number(m.quantidade), condicao: m.condicao, justificativa: m.justificativa,
          emprestimo: m.numero, colaborador: n[m.colaborador_id] || '', por: n[m.por] || '', em: m.em }))].sort((a, b) => new Date(b.em) - new Date(a.em)) };
  });
  res.json({ ok: true, ferramenta: out });
}));
const SALDO_AJUSTE = 'O ajuste deixaria o saldo negativo: confira o disponível e a manutenção na ficha.';
const CAMPOS_FERRAMENTA = ['codigo', 'nome', 'descricao', 'categoria', 'marca', 'modelo', 'controle', 'localizacao', 'conservacao', 'total', 'unidades', 'ativo'];
// Cadastro e edição de ferramenta, ajuste de saldo, configuração e administração de usuários (abaixo) pedem 2FA recente.
// Incluir unidade (patrimônio) e a foto ficaram fora do portão (revisão de 2026-10-27).
const stepUpGestao = requireStepUpAdmin(GESTAO);
router.post('/ferramentas', stepUpGestao, handle(async (req, res) => {
  gestao(req);
  const p = so(req.body, CAMPOS_FERRAMENTA); delete p.ativo;
  textos(p, ['codigo', 'nome', 'descricao', 'categoria', 'marca', 'modelo', 'controle', 'localizacao', 'conservacao']);
  if (p.total != null) p.total = bruto(p.total);   // cada patrimônio de "unidades" é conferido no banco (texto)
  res.status(201).json({ ok: true, ...await executar(req.user, 'painel', 'ferramenta_salvar', p) });
}));
router.put('/ferramentas/:id', stepUpGestao, handle(async (req, res) => {
  gestao(req);
  const p = so(req.body, ['nome', 'descricao', 'categoria', 'marca', 'modelo', 'localizacao', 'conservacao', 'ativo']);
  textos(p, ['nome', 'descricao', 'categoria', 'marca', 'modelo', 'localizacao', 'conservacao']);
  ativoDe(p);
  res.json({ ok: true, ...await executar(req.user, 'painel', 'ferramenta_salvar', { ...p, id: id(req.params.id) }) });
}));
router.post('/ferramentas/:id/unidades', handle(async (req, res) => {
  gestao(req);
  const ident = texto(req.body?.identificador, 81);   // 81 para recusar (não cortar calado) o que passa de 80, como o cadastro da ferramenta
  if (!ident) throw fail(400, 'Informe o patrimônio ou a série.');
  if (ident.length > 80) throw fail(400, 'Patrimônio ou série com mais de 80 caracteres.');
  res.status(201).json({ ok: true, ...await executar(req.user, 'painel', 'unidade_adicionar', { ferramentaId: id(req.params.id), identificador: ident }) });
}));
router.post('/ferramentas/:id/ajustes', stepUpGestao, handle(async (req, res) => {
  gestao(req);
  const p = so(req.body, ['movimento', 'quantidade', 'justificativa', 'unidadeId', 'de', 'chave']);
  if (p.quantidade != null) p.quantidade = bruto(p.quantidade);
  if (p.chave != null) p.chave = texto(p.chave, 80);   // opcional: com ela, reenviar o mesmo ajuste não ajusta de novo
  try {
    res.json({ ok: true, ...await executar(req.user, 'painel', 'ajustar', { ...p, ferramentaId: id(req.params.id) }) });
  } catch (e) {
    // o CHECK do saldo (nada negativo): a tela confere antes, então isto é outra pessoa mexendo no mesmo saldo ao mesmo tempo
    if (e.code === '23514') throw fail(400, SALDO_AJUSTE);
    throw e;
  }
}));
// Foto opcional (uma por ferramenta): enviar e trocar são o mesmo PUT; o tipo é conferido pelos bytes aqui e de novo no
// banco (emprestimo.ferramenta_foto_salvar, só a gestão, com auditoria). Só pelo painel: a API do terminal não grava foto.
router.put('/ferramentas/:id/foto', handle(async (req, res) => {
  gestao(req);
  const fid = id(req.params.id);
  const foto = fotoDoCorpo(req.body);
  const r = await emTransacao(req.user, 'painel', async db => (await db.query('SELECT * FROM emprestimo.ferramenta_foto_salvar($1::uuid,$2,$3,$4,$5,$6)',
    [fid, foto.mime, foto.b, foto.mini, foto.largura, foto.altura])).rows[0]);
  res.json({ ok: true, trocada: r.trocada, foto: { id: r.foto_id, largura: r.foto_largura, altura: r.foto_altura, tamanho: r.foto_tamanho, enviadaEm: r.foto_em } });
}));
router.delete('/ferramentas/:id/foto', handle(async (req, res) => {
  gestao(req);
  const fid = id(req.params.id);
  await emTransacao(req.user, 'painel', db => db.query('SELECT emprestimo.ferramenta_foto_remover($1::uuid)', [fid]));
  res.json({ ok: true });
}));
router.get('/ferramentas/:id/foto', handle(async (req, res) => {
  gestao(req);
  await enviarFoto(req, res, req.user, 'painel');
}));

/** Situação do acesso ao terminal (nunca hash, código ou senha): sem_acesso, convite_pendente, ativo, bloqueado, bloqueado_temporario. */
function acessoRow(a) {
  return { situacao: a?.situacao || 'sem_acesso', ultimoAcesso: a?.ultimo_acesso || null, conviteExpiraEm: a?.convite_expira_em || null };
}
router.get('/colaboradores', handle(async (req, res) => {
  gestao(req);
  const rows = await emTransacao(req.user, 'painel', async db => {
    const acessos = new Map((await db.query('SELECT * FROM emprestimo.terminal_acessos()')).rows.map(a => [a.usuario_id, a]));
    return (await db.query('SELECT * FROM emprestimo.colaboradores()')).rows.map(r => ({ ...r, acesso: acessos.get(r.usuario_id) }));
  });
  const q = texto(req.query.q, 60).toLowerCase();
  res.json({ ok: true, rows: rows.filter(r => !q || `${r.nome} ${r.email} ${r.matricula} ${r.setor}`.toLowerCase().includes(q)).map(r => ({
    usuarioId: r.usuario_id, nome: r.nome, email: r.email, perfil: r.perfil_id, matricula: r.matricula, setor: r.setor, centroCusto: r.centro_custo,
    cargo: r.cargo, ativo: r.ativo, bloqueado: r.bloqueado, criadoEm: r.criado_em, acesso: acessoRow(r.acesso) })) });
}));
// Cadastro de colaborador, convite de acesso ao terminal e liberação do acesso são administração de usuários: 2FA recente.
// Bloquear não pede: é a reação a um problema e precisa ser imediata. stepUpGestao fica lá em cima, junto do cadastro.
function stepUpParaLiberar(req, res, next) { return req.body?.bloqueado === false ? stepUpGestao(req, res, next) : next(); }
router.post('/colaboradores', stepUpGestao, handle(async (req, res) => {
  gestao(req);
  const p = so(req.body, ['nome', 'email', 'matricula', 'setor', 'centroCusto', 'cargo', 'ativo']);
  textos(p, ['nome', 'email', 'matricula', 'setor', 'centroCusto', 'cargo']);
  ativoDe(p);   // sem "ativo", editar mantém a situação (o banco só assume ativo no cadastro novo)
  res.json({ ok: true, ...await executar(req.user, 'painel', 'colaborador_salvar', p) });
}));
// Convite de primeiro acesso / redefinição: o código sai UMA vez, nesta resposta (o banco guarda só o HMAC). Conta de
// admin/gestor só pela gerência, colaborador inativo não recebe — regras no banco (emprestimo.terminal_convite_gerar).
router.post('/colaboradores/:usuarioId/convite', stepUpGestao, handle(async (req, res) => {
  gestao(req);
  const alvo = id(req.params.usuarioId);
  const codigo = gerarCodigo();
  const r = await emTransacao(req.user, 'painel', async db => (await db.query('SELECT * FROM emprestimo.terminal_convite_gerar($1::uuid,$2)', [alvo, hashCodigo(codigo)])).rows[0]);
  res.status(201).json({ ok: true, codigo, expiraEm: r.expira_em, redefinicao: r.redefinicao });
}));
// Bloqueio/desbloqueio do acesso ao terminal (desbloquear também zera o bloqueio temporário por erros), com justificativa.
router.post('/colaboradores/:usuarioId/acesso', stepUpParaLiberar, handle(async (req, res) => {
  gestao(req);
  const alvo = id(req.params.usuarioId);
  if (typeof req.body?.bloqueado !== 'boolean') throw fail(400, 'Informe se o acesso fica bloqueado (true) ou liberado (false).');
  const r = await emTransacao(req.user, 'painel', async db => (await db.query('SELECT * FROM emprestimo.terminal_acesso_definir($1::uuid,$2,$3)',
    [alvo, req.body.bloqueado, texto(req.body.justificativa, 500)])).rows[0]);
  res.json({ ok: true, acesso: acessoRow(r) });
}));

router.get('/emprestimos', handle(async (req, res) => {
  gestao(req);
  const qs = req.query;
  // limite (até 500) e pagina: o relatório do período pede página a página até vir menos que o limite
  const filtro = { status: texto(qs.status, 30), atrasados: qs.atrasados === '1', q: qs.q, setor: qs.setor, centroCusto: qs.centroCusto, matricula: qs.matricula,
    colaboradorId: qs.colaborador ? id(qs.colaborador) : null, ferramentaId: qs.ferramenta ? id(qs.ferramenta) : null, de: dia(qs.de), ate: dia(qs.ate),
    limite: qs.limite, pagina: qs.pagina };
  const rows = await emTransacao(req.user, 'painel', async db => {
    const r = await listarEmprestimos(db, filtro);
    const n = await nomes(db, r.flatMap(x => [x.colaboradorId, x.atendenteId]));
    return r.map(x => ({ ...x, colaboradorNome: n[x.colaboradorId] || '', atendenteNome: n[x.atendenteId] || '' }));
  });
  res.json({ ok: true, rows });
}));
router.get('/emprestimos/:id', handle(async (req, res) => {
  gestao(req);
  res.json({ ok: true, emprestimo: await emTransacao(req.user, 'painel', db => detalhe(db, id(req.params.id))) });
}));
function itensEmprestimo(v) {
  return lista(v, 30).map(i => {
    if (!i || typeof i !== 'object') throw fail(400, 'Item inválido.');
    const o = { quantidade: bruto(i.quantidade) };
    if (i.ferramentaId) { o.ferramentaId = id(i.ferramentaId); if (i.unidadeId) o.unidadeId = id(i.unidadeId); }
    else if (i.materialCodigo) o.materialCodigo = texto(i.materialCodigo, 40).toUpperCase();
    else throw fail(400, 'Cada item precisa de uma ferramenta ou de um código de material.');
    return o;
  });
}
router.post('/emprestimos', handle(async (req, res) => {
  gestao(req);
  const b = req.body || {};
  const p = { colaboradorId: id(b.colaboradorId), itens: itensEmprestimo(b.itens), chave: texto(b.chave, 80), finalidade: texto(b.finalidade, 20) || 'manutencao',
    finalidadeRef: texto(b.finalidadeRef, 60), observacao: texto(b.observacao, 1000) };
  if (b.prazo) p.prazo = bruto(b.prazo);
  const r = await executar(req.user, 'painel', 'emprestar', p);
  res.status(r.repetido ? 200 : 201).json({ ok: true, ...r });
}));
function itensMovimento(v, campos) {
  return lista(v, 30).map(i => { const o = { itemId: id(i?.itemId), quantidade: bruto(i?.quantidade) }; for (const c of campos) if (i[c] != null) o[c] = texto(i[c], 1000); return o; });
}
/** Chave de operação opcional do painel (devolução, conferência, baixa): com ela, o reenvio devolve o primeiro resultado. */
function comChave(p, b) { if (b?.chave != null) p.chave = texto(b.chave, 80); return p; }
router.post('/emprestimos/:id/devolucoes', handle(async (req, res) => {
  gestao(req);
  const p = comChave({ emprestimoId: id(req.params.id), itens: itensMovimento(req.body?.itens, ['condicao', 'observacao']) }, req.body);
  res.json({ ok: true, ...await executar(req.user, 'painel', 'devolver', p) });
}));
router.post('/emprestimos/:id/conferencias', handle(async (req, res) => {
  gestao(req);
  const p = comChave({ emprestimoId: id(req.params.id), itens: itensMovimento(req.body?.itens, ['resultado', 'observacao']) }, req.body);
  res.json({ ok: true, ...await executar(req.user, 'painel', 'conferir', p) });
}));
router.post('/emprestimos/:id/baixas', handle(async (req, res) => {
  gestao(req);
  const b = req.body || {};
  const p = comChave({ emprestimoId: id(req.params.id), itemId: id(b.itemId), quantidade: bruto(b.quantidade),
    motivo: texto(b.motivo, 20), justificativa: texto(b.justificativa, 1000), numeroBaixa: texto(b.numeroBaixa, 60) }, b);
  res.json({ ok: true, ...await executar(req.user, 'painel', 'baixar', p) });
}));
router.post('/emprestimos/:id/prazo', handle(async (req, res) => {
  gestao(req);
  res.json({ ok: true, ...await executar(req.user, 'painel', 'prazo', { emprestimoId: id(req.params.id), prazo: bruto(req.body?.prazo), justificativa: texto(req.body?.justificativa, 1000) }) });
}));
router.post('/emprestimos/:id/estorno', handle(async (req, res) => {
  gestao(req);
  res.json({ ok: true, ...await executar(req.user, 'painel', 'estornar', { emprestimoId: id(req.params.id), justificativa: texto(req.body?.justificativa, 1000) }) });
}));

router.get('/config', handle(async (req, res) => {
  gestao(req);
  const c = await emTransacao(req.user, 'painel', async db => (await db.query('SELECT * FROM emprestimo.config WHERE id')).rows[0]);
  res.json({ ok: true, config: { prazoPadraoHoras: c.prazo_padrao_horas, lembreteAntesHoras: c.lembrete_antes_horas, atrasoIntervaloHoras: c.atraso_intervalo_horas,
    inatividadeSegundos: c.inatividade_segundos, atualizadoEm: c.atualizado_em } });
}));
router.put('/config', stepUpGestao, handle(async (req, res) => {
  gestao(req);
  const p = so(req.body, ['prazoPadraoHoras', 'lembreteAntesHoras', 'atrasoIntervaloHoras', 'inatividadeSegundos']);
  // número inteiro ou texto só com dígitos: true, [5], null, "1e1" ou "0x10" não viram horas por conversão
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (!((typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && /^\s*\d{1,6}\s*$/.test(v)))) throw fail(400, 'Valores em horas/segundos inteiros.');
    p[k] = Number(v);
  }
  res.json({ ok: true, config: await executar(req.user, 'painel', 'config_salvar', p) });
}));

module.exports = router;
// Reaproveitado pela API do terminal (fase 4): mesmas leituras e escrita, com o canal 'terminal'.
module.exports._lib = { emTransacao, executar, buscarFerramentas, listarEmprestimos, detalhe, pendenteItem, itensEmprestimo, itensMovimento, enviarFoto, handle, fail, id, texto };
