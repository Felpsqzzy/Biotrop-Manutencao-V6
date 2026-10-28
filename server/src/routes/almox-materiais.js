const express = require('express');
const crypto = require('node:crypto');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireStepUpAdmin } = require('./twofa');

/*
 * Almoxarifado · Itens do estoque (migrations 25 e 27).
 *
 *   GET    /                       lista com filtros: ?q=&prefixo=MAN&tipo=&statusMe=&armazenagem=&familia=&situacao=ativos|inativos|todos
 *                                  &foto=1&ordem=codigo|descricao|preco|atualizado&dir=asc|desc&pagina=1 (50 por página)
 *   GET    /facetas                contagens para os filtros (categorias pelo prefixo do código, tipo, status ME, armazenagem…)
 *   GET    /resumo?codigos=A,B     dados curtos de vários códigos (cartão do item nos pedidos)
 *   GET    /:codigo                item completo + fotos
 *   GET    /:codigo/fotos/:id      imagem (?mini=1 → miniatura)
 *   PUT    /:codigo                almoxarifado edita o item (campos do site + família e atributos)
 *   POST   /importar               planilha em partes de até 2.000 linhas; só as colunas enviadas são gravadas
 *   POST   /:codigo/fotos · POST /:codigo/fotos/:id/capa · DELETE /:codigo/fotos/:id
 * As policies das migrations repetem as mesmas regras no banco.
 */
const router = express.Router();
const LEITURA = new Set(['admin', 'gestor', 'pcm', 'almoxarife', 'lider', 'tecnico']);
const ESCRITA = new Set(['admin', 'gestor', 'almoxarife']);
const POR_PAGINA = 50;
const MAX_LINHAS = 2000;
const MAX_FOTOS = 8;
const CODIGO = /^[A-Z0-9][A-Z0-9._/"-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

/* Campos do item: nome na API → coluna, tipo e tamanho. Uma tabela só para importar, editar e devolver. */
const CAMPOS = {
  descricao: { col: 'descricao', max: 500 }, unidade: { col: 'unidade', max: 20, upper: true }, grupo: { col: 'grupo', max: 120 },
  marca: { col: 'marca', max: 120 }, localizacao: { col: 'localizacao', max: 120 }, observacao: { col: 'observacao', max: 2000 },
  nomePesquisa: { col: 'nome_pesquisa', max: 120 }, tipo: { col: 'tipo', max: 40 }, subtipo: { col: 'subtipo', max: 40 },
  statusMe: { col: 'status_me', max: 40 }, sped: { col: 'sped', max: 40 }, armazenagem: { col: 'armazenagem', max: 40 },
  fornecedor: { col: 'fornecedor', max: 120 }, familia: { col: 'familia_id', max: 80 }, fabricante: { col: 'fabricante', max: 120 },
  referencia: { col: 'referencia', max: 120 }, aplicacao: { col: 'aplicacao', max: 500 }, ncm: { col: 'ncm', max: 12, ncm: true },
  criticidade: { col: 'criticidade', max: 1, upper: true, lista: ['', 'A', 'B', 'C'] },
  preco: { col: 'preco', num: true, casas: 4 }, precoData: { col: 'preco_data', data: true },
  estoqueMinimo: { col: 'estoque_minimo', num: true, casas: 3 }, estoqueMaximo: { col: 'estoque_maximo', num: true, casas: 3 },
  pontoPedido: { col: 'ponto_pedido', num: true, casas: 3 }, prazoDias: { col: 'prazo_dias', int: true, maxN: 3650 },
  ativo: { col: 'ativo', bool: true }, atributos: { col: 'atributos', json: true },
  // ficha do item (migration 30): texto com quebra de linha preservada
  descricaoLonga: { col: 'descricao_longa', max: 4000, multi: true }, marcasHomologadas: { col: 'marcas_homologadas', max: 500 },
  pontosRecebimento: { col: 'pontos_recebimento', max: 2000, multi: true },
  // "Estado do ciclo de vida do produto" do Dynamics (Produto Ativo, Inativo, Phase Out, em Cadastro…)
  cicloVida: { col: 'ciclo_vida', max: 60 }
};
const BUSCA_CAMPOS = ['codigo', 'descricao', 'nomePesquisa', 'marca', 'grupo', 'localizacao', 'fabricante', 'referencia', 'aplicacao', 'fornecedor', 'marcasHomologadas', 'descricaoLonga'];
// lista: o que a tabela mostra (ficha resumida, como o almoxarifado pediu) — a descrição longa vai cortada
const LISTA_COLS = `codigo,descricao,unidade,grupo,marca,localizacao,ativo,fotos,foto_capa,prefixo,tipo,status_me,armazenagem,familia_id,preco,estoque_minimo,criticidade,atualizado_em,
  left(descricao_longa, 220) AS descricao_longa_resumo, marcas_homologadas, (pontos_recebimento <> '') AS tem_recebimento, ciclo_vida`;
// "falta na ficha": filtros para o almoxarifado completar o cadastro
const FICHA = { sem_longa: "descricao_longa = ''", sem_foto: 'fotos = 0', sem_marcas: "marcas_homologadas = ''", sem_receb: "pontos_recebimento = ''", sem_unidade: "unidade = ''" };
const ORDENS = { codigo: 'codigo', descricao: 'descricao', preco: 'preco', atualizado: 'atualizado_em', estoque: 'estoque_minimo' };

router.use(requireAuth);
// Catálogo de itens é cadastro: toda escrita (importar, editar, fotos) pede 2FA recente; leitura não (o middleware ignora GET).
router.use(requireStepUpAdmin(ESCRITA));

function clean(v, max = 300) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function fail(status, message) { return Object.assign(new Error(message), { status, userMessage: message }); }
function codigo(v) { const c = clean(v, 60).toUpperCase().replace(/\s+/g, ''); return CODIGO.test(c) ? c : null; }
function semAcento(v) { return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function tsquery(q) {
  const t = semAcento(q).split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);
  return t.length ? t.map(x => `${x}:*`).join(' & ') : null;
}
function leitura(req) { if (!LEITURA.has(req.user.perfilId)) throw fail(403, 'Seu perfil não acessa os itens do estoque.'); }
function escrita(req) { if (!ESCRITA.has(req.user.perfilId)) throw fail(403, 'Só o almoxarifado, a gestão ou a administração altera os itens do estoque.'); }
function quem(req) { return clean(req.user.nome || req.user.email, 160); }
function handle(fn) {
  return async (req, res, next) => {
    try { await fn(req, res); } catch (error) {
      if (error.status && error.userMessage) return res.status(error.status).json({ ok: false, erro: error.userMessage });
      if (error.code === '42501') return res.status(403).json({ ok: false, erro: 'Seu perfil não pode fazer esta alteração.' });
      if (error.code === '23505') return res.status(409).json({ ok: false, erro: 'Esta foto já está no item.' });
      if (error.code === '23514' || error.code === '22003') return res.status(400).json({ ok: false, erro: 'Algum valor está fora do permitido (número, tamanho ou formato).' });
      next(error);
    }
  };
}
const num = v => (v == null ? null : Number(v));
function expor(r) {
  const o = { codigo: r.codigo, descricao: r.descricao, unidade: r.unidade, grupo: r.grupo, marca: r.marca, localizacao: r.localizacao, ativo: r.ativo,
    fotos: Number(r.fotos || 0), capa: r.foto_capa || null, prefixo: r.prefixo, tipo: r.tipo, statusMe: r.status_me, armazenagem: r.armazenagem,
    familia: r.familia_id, preco: num(r.preco), estoqueMinimo: num(r.estoque_minimo), criticidade: r.criticidade, atualizadoEm: r.atualizado_em,
    cicloVida: r.ciclo_vida || '', marcasHomologadas: r.marcas_homologadas || '' };
  if ('descricao_longa_resumo' in r) Object.assign(o, { descricaoLongaResumo: r.descricao_longa_resumo || '', temRecebimento: r.tem_recebimento === true });
  if ('observacao' in r) Object.assign(o, { observacao: r.observacao, nomePesquisa: r.nome_pesquisa, subtipo: r.subtipo, sped: r.sped, fornecedor: r.fornecedor,
    atributos: r.atributos || {}, precoData: r.preco_data ? (r.preco_data instanceof Date ? r.preco_data.toISOString().slice(0, 10) : String(r.preco_data).slice(0, 10)) : null,
    estoqueMaximo: num(r.estoque_maximo), pontoPedido: num(r.ponto_pedido), prazoDias: num(r.prazo_dias), fabricante: r.fabricante, referencia: r.referencia,
    aplicacao: r.aplicacao, ncm: r.ncm, atualizadoPor: r.atualizado_por_nome,
    descricaoLonga: r.descricao_longa || '', marcasHomologadas: r.marcas_homologadas || '', pontosRecebimento: r.pontos_recebimento || '' });
  return o;
}

/** Valida um valor do campo; devolve { v } ou { erro }. */
function valor(nome, bruto) {
  const d = CAMPOS[nome];
  if (d.bool) return { v: !(bruto === false || bruto === 'false' || bruto === 0 || bruto === '0') };
  if (d.json) {
    if (bruto == null || bruto === '') return { v: {} };
    if (typeof bruto !== 'object' || Array.isArray(bruto)) return { erro: 'atributos inválidos' };
    const o = {};
    for (const [k, x] of Object.entries(bruto).slice(0, 60)) { const kk = clean(k, 80); if (kk) o[kk] = clean(x, 300); }
    return { v: o };
  }
  if (d.num || d.int) {
    if (bruto == null || String(bruto).trim() === '') return { v: null };
    let t = String(bruto).trim().replace(/^R\$\s*/i, '');
    if (/,\d{1,4}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');   // 1.234,56 → 1234.56
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 1e10) return { erro: `${nome} inválido` };
    if (d.int) { if (!Number.isInteger(n) || n > d.maxN) return { erro: `${nome} inválido` }; return { v: n }; }
    return { v: Math.round(n * 10 ** d.casas) / 10 ** d.casas };
  }
  if (d.data) {
    if (!bruto) return { v: null };
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(bruto)) || /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(bruto));
    if (!m) return { erro: 'data inválida' };
    const iso = m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
    return Number.isFinite(Date.parse(iso)) ? { v: iso } : { erro: 'data inválida' };
  }
  let s = d.multi ? String(bruto ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, d.max) : clean(bruto, d.max);
  if (d.upper) s = s.toUpperCase();
  if (d.ncm) { s = s.replace(/[^0-9.]/g, ''); }
  if (d.lista && !d.lista.includes(s)) return { erro: `${nome} inválido` };
  return { v: s };
}
function buscaTexto(m) { return semAcento(BUSCA_CAMPOS.map(k => m[k] || '').join(' ')).replace(/[^a-z0-9]+/g, ' ').trim(); }

/* ---------------------------------------------------------------- leitura */
function filtros(qs) {
  const where = [], args = [];
  const sit = String(qs.situacao || (qs.inativos === '1' ? 'todos' : 'ativos'));
  if (sit === 'ativos') where.push('ativo'); else if (sit === 'inativos') where.push('NOT ativo');
  const q = clean(qs.q, 120), tq = tsquery(q), cod = codigo(q);
  if (q && !tq) where.push('false');
  if (tq) {
    args.push(tq); const iq = args.length;
    if (cod) { args.push(`${cod}%`); where.push(`(busca @@ to_tsquery('simple', $${iq}) OR codigo LIKE $${args.length})`); }
    else where.push(`busca @@ to_tsquery('simple', $${iq})`);
  }
  for (const [p, col] of [['prefixo', 'prefixo'], ['tipo', 'tipo'], ['statusMe', 'status_me'], ['armazenagem', 'armazenagem'], ['familia', 'familia_id'], ['grupo', 'grupo'], ['criticidade', 'criticidade']]) {
    if (qs[p] == null || qs[p] === '') continue;
    const v = qs[p] === '(vazio)' ? '' : clean(qs[p], 120);
    args.push(v); where.push(`${col} = $${args.length}`);
  }
  if (qs.foto === '1') where.push('fotos > 0');
  if (qs.foto === '0') where.push('fotos = 0');
  if (qs.preco === '1') where.push('preco IS NOT NULL');
  if (FICHA[qs.ficha]) where.push(FICHA[qs.ficha]);
  return { where, args, cod };
}

router.get('/', handle(async (req, res) => {
  leitura(req);
  const { where, args, cod } = filtros(req.query);
  const pagina = Math.max(1, Math.min(2000, Number.parseInt(req.query.pagina, 10) || 1));
  const filtro = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const col = ORDENS[req.query.ordem] || null;
  const ordArgs = cod ? [...args, cod, `${cod}%`] : args;
  // código exato e começo do código primeiro; depois a coluna escolhida
  const ordem = [cod ? `(codigo = $${args.length + 1}) DESC, (codigo LIKE $${args.length + 2}) DESC` : null, col ? `${col} ${dir} NULLS LAST` : 'descricao', 'codigo'].filter(Boolean).join(', ');
  const data = await transaction(req.user, async db => {
    const total = Number((await db.query(`SELECT count(*) AS n FROM almox.material ${filtro}`, args)).rows[0].n);
    const rows = (await db.query(`SELECT ${LISTA_COLS} FROM almox.material ${filtro} ORDER BY ${ordem} LIMIT ${POR_PAGINA} OFFSET ${(pagina - 1) * POR_PAGINA}`, ordArgs)).rows;
    return { total, rows };
  });
  res.set('Cache-Control', 'no-store').json({ ok: true, rows: data.rows.map(expor), total: data.total, pagina, porPagina: POR_PAGINA, paginas: Math.max(1, Math.ceil(data.total / POR_PAGINA)) });
}));

/** Contagens dos filtros, já respeitando a busca e a situação (ativos/inativos). */
router.get('/facetas', handle(async (req, res) => {
  leitura(req);
  const base = filtros({ q: req.query.q, situacao: req.query.situacao });
  const filtro = base.where.length ? `WHERE ${base.where.join(' AND ')}` : '';
  const out = await transaction(req.user, async db => {
    const conta = async col => (await db.query(`SELECT ${col} AS v, count(*) AS n FROM almox.material ${filtro} GROUP BY 1 ORDER BY 2 DESC LIMIT 80`, base.args)).rows
      .map(r => ({ v: r.v == null ? '' : String(r.v), n: Number(r.n) }));
    const t = (await db.query(`SELECT count(*) FILTER (WHERE ativo) AS ativos, count(*) FILTER (WHERE NOT ativo) AS inativos, count(*) AS todos,
      count(*) FILTER (WHERE fotos > 0) AS com_foto, count(*) FILTER (WHERE preco IS NOT NULL) AS com_preco,
      count(*) FILTER (WHERE ativo AND descricao_longa <> '') AS com_longa, count(*) FILTER (WHERE ativo AND marcas_homologadas <> '') AS com_marcas,
      count(*) FILTER (WHERE ativo AND pontos_recebimento <> '') AS com_receb, count(*) FILTER (WHERE ativo AND unidade <> '') AS com_unidade,
      count(*) FILTER (WHERE ativo AND fotos > 0) AS ativos_com_foto FROM almox.material`)).rows[0];
    return { prefixo: await conta('prefixo'), tipo: await conta('tipo'), statusMe: await conta('status_me'), armazenagem: await conta('armazenagem'),
      familia: await conta('familia_id'), criticidade: await conta('criticidade'), grupo: await conta('grupo'),
      totais: { ativos: Number(t.ativos), inativos: Number(t.inativos), todos: Number(t.todos), comFoto: Number(t.com_foto), comPreco: Number(t.com_preco),
        ficha: { longa: Number(t.com_longa), marcas: Number(t.com_marcas), receb: Number(t.com_receb), unidade: Number(t.com_unidade), foto: Number(t.ativos_com_foto) } } };
  });
  res.set('Cache-Control', 'no-store').json({ ok: true, ...out });
}));
// compatibilidade com a tela anterior
router.get('/grupos', handle(async (req, res) => {
  leitura(req);
  const r = await transaction(req.user, async db => ({
    g: (await db.query("SELECT grupo, count(*) AS n FROM almox.material WHERE ativo AND grupo <> '' GROUP BY grupo ORDER BY 2 DESC LIMIT 300")).rows,
    t: (await db.query('SELECT count(*) FILTER (WHERE ativo) AS ativos, count(*) AS todos, count(*) FILTER (WHERE fotos > 0 AND ativo) AS com_foto FROM almox.material')).rows[0]
  }));
  res.set('Cache-Control', 'no-store').json({ ok: true, grupos: r.g.map(x => ({ grupo: x.grupo, n: Number(x.n) })), totais: { ativos: Number(r.t.ativos), todos: Number(r.t.todos), comFoto: Number(r.t.com_foto) } });
}));

router.get('/resumo', handle(async (req, res) => {
  leitura(req);
  const codigos = [...new Set(String(req.query.codigos || '').split(',').map(codigo).filter(Boolean))].slice(0, 100);
  if (!codigos.length) return res.json({ ok: true, itens: {} });
  const rows = (await transaction(req.user, db => db.query(`SELECT ${LISTA_COLS} FROM almox.material WHERE codigo = ANY($1::text[])`, [codigos]))).rows;
  res.set('Cache-Control', 'no-store').json({ ok: true, itens: Object.fromEntries(rows.map(r => [r.codigo, expor(r)])) });
}));

router.get('/:codigo', handle(async (req, res) => {
  leitura(req);
  const c = codigo(req.params.codigo);
  if (!c) throw fail(400, 'Código inválido.');
  const data = await transaction(req.user, async db => {
    const item = (await db.query('SELECT *, NULL AS busca FROM almox.material WHERE codigo=$1', [c])).rows[0];
    if (!item) throw fail(404, `O item ${c} não está no estoque.`);
    const fotos = (await db.query(`SELECT id, mime, largura, altura, octet_length(imagem) AS tamanho, enviado_por_nome, criado_em
      FROM almox.material_foto WHERE codigo=$1 ORDER BY posicao, criado_em`, [c])).rows;
    return { item, fotos };
  });
  res.set('Cache-Control', 'no-store').json({ ok: true, item: expor(data.item), podeEditar: ESCRITA.has(req.user.perfilId),
    fotos: data.fotos.map(f => ({ id: f.id, mime: f.mime, largura: f.largura, altura: f.altura, tamanho: Number(f.tamanho), enviadoPor: f.enviado_por_nome, em: f.criado_em })) });
}));

router.get('/:codigo/fotos/:id', handle(async (req, res) => {
  leitura(req);
  const c = codigo(req.params.codigo), id = String(req.params.id || '');
  if (!c || !UUID.test(id)) throw fail(400, 'Foto inválida.');
  const mini = req.query.mini === '1';
  const f = (await transaction(req.user, db => db.query(`SELECT mime, ${mini ? 'miniatura' : 'imagem'} AS b, sha256 FROM almox.material_foto WHERE id=$1 AND codigo=$2`, [id, c]))).rows[0];
  if (!f) throw fail(404, 'Foto não encontrada.');
  res.set({ 'Content-Type': mini ? 'image/jpeg' : f.mime, 'Cache-Control': 'private, max-age=604800, immutable', ETag: `"${f.sha256.slice(0, 32)}${mini ? 'm' : ''}"`,
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.end(f.b);
}));

/* ---------------------------------------------------------------- escrita */
/** Linha da planilha/edição → { m (só os campos informados), erro }. */
function linhaValida(l, campos) {
  const c = codigo(l && l.codigo);
  if (!c) return { erro: 'código inválido' };
  const m = { codigo: c };
  for (const k of campos) {
    if (!Object.hasOwn(CAMPOS, k)) continue;   // 'in' aceitaria __proto__, constructor, toString...
    const r = valor(k, l[k]);
    if (r.erro) return { erro: r.erro };
    m[k] = r.v;
  }
  if ('descricao' in m && !m.descricao) return { erro: 'sem descrição' };
  return { m };
}

router.post('/importar', handle(async (req, res) => {
  escrita(req);
  const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : null;
  if (!linhas || !linhas.length || linhas.length > MAX_LINHAS) throw fail(400, `Envie de 1 a ${MAX_LINHAS} linhas por vez.`);
  // colunas desta importação: só elas são gravadas (o que o site preencheu e a planilha não traz fica como está)
  const pedidos = Array.isArray(req.body?.campos) ? req.body.campos.filter(k => Object.hasOwn(CAMPOS, k) && k !== 'atributos') : ['descricao', 'unidade', 'grupo', 'marca', 'localizacao'];
  const campos = [...new Set(['descricao', ...pedidos])];
  const recusadas = [], validas = new Map();
  linhas.forEach((l, i) => {
    const r = linhaValida(l, campos);
    if (r.erro) recusadas.push({ linha: Number(l?.linha) || i + 1, codigo: clean(l?.codigo, 40), erro: r.erro });
    else validas.set(r.m.codigo, r.m);
  });
  const nome = quem(req), lista = [...validas.values()];
  const result = await transaction(req.user, async db => {
    let novos = 0, atualizados = 0;
    if (lista.length) {
      // busca_texto: junta o que veio com o que já está no banco (campos que esta planilha não traz)
      const atuais = new Map((await db.query(`SELECT codigo, descricao, nome_pesquisa, marca, grupo, localizacao, fabricante, referencia, aplicacao, fornecedor,
        marcas_homologadas, descricao_longa FROM almox.material WHERE codigo = ANY($1::text[])`, [lista.map(m => m.codigo)])).rows.map(r => [r.codigo, r]));
      for (const m of lista) {
        const a = atuais.get(m.codigo) || {};
        const junto = { codigo: m.codigo, descricao: m.descricao ?? a.descricao, nomePesquisa: m.nomePesquisa ?? a.nome_pesquisa, marca: m.marca ?? a.marca, grupo: m.grupo ?? a.grupo,
          localizacao: m.localizacao ?? a.localizacao, fabricante: m.fabricante ?? a.fabricante, referencia: m.referencia ?? a.referencia, aplicacao: m.aplicacao ?? a.aplicacao, fornecedor: m.fornecedor ?? a.fornecedor,
          marcasHomologadas: m.marcasHomologadas ?? a.marcas_homologadas, descricaoLonga: m.descricaoLonga ?? a.descricao_longa };
        m._busca = buscaTexto(junto);
      }
      const cols = campos.map(k => CAMPOS[k].col);
      const def = campos.map(k => `${CAMPOS[k].col} ${CAMPOS[k].num ? 'numeric' : CAMPOS[k].int ? 'smallint' : CAMPOS[k].bool ? 'boolean' : CAMPOS[k].data ? 'date' : 'text'}`).join(', ');
      const dados = lista.map(m => { const o = { codigo: m.codigo, _busca: m._busca }; campos.forEach(k => { o[CAMPOS[k].col] = m[k]; }); return o; });
      const r = await db.query(`INSERT INTO almox.material (codigo, ${cols.join(', ')}, busca_texto, atualizado_por_nome)
        SELECT x.codigo, ${cols.map(c => `x.${c}`).join(', ')}, x._busca, $2
          FROM jsonb_to_recordset($1::jsonb) AS x(codigo text, _busca text, ${def})
        ON CONFLICT (codigo) DO UPDATE SET ${cols.map(c => `${c}=EXCLUDED.${c}`).join(', ')}, busca_texto=EXCLUDED.busca_texto, atualizado_em=now(), atualizado_por_nome=EXCLUDED.atualizado_por_nome
        RETURNING (xmax = 0) AS novo`, [JSON.stringify(dados), nome]);
      novos = r.rows.filter(x => x.novo).length; atualizados = r.rowCount - novos;
    }
    if (req.body?.ultimaParte !== false) {
      await db.query(`INSERT INTO almox.material_carga (arquivo, linhas, novos, atualizados, recusados, por, por_nome) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [clean(req.body?.arquivo, 200), Number(req.body?.totalLinhas) || linhas.length, Number(req.body?.totalNovos ?? 0) + novos,
          Number(req.body?.totalAtualizados ?? 0) + atualizados, Number(req.body?.totalRecusados ?? 0) + recusadas.length, req.user.id, nome]);
    }
    return { novos, atualizados };
  });
  res.json({ ok: true, ...result, recusadas: recusadas.slice(0, 200), totalRecusadas: recusadas.length });
}));

router.put('/:codigo', handle(async (req, res) => {
  escrita(req);
  const c = codigo(req.params.codigo);
  if (!c) throw fail(400, 'Código inválido.');
  const campos = Object.keys(req.body || {}).filter(k => Object.hasOwn(CAMPOS, k));
  if (!campos.length) throw fail(400, 'Nada para salvar.');
  const r = linhaValida({ ...req.body, codigo: c }, campos);
  if (r.erro) throw fail(400, `Item inválido: ${r.erro}.`);
  const row = await transaction(req.user, async db => {
    const atual = (await db.query('SELECT * FROM almox.material WHERE codigo=$1 FOR UPDATE', [c])).rows[0];
    if (!atual) throw fail(404, `O item ${c} não está no estoque.`);
    const junto = {};
    for (const k of BUSCA_CAMPOS) junto[k] = k in r.m ? r.m[k] : (k === 'codigo' ? c : atual[CAMPOS[k] ? CAMPOS[k].col : k]);
    const sets = campos.map((k, i) => `${CAMPOS[k].col}=$${i + 2}${CAMPOS[k].json ? '::jsonb' : ''}`);
    const vals = campos.map(k => (CAMPOS[k].json ? JSON.stringify(r.m[k]) : r.m[k]));
    return (await db.query(`UPDATE almox.material SET ${sets.join(', ')}, busca_texto=$${campos.length + 2}, atualizado_em=now(), atualizado_por_nome=$${campos.length + 3}
      WHERE codigo=$1 RETURNING *, NULL AS busca`, [c, ...vals, buscaTexto(junto), quem(req)])).rows[0];
  });
  res.json({ ok: true, item: expor(row) });
}));

/** data:image/...;base64 → Buffer, conferindo o tipo pelo começo do arquivo (não pelo que o navegador diz). */
function imagem(dataUrl, max, rotulo) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw fail(400, `${rotulo} em formato inválido (use JPG, PNG ou WEBP).`);
  const b = Buffer.from(m[2], 'base64');
  if (b.length < 100 || b.length > max) throw fail(400, `${rotulo} grande demais.`);
  const assinatura = MIME[m[1]];
  if (!assinatura.every((x, i) => b[i] === x) || (m[1] === 'image/webp' && b.subarray(8, 12).toString('latin1') !== 'WEBP')) {
    throw fail(400, `${rotulo}: o conteúdo não é a imagem que diz ser.`);
  }
  return { mime: m[1], b };
}

router.post('/:codigo/fotos', handle(async (req, res) => {
  escrita(req);
  const c = codigo(req.params.codigo);
  if (!c) throw fail(400, 'Código inválido.');
  const img = imagem(req.body?.imagem, 1200000, 'Foto');   // ~1,6 MB em base64: cabe no limite de 2 MB do corpo
  const mini = imagem(req.body?.miniatura, 80000, 'Miniatura');
  if (mini.mime !== 'image/jpeg') throw fail(400, 'Miniatura precisa ser JPG.');
  const largura = Math.max(0, Math.min(10000, Number.parseInt(req.body?.largura, 10) || 0));
  const altura = Math.max(0, Math.min(10000, Number.parseInt(req.body?.altura, 10) || 0));
  const sha = crypto.createHash('sha256').update(img.b).digest('hex');
  const foto = await transaction(req.user, async db => {
    const item = (await db.query('SELECT codigo FROM almox.material WHERE codigo=$1 FOR UPDATE', [c])).rows[0];
    if (!item) throw fail(404, `O item ${c} não está no estoque.`);
    const n = Number((await db.query('SELECT count(*) AS n FROM almox.material_foto WHERE codigo=$1', [c])).rows[0].n);
    if (n >= MAX_FOTOS) throw fail(400, `Cada item aceita até ${MAX_FOTOS} fotos. Apague uma antes.`);
    const f = (await db.query(`INSERT INTO almox.material_foto (codigo, mime, imagem, miniatura, largura, altura, sha256, posicao, enviado_por, enviado_por_nome)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [c, img.mime, img.b, mini.b, largura, altura, sha, n, req.user.id, quem(req)])).rows[0];
    await db.query(`UPDATE almox.material SET fotos=$2, foto_capa=coalesce(foto_capa, $3), atualizado_em=now(), atualizado_por_nome=$4 WHERE codigo=$1`,
      [c, n + 1, f.id, quem(req)]);
    return f;
  });
  res.status(201).json({ ok: true, id: foto.id });
}));

router.post('/:codigo/fotos/:id/capa', handle(async (req, res) => {
  escrita(req);
  const c = codigo(req.params.codigo), id = String(req.params.id || '');
  if (!c || !UUID.test(id)) throw fail(400, 'Foto inválida.');
  const r = await transaction(req.user, db => db.query(`UPDATE almox.material SET foto_capa=$2, atualizado_em=now()
    WHERE codigo=$1 AND EXISTS (SELECT 1 FROM almox.material_foto WHERE id=$2 AND codigo=$1)`, [c, id]));
  if (!r.rowCount) throw fail(404, 'Foto não encontrada.');
  res.json({ ok: true });
}));

router.delete('/:codigo/fotos/:id', handle(async (req, res) => {
  escrita(req);
  const c = codigo(req.params.codigo), id = String(req.params.id || '');
  if (!c || !UUID.test(id)) throw fail(400, 'Foto inválida.');
  await transaction(req.user, async db => {
    const r = await db.query('DELETE FROM almox.material_foto WHERE id=$1 AND codigo=$2', [id, c]);
    if (!r.rowCount) throw fail(404, 'Foto não encontrada.');
    await db.query(`UPDATE almox.material m SET fotos=(SELECT count(*) FROM almox.material_foto f WHERE f.codigo=m.codigo),
      foto_capa=CASE WHEN foto_capa=$2 THEN (SELECT f.id FROM almox.material_foto f WHERE f.codigo=m.codigo ORDER BY posicao, criado_em LIMIT 1) ELSE foto_capa END,
      atualizado_em=now() WHERE codigo=$1`, [c, id]);
  });
  res.json({ ok: true });
}));

module.exports = router;
module.exports._test = { codigo, semAcento, buscaTexto, tsquery, imagem, valor, CAMPOS };
