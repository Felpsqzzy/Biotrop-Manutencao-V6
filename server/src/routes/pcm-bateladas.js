const express = require('express');
const { transaction } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requireStepUpAdmin } = require('./twofa');
const C = require('./bateladas-calculo');

/*
 * PCM · Bateladas (migration 32) — substitui o Forms + planilha "CONTROLE DE BATELADAS".
 * O técnico de turno aponta, 1x por dia, o contador acumulado do supervisório de cada tanque; o sistema calcula
 * bateladas por dia/semana/mês, bateladas desde a última preventiva (registro/histórico ou FOLHA DE DIAFRAGMAS
 * concluída), faixas de cor e programação. Quem apontou vem da SESSÃO. Cada dia alterado entra na fila do
 * SharePoint (worker-sharepoint.js).
 *
 *   GET  /painel · GET /apontamento?data= · PUT /apontamento · GET /historico?de=&ate=
 *   POST /preventivas · DELETE /preventivas/:id · PUT /programacao/:ativoId
 *   POST /importar (histórico da planilha) · GET /sharepoint (situação da fila)
 *   GET /extras (gás/diafragma por tanque e preventivas dos EBAs) · PUT /tarefas · PUT /eba · DELETE /eba/:id   (migration 38)
 */
const router = express.Router();
const GESTAO = new Set(['admin', 'gestor', 'pcm']);
const EQUIPE = new Set(['admin', 'gestor', 'pcm', 'lider', 'tecnico']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SALTO_MAXIMO = 10;   // mais de 10 bateladas num único apontamento é quase sempre erro de digitação

router.use(requireAuth);

function fail(status, message) { return Object.assign(new Error(message), { status, userMessage: message }); }
function data(v) {
  const s = String(v || '');
  if (!DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}
function isoDay(v) {
  if (!v) return null;
  if (!(v instanceof Date)) return String(v).slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}
function hojeLocal() { return isoDay(new Date()); }
function clean(v, max = 300) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function gestao(u) { return GESTAO.has(u.perfilId); }
function exigirEquipe(req) { if (!EQUIPE.has(req.user.perfilId)) throw fail(403, 'O controle de bateladas é da equipe de manutenção.'); }
function exigirGestao(req) { if (!gestao(req.user)) throw fail(403, 'Somente o PCM, a gestão ou a administração alteram isto.'); }
function responder(res, next) {
  return error => {
    if (error.status) return res.status(error.status).json({ ok: false, erro: error.userMessage || error.message });
    next(error);
  };
}

async function carregar(db) {
  const [ativos, leituras, preventivas, folhas, programacao, config, dias] = await Promise.all([
    db.query(`SELECT id, codigo, nome, local FROM pcm.ativo WHERE ativo AND codigo ~ '^(FTD|PGD|BLD)[0-9]{2}$' ORDER BY CASE left(codigo,3) WHEN 'PGD' THEN 1 WHEN 'FTD' THEN 2 ELSE 3 END, codigo`),
    db.query('SELECT ativo_id, data, acumulado, origem, registrado_por_nome FROM pcm.batelada_leitura'),
    db.query('SELECT id, ativo_id, data, exata, origem, observacao, registrado_em FROM pcm.batelada_preventiva'),
    // folha de diafragmas concluída = preventiva realizada (data de execução dos itens; sem ela, a da conclusão)
    db.query(`SELECT p.id, p.ativo_id, coalesce((SELECT max(i.data_execucao) FROM pcm.preventiva_item i WHERE i.preventiva_id = p.id), p.concluida_em::date) AS data,
        p.concluida_em AS registrado_em
      FROM pcm.preventiva p WHERE p.status = 'concluida'`),
    db.query('SELECT * FROM pcm.batelada_programacao'),
    db.query('SELECT tipo, frequencia, faixa_atencao, faixa_alerta FROM pcm.batelada_config'),
    db.query('SELECT data, registrado_por_nome, registrado_em, origem FROM pcm.batelada_dia WHERE data >= current_date - 60 ORDER BY data DESC')
  ]);
  const d = r => r.rows.map(x => ({ ...x, data: isoDay(x.data), inicio: isoDay(x.inicio), fim: isoDay(x.fim) }));
  return { ativos: ativos.rows, leituras: d(leituras), preventivas: d(preventivas), folhas: d(folhas), programacao: d(programacao),
    config: config.rows, dias: d(dias) };
}

async function montar(req, hoje) {
  const base = await transaction(req.user, carregar);
  return { base, painel: C.calcularPainel({ ...base, hoje }) };
}

router.get('/painel', async (req, res, next) => {
  try {
    exigirEquipe(req);
    const hoje = data(req.query.hoje) || hojeLocal();
    const { base, painel } = await montar(req, hoje);
    const ultimoDia = base.dias[0] || null;
    res.set('Cache-Control', 'no-store').json({ ok: true, ...painel, podeGerir: gestao(req.user),
      coleta: { ultimoDia: ultimoDia ? { data: ultimoDia.data, por: ultimoDia.registrado_por_nome, em: ultimoDia.registrado_em } : null,
        diasApontados: base.dias.map(x => x.data) } });
  } catch (e) { responder(res, next)(e); }
});

/**
 * Estado do dia para a tela de apontamento: contador em vigor em cada tanque (o do dia, se alguém já apontou, ou o
 * anterior), quem apontou, o próximo apontamento (limite de cima), as bateladas dos últimos 7 dias (minigráfico),
 * quem já apontou no dia e as correções do PCM. A tela pede de novo a cada ~20 s: várias pessoas apontam juntas.
 */
async function estadoDoDia(db, dia) {
  const ativos = (await db.query(`SELECT id, codigo, nome FROM pcm.ativo WHERE ativo AND codigo ~ '^(FTD|PGD|BLD)[0-9]{2}$'
    ORDER BY CASE left(codigo,3) WHEN 'PGD' THEN 1 WHEN 'FTD' THEN 2 ELSE 3 END, codigo`)).rows;
  const leituras = (await db.query(`SELECT DISTINCT ON (ativo_id, grupo) ativo_id, grupo, data, acumulado, registrado_por_nome, registrado_em FROM (
      SELECT *, CASE WHEN data < $1 THEN 'antes' WHEN data = $1 THEN 'dia' ELSE 'depois' END AS grupo FROM pcm.batelada_leitura) x
    ORDER BY ativo_id, grupo, CASE WHEN grupo = 'depois' THEN data END ASC, CASE WHEN grupo <> 'depois' THEN data END DESC`, [dia])).rows;
  // últimos 8 dias de contador (para as bateladas de cada um dos últimos 7) + o que valia antes deles
  const semana = (await db.query(`SELECT ativo_id, data, acumulado FROM pcm.batelada_leitura WHERE data BETWEEN $1::date - 8 AND $1::date ORDER BY data`, [dia])).rows;
  const base = (await db.query(`SELECT DISTINCT ON (ativo_id) ativo_id, acumulado FROM pcm.batelada_leitura WHERE data < $1::date - 8 ORDER BY ativo_id, data DESC`, [dia])).rows;
  const pessoas = (await db.query(`SELECT registrado_por_nome AS nome, count(*)::int AS tanques, max(registrado_em) AS em FROM pcm.batelada_leitura
    WHERE data = $1 AND origem = 'site' GROUP BY 1 ORDER BY max(registrado_em)`, [dia])).rows;
  const correcoes = (await db.query(`SELECT c.id, a.codigo, c.de, c.para, c.motivo, c.por_nome, c.em FROM pcm.batelada_correcao c JOIN pcm.ativo a ON a.id = c.ativo_id
    WHERE c.data = $1 ORDER BY c.em DESC LIMIT 100`, [dia])).rows;
  const diaInfo = (await db.query('SELECT registrado_por_nome, registrado_em, origem FROM pcm.batelada_dia WHERE data=$1', [dia])).rows[0] || null;
  const por = new Map();
  for (const r of leituras) { if (!por.has(r.ativo_id)) por.set(r.ativo_id, {}); por.get(r.ativo_id)[r.grupo] = r; }
  const listas = new Map(ativos.map(a => [a.id, []]));
  for (const b of base) listas.get(b.ativo_id)?.push({ data: '0000-01-01', acumulado: Number(b.acumulado) });
  for (const s of semana) listas.get(s.ativo_id)?.push({ data: isoDay(s.data), acumulado: Number(s.acumulado) });
  return {
    data: dia, hoje: hojeLocal(),
    apontadoPor: diaInfo ? { nome: diaInfo.registrado_por_nome, em: diaInfo.registrado_em, origem: diaInfo.origem } : null,
    pessoas: pessoas.map(p => ({ nome: p.nome, tanques: p.tanques, em: p.em })),
    correcoes: correcoes.map(c => ({ id: c.id, codigo: c.codigo, de: c.de, para: c.para, motivo: c.motivo, por: c.por_nome, em: c.em })),
    tanques: ativos.map(a => {
      const g = por.get(a.id) || {}, lista = listas.get(a.id) || [];
      const anterior = g.antes ? Number(g.antes.acumulado) : 0;
      const ult7 = [];
      for (let k = 6; k >= 0; k--) { const d = C.somaDias(dia, -k); ult7.push(Math.max(0, C.valorEm(lista, d) - C.valorEm(lista, C.somaDias(d, -1)))); }
      return { id: a.id, codigo: a.codigo, nome: a.nome, tipo: C.tipoDe(a.codigo),
        anterior, anteriorEm: g.antes ? isoDay(g.antes.data) : null,
        noDia: g.dia ? Number(g.dia.acumulado) : null, noDiaPor: g.dia ? g.dia.registrado_por_nome : '', noDiaEm: g.dia ? g.dia.registrado_em : null,
        proximo: g.depois ? Number(g.depois.acumulado) : null, proximoEm: g.depois ? isoDay(g.depois.data) : null, ult7 };
    })
  };
}

router.get('/apontamento', async (req, res, next) => {
  try {
    exigirEquipe(req);
    const dia = data(req.query.data) || hojeLocal();
    const out = await transaction(req.user, db => estadoDoDia(db, dia));
    res.set('Cache-Control', 'no-store').json({ ok: true, ...out, podeCorrigir: gestao(req.user) });
  } catch (e) { responder(res, next)(e); }
});

/**
 * Salva o apontamento: só os tanques que a pessoa mudou; quem apontou vem da sessão.
 *   • equipe: o contador só AUMENTA — nunca abaixo do que já está em vigor no dia (inclusive o que outra pessoa
 *     apontou minutos antes), nunca acima do apontamento seguinte, nunca mais de 10 de uma vez;
 *   • PCM/gestão/admin: pode diminuir ou fugir das travas, com justificativa (fica em pcm.batelada_correcao).
 * Valor igual ao que já está em vigor não grava nada. Responde com o estado novo do dia.
 */
router.put('/apontamento', async (req, res, next) => {
  try {
    exigirEquipe(req);
    const dia = data(req.body?.data);
    const hoje = hojeLocal(), pode = gestao(req.user);
    if (!dia) throw fail(400, 'Data inválida.');
    if (dia > hoje) throw fail(400, 'Não é possível apontar um dia que ainda não chegou.');
    if (!pode && C.diasEntre(dia, hoje) > 7) throw fail(403, 'Apontamentos com mais de 7 dias só pelo PCM.');
    const valores = Array.isArray(req.body?.valores) ? req.body.valores : [];
    if (valores.length > 60) throw fail(400, 'Apontamento grande demais.');
    const geral = clean(req.body?.justificativa, 500);
    const limpos = [];
    for (const v of valores) {
      const id = String(v?.ativoId || ''), n = Number(v?.acumulado);
      if (!UUID.test(id) || !Number.isInteger(n) || n < 0 || n > 1000000) throw fail(400, 'Valor de contador inválido.');
      limpos.push({ id, n, motivo: clean(v?.motivo, 500) || geral });
    }
    const nome = req.user.nome || req.user.email;
    const out = await transaction(req.user, async db => {
      let salvos = 0, corrigidos = 0;
      for (const { id, n, motivo } of limpos) {
        const viz = (await db.query(`SELECT
            (SELECT acumulado FROM pcm.batelada_leitura WHERE ativo_id=$1 AND data < $2 ORDER BY data DESC LIMIT 1) AS antes,
            (SELECT acumulado FROM pcm.batelada_leitura WHERE ativo_id=$1 AND data = $2) AS no_dia,
            (SELECT registrado_por_nome || ' às ' || to_char(registrado_em AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') FROM pcm.batelada_leitura WHERE ativo_id=$1 AND data = $2) AS quem,
            (SELECT acumulado FROM pcm.batelada_leitura WHERE ativo_id=$1 AND data > $2 ORDER BY data ASC LIMIT 1) AS depois,
            (SELECT codigo FROM pcm.ativo WHERE id=$1) AS codigo`, [id, dia])).rows[0];
        if (!viz.codigo) throw fail(400, 'Tanque não encontrado.');
        const rot = viz.codigo.replace(/^BLD/, 'BLR').replace(/(\D)(\d)/, '$1 $2');
        const antes = viz.antes == null ? 0 : Number(viz.antes), atual = viz.no_dia == null ? antes : Number(viz.no_dia);
        if (n === atual) continue;   // nada mudou
        const fora = n < atual || (viz.depois != null && n > Number(viz.depois)) || n - antes > SALTO_MAXIMO;
        if (fora && !pode) {
          if (n < atual) throw fail(409, `${rot}: o contador só aumenta. Ele já está em ${atual}${viz.quem ? ` (apontado por ${viz.quem})` : ''}. Se o número está errado, peça ao PCM para corrigir.`);
          if (viz.depois != null && n > Number(viz.depois)) throw fail(400, `${rot}: o contador não pode passar do apontamento seguinte (${viz.depois}).`);
          throw fail(400, `${rot}: ${n - antes} bateladas de uma vez parece erro de digitação (máximo ${SALTO_MAXIMO}). Confira o supervisório ou peça ao PCM.`);
        }
        if (fora && motivo.length < 5) throw fail(400, `${rot}: para ${n < atual ? 'diminuir' : 'corrigir fora das travas'} escreva a justificativa (o que estava errado).`);
        await db.query(`INSERT INTO pcm.batelada_leitura (ativo_id, data, acumulado, origem, registrado_por, registrado_por_nome)
          VALUES ($1,$2,$3,'site',$4,$5)
          ON CONFLICT (ativo_id, data) DO UPDATE SET acumulado=excluded.acumulado, origem='site', registrado_por=excluded.registrado_por,
            registrado_por_nome=excluded.registrado_por_nome, registrado_em=now()`, [id, dia, n, req.user.id, nome]);
        if (fora) {
          await db.query(`INSERT INTO pcm.batelada_correcao (ativo_id, data, de, para, motivo, por, por_nome) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, dia, atual, n, motivo, req.user.id, nome]);
          corrigidos++;
        }
        salvos++;
      }
      await db.query(`INSERT INTO pcm.batelada_dia (data, registrado_por, registrado_por_nome, origem) VALUES ($1,$2,$3,'site')
        ON CONFLICT (data) DO UPDATE SET registrado_por=excluded.registrado_por, registrado_por_nome=excluded.registrado_por_nome, registrado_em=now(), origem='site'`,
        [dia, req.user.id, nome]);
      return { salvos, corrigidos, estado: await estadoDoDia(db, dia) };
    });
    res.json({ ok: true, salvos: out.salvos, corrigidos: out.corrigidos, data: dia, ...out.estado, podeCorrigir: pode });
  } catch (e) { responder(res, next)(e); }
});

// Cadastro e exclusão (preventiva realizada, marca de EBA, carga da planilha) são ações administrativas: 2FA recente.
// Programação, gás/diafragma (PUT /tarefas) e marcar a preventiva do EBA (PUT /eba) são o planejamento do dia a dia
// do PCM: ficam sem o código, como o apontamento.
const stepUpGestao = requireStepUpAdmin(GESTAO);

/** Preventiva realizada (registro manual ou transcrição do calendário). */
router.post('/preventivas', stepUpGestao, async (req, res, next) => {
  try {
    exigirGestao(req);
    const id = String(req.body?.ativoId || ''), dia = data(req.body?.data);
    if (!UUID.test(id) || !dia) throw fail(400, 'Informe o tanque e a data da preventiva.');
    if (dia > hojeLocal()) throw fail(400, 'A data da preventiva não pode estar no futuro — para isso use a programação.');
    await transaction(req.user, db => db.query(`INSERT INTO pcm.batelada_preventiva (ativo_id, data, exata, origem, observacao, registrado_por, registrado_por_nome)
      VALUES ($1,$2,true,'site',$3,$4,$5) ON CONFLICT (ativo_id, data) DO UPDATE SET exata=true, observacao=excluded.observacao,
      registrado_por=excluded.registrado_por, registrado_por_nome=excluded.registrado_por_nome, registrado_em=now()`,
      [id, dia, clean(req.body?.observacao, 500), req.user.id, req.user.nome || req.user.email]));
    res.status(201).json({ ok: true });
  } catch (e) { responder(res, next)(e); }
});
router.delete('/preventivas/:id', stepUpGestao, async (req, res, next) => {
  try {
    exigirGestao(req);
    if (!UUID.test(req.params.id)) throw fail(400, 'Registro inválido.');
    const n = await transaction(req.user, async db => (await db.query('DELETE FROM pcm.batelada_preventiva WHERE id=$1', [req.params.id])).rowCount);
    if (!n) throw fail(404, 'Registro não encontrado.');
    res.json({ ok: true });
  } catch (e) { responder(res, next)(e); }
});

/** Programação da fermentação (previsão da próxima preventiva). */
router.put('/programacao/:ativoId', async (req, res, next) => {
  try {
    exigirGestao(req);
    const id = req.params.ativoId;
    if (!UUID.test(id)) throw fail(400, 'Tanque inválido.');
    const b = req.body || {};
    const inicio = b.inicio ? data(b.inicio) : null, fim = b.fim ? data(b.fim) : null;
    if ((b.inicio && !inicio) || (b.fim && !fim)) throw fail(400, 'Data inválida.');
    if (inicio && fim && fim < inicio) throw fail(400, 'O fim previsto não pode ser antes do início.');
    const bacteria = String(b.bacteria || '').toUpperCase();
    if (!['', 'VEGETATIVO', 'BACILLUS'].includes(bacteria)) throw fail(400, 'Bactéria inválida.');
    const situacao = String(b.situacao || '').trim();
    if (situacao && !C.SITUACOES.includes(situacao)) throw fail(400, 'Status inválido.');
    await transaction(req.user, db => db.query(`INSERT INTO pcm.batelada_programacao (ativo_id, inicio, fim, bacteria, comentario, situacao, atualizado_por, atualizado_por_nome)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (ativo_id) DO UPDATE SET inicio=excluded.inicio, fim=excluded.fim, bacteria=excluded.bacteria,
      comentario=excluded.comentario, situacao=excluded.situacao, atualizado_por=excluded.atualizado_por, atualizado_por_nome=excluded.atualizado_por_nome, atualizado_em=now()`,
      [id, inicio, fim, bacteria, clean(b.comentario, 300), situacao, req.user.id, req.user.nome || req.user.email]));
    res.json({ ok: true });
  } catch (e) { responder(res, next)(e); }
});

/** Histórico diário (contador e bateladas do dia) para tabela e exportação. */
router.get('/historico', async (req, res, next) => {
  try {
    exigirEquipe(req);
    const ate = data(req.query.ate) || hojeLocal(), de = data(req.query.de) || C.somaDias(ate, -59);
    if (de > ate || C.diasEntre(de, ate) > 800) throw fail(400, 'Período inválido (até ~2 anos).');
    const base = await transaction(req.user, async db => ({
      ativos: (await db.query(`SELECT id, codigo FROM pcm.ativo WHERE ativo AND codigo ~ '^(FTD|PGD|BLD)[0-9]{2}$'
        ORDER BY CASE left(codigo,3) WHEN 'PGD' THEN 1 WHEN 'FTD' THEN 2 ELSE 3 END, codigo`)).rows,
      leituras: (await db.query('SELECT ativo_id, data, acumulado FROM pcm.batelada_leitura WHERE data <= $1 ORDER BY data', [ate])).rows
    }));
    const listas = new Map(base.ativos.map(a => [a.id, []]));
    for (const l of base.leituras) listas.get(l.ativo_id)?.push({ data: isoDay(l.data), acumulado: Number(l.acumulado) });
    C.ancorarInicio([...listas.values()]);
    const dias = [];
    for (let d = de; d <= ate; d = C.somaDias(d, 1)) {
      const linha = { data: d, contador: {}, bateladas: {} };
      for (const a of base.ativos) {
        const lista = listas.get(a.id), hojeV = C.valorEm(lista, d), ontem = C.valorEm(lista, C.somaDias(d, -1));
        linha.contador[a.codigo] = hojeV; linha.bateladas[a.codigo] = Math.max(0, hojeV - ontem);
      }
      dias.push(linha);
    }
    res.set('Cache-Control', 'no-store').json({ ok: true, de, ate, tanques: base.ativos.map(a => a.codigo), dias });
  } catch (e) { responder(res, next)(e); }
});

/** "FTD 01", "FTD-001", "FTD01", "BLR 02" → código do equipamento (FTD01, BLD02). */
function codigoTanque(v) {
  const m = /^\s*(FTD|PGD|BLR|BLD)\s*-?\s*0*(\d{1,2})\s*$/i.exec(String(v || ''));
  if (!m) return null;
  return `${m[1].toUpperCase() === 'BLR' ? 'BLD' : m[1].toUpperCase()}${m[2].padStart(2, '0')}`;
}

/**
 * Histórico da planilha "CONTROLE DE BATELADAS" (lido no navegador e enviado em partes):
 *   leituras: [{ tanque, data, acumulado }]  — contador do supervisório por dia (aba da lista do SharePoint)
 *   preventivas: [{ tanque, data }]          — "Data última preventiva" / calendário
 *   programacao: [{ tanque, inicio, fim, situacao }]
 * Não sobrescreve o que foi apontado no site. Não vai para a fila do SharePoint (esses dias já estão lá).
 */
router.post('/importar', stepUpGestao, async (req, res, next) => {   // carga da planilha: ação administrativa, 2FA recente
  try {
    exigirGestao(req);
    const b = req.body || {};
    const leituras = Array.isArray(b.leituras) ? b.leituras : [], preventivas = Array.isArray(b.preventivas) ? b.preventivas : [];
    const programacao = Array.isArray(b.programacao) ? b.programacao : [];
    const tarefas = Array.isArray(b.tarefas) ? b.tarefas : [], eba = Array.isArray(b.eba) ? b.eba : [];
    if (leituras.length > 20000 || preventivas.length > 2000 || programacao.length > 200 || tarefas.length > 200 || eba.length > 2000) throw fail(400, 'Parte grande demais: envie em partes menores.');
    const hoje = hojeLocal(), recusadas = [];
    const out = await transaction(req.user, async db => {
      await db.query("SELECT set_config('pcm.sem_fila', 'on', true)");
      const ativos = new Map((await db.query(`SELECT id, codigo FROM pcm.ativo WHERE codigo ~ '^(FTD|PGD|BLD)[0-9]{2}$'`)).rows.map(a => [a.codigo, a.id]));
      const alvo = (t, linha) => { const c = codigoTanque(t), id = c && ativos.get(c); if (!id) recusadas.push(`${linha}: tanque "${clean(t, 20)}" não existe`); return id; };
      let lidas = 0, prev = 0, prog = 0, tar = 0, ebas = 0;
      // só os dias em que o contador mudou (o valor vale até o próximo apontamento, como na planilha)
      const ordenadas = leituras.map((l, i) => ({ ...l, i })).sort((x, y) => String(x.tanque).localeCompare(String(y.tanque)) || String(x.data).localeCompare(String(y.data)));
      const ultimo = new Map();
      for (const l of ordenadas) {
        const id = alvo(l.tanque, `leitura ${l.i + 1}`), dia = data(l.data), n = Number(l.acumulado);
        if (!id) continue;
        if (!dia || dia > hoje || !Number.isInteger(n) || n < 0 || n > 1000000) { recusadas.push(`leitura ${l.i + 1}: data ou contador inválido`); continue; }
        if (ultimo.get(id) === n) continue;
        ultimo.set(id, n);
        const r = await db.query(`INSERT INTO pcm.batelada_leitura (ativo_id, data, acumulado, origem, registrado_por, registrado_por_nome)
          VALUES ($1,$2,$3,'planilha',$4,'Planilha')
          ON CONFLICT (ativo_id, data) DO UPDATE SET acumulado=excluded.acumulado WHERE pcm.batelada_leitura.origem='planilha'`, [id, dia, n, req.user.id]);
        lidas += r.rowCount;
      }
      for (const [i, p] of preventivas.entries()) {
        const id = alvo(p.tanque, `preventiva ${i + 1}`), dia = data(p.data);
        if (!id) continue;
        if (!dia || dia > hoje) { recusadas.push(`preventiva ${i + 1}: data inválida`); continue; }
        // exata:false = a planilha só diz em que SEMANA foi (calendário semanal); a data é a do início da semana
        prev += (await db.query(`INSERT INTO pcm.batelada_preventiva (ativo_id, data, exata, origem, observacao, registrado_por, registrado_por_nome)
          VALUES ($1,$2,$3,'planilha',$4,$5,'Planilha') ON CONFLICT (ativo_id, data) DO NOTHING`,
          [id, dia, p.exata !== false, p.exata === false ? 'Importado do calendário semanal (só a semana é conhecida)' : 'Importado da planilha', req.user.id])).rowCount;
      }
      for (const [i, p] of programacao.entries()) {
        const id = alvo(p.tanque, `programação ${i + 1}`);
        if (!id) continue;
        const inicio = p.inicio ? data(p.inicio) : null, fim = p.fim ? data(p.fim) : null;
        const situacao = C.SITUACOES.includes(String(p.situacao || '').trim()) ? String(p.situacao).trim() : '';
        if (!inicio && !fim && !situacao) continue;
        if (inicio && fim && fim < inicio) { recusadas.push(`programação ${i + 1}: fim antes do início`); continue; }
        // não passa por cima do que o PCM já programou no site
        prog += (await db.query(`INSERT INTO pcm.batelada_programacao (ativo_id, inicio, fim, situacao, atualizado_por, atualizado_por_nome)
          VALUES ($1,$2,$3,$4,$5,'Planilha') ON CONFLICT (ativo_id) DO UPDATE SET inicio=excluded.inicio, fim=excluded.fim, situacao=excluded.situacao,
            atualizado_em=now() WHERE pcm.batelada_programacao.atualizado_por_nome='Planilha'`, [id, inicio, fim, situacao, req.user.id])).rowCount;
      }
      for (const [i, t] of tarefas.entries()) {
        const id = alvo(t.tanque, `tarefa ${i + 1}`);
        if (!id) continue;
        if (!TAREFAS.includes(String(t.tipo))) { recusadas.push(`tarefa ${i + 1}: tipo inválido`); continue; }
        // não passa por cima do que o PCM marcou no site
        tar += (await db.query(`INSERT INTO pcm.batelada_tarefa (ativo_id, tipo, feito, atualizado_por, atualizado_por_nome) VALUES ($1,$2,$3,$4,'Planilha')
          ON CONFLICT (ativo_id, tipo) DO UPDATE SET feito = excluded.feito, atualizado_em = now() WHERE pcm.batelada_tarefa.atualizado_por_nome = 'Planilha'`,
          [id, String(t.tipo), t.feito === true, req.user.id])).rowCount;
      }
      for (const [i, e] of eba.entries()) {
        const eq = codigoEba(e.equipamento), dia = data(e.data), fr = String(e.frequencia || '').toUpperCase();
        if (!eq || !dia || !FREQ_EBA.includes(fr)) { recusadas.push(`EBA ${i + 1}: equipamento, data ou frequência inválidos`); continue; }
        ebas += (await db.query(`INSERT INTO pcm.eba_preventiva (equipamento, data, frequencia, realizada, origem, registrado_por, registrado_por_nome) VALUES ($1,$2,$3,$4,'planilha',$5,'Planilha')
          ON CONFLICT (equipamento, data) DO NOTHING`, [eq, dia, fr, e.realizada === true && dia <= hoje, req.user.id])).rowCount;
      }
      return { leituras: lidas, preventivas: prev, programacao: prog, tarefas: tar, eba: ebas };
    });
    res.json({ ok: true, ...out, recusadas: recusadas.slice(0, 100), totalRecusadas: recusadas.length });
  } catch (e) { responder(res, next)(e); }
});

const TAREFAS = ['gas_out', 'diafragma_amostra'], FREQ_EBA = ['S', 'M', 'T'], RE_EBA = /^EBA-\d{3}$/;
function codigoEba(v) { const m = /^\s*EBA\s*-?\s*0*(\d{1,3})\s*$/i.exec(String(v || '')); return m ? `EBA-${m[1].padStart(3, '0')}` : null; }

/** Abas "Planilha1" (gás out / diafragma da amostra por tanque) e "PREVENTIVAS EBA'S". */
router.get('/extras', async (req, res, next) => {
  try {
    exigirEquipe(req);
    const out = await transaction(req.user, async db => ({
      tarefas: (await db.query(`SELECT a.codigo, t.tipo, t.feito, t.atualizado_por_nome, t.atualizado_em FROM pcm.batelada_tarefa t JOIN pcm.ativo a ON a.id = t.ativo_id ORDER BY a.codigo, t.tipo`)).rows,
      eba: (await db.query('SELECT id, equipamento, data, frequencia, realizada, origem FROM pcm.eba_preventiva ORDER BY data, equipamento')).rows
    }));
    res.set('Cache-Control', 'no-store').json({ ok: true, podeGerir: gestao(req.user),
      tarefas: out.tarefas.map(t => ({ codigo: t.codigo, tipo: t.tipo, feito: t.feito, por: t.atualizado_por_nome, em: t.atualizado_em })),
      eba: out.eba.map(e => ({ id: e.id, equipamento: e.equipamento, data: isoDay(e.data), frequencia: e.frequencia, realizada: e.realizada, origem: e.origem })) });
  } catch (e) { responder(res, next)(e); }
});

router.put('/tarefas', async (req, res, next) => {
  try {
    exigirGestao(req);
    const b = req.body || {}, tipo = String(b.tipo || '');
    if (!TAREFAS.includes(tipo)) throw fail(400, 'Tarefa inválida.');
    const codigo = codigoTanque(b.tanque);
    if (!codigo) throw fail(400, 'Tanque inválido.');
    const ok = await transaction(req.user, async db => {
      const ativo = (await db.query(`SELECT id FROM pcm.ativo WHERE codigo = $1 AND ativo`, [codigo])).rows[0];
      if (!ativo) return false;
      await db.query(`INSERT INTO pcm.batelada_tarefa (ativo_id, tipo, feito, atualizado_por, atualizado_por_nome) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (ativo_id, tipo) DO UPDATE SET feito = excluded.feito, atualizado_por = excluded.atualizado_por, atualizado_por_nome = excluded.atualizado_por_nome, atualizado_em = now()`,
        [ativo.id, tipo, b.feito === true, req.user.id, req.user.nome || req.user.email]);
      return true;
    });
    if (!ok) throw fail(404, 'Tanque não encontrado.');
    res.json({ ok: true });
  } catch (e) { responder(res, next)(e); }
});

router.put('/eba', async (req, res, next) => {
  try {
    exigirGestao(req);
    const b = req.body || {}, equipamento = codigoEba(b.equipamento), dia = data(b.data), frequencia = String(b.frequencia || '').toUpperCase();
    if (!equipamento || !RE_EBA.test(equipamento)) throw fail(400, 'Equipamento inválido (use EBA-003).');
    if (!dia) throw fail(400, 'Data inválida.');
    if (!FREQ_EBA.includes(frequencia)) throw fail(400, 'Frequência inválida (S, M ou T).');
    const realizada = b.realizada === true;
    if (realizada && dia > hojeLocal()) throw fail(400, 'Uma preventiva realizada não pode estar no futuro.');
    await transaction(req.user, db => db.query(`INSERT INTO pcm.eba_preventiva (equipamento, data, frequencia, realizada, origem, registrado_por, registrado_por_nome) VALUES ($1,$2,$3,$4,'site',$5,$6)
      ON CONFLICT (equipamento, data) DO UPDATE SET frequencia = excluded.frequencia, realizada = excluded.realizada, registrado_por = excluded.registrado_por, registrado_por_nome = excluded.registrado_por_nome, registrado_em = now()`,
      [equipamento, dia, frequencia, realizada, req.user.id, req.user.nome || req.user.email]));
    res.json({ ok: true });
  } catch (e) { responder(res, next)(e); }
});

router.delete('/eba/:id', stepUpGestao, async (req, res, next) => {
  try {
    exigirGestao(req);
    if (!UUID.test(req.params.id)) throw fail(400, 'Registro inválido.');
    await transaction(req.user, db => db.query('DELETE FROM pcm.eba_preventiva WHERE id = $1', [req.params.id]));
    res.json({ ok: true });
  } catch (e) { responder(res, next)(e); }
});

/** Situação da gravação na lista do SharePoint (o envio é do worker-sharepoint.js). */
router.get('/sharepoint', async (req, res, next) => {
  try {
    exigirGestao(req);
    const r = await transaction(req.user, async db => (await db.query(`SELECT
        count(*) FILTER (WHERE pendente)::int AS pendentes,
        count(*) FILTER (WHERE pendente AND erro IS NOT NULL)::int AS com_erro,
        max(enviado_em) AS ultimo_envio,
        (SELECT erro FROM pcm.batelada_sharepoint WHERE erro IS NOT NULL ORDER BY atualizado_em DESC LIMIT 1) AS ultimo_erro
      FROM pcm.batelada_sharepoint`)).rows[0]);
    res.set('Cache-Control', 'no-store').json({ ok: true, pendentes: r.pendentes, comErro: r.com_erro, ultimoEnvio: r.ultimo_envio, ultimoErro: r.ultimo_erro || '' });
  } catch (e) { responder(res, next)(e); }
});

module.exports = router;
module.exports.carregar = carregar;   // Manutinho (tanques em alerta/vencidos) reaproveita a leitura e o cálculo
module.exports._test = { codigoTanque };
