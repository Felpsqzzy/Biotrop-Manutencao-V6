'use strict';
// Foto opcional da ferramenta (migration 43): enviar, trocar e remover pelo painel (só a gestão), ver no painel e no
// terminal (só ferramenta ativa), tipo conferido pelos bytes, limites de tamanho, cache, auditoria e RLS. App e banco de
// verdade (PGlite, papel biotrop_app). Dados FICTÍCIOS: pessoas "Pessoa x" do harness, matrículas 7100x, ferramentas
// FER-F00x e "fotos" que são só bytes com a assinatura do formato.
process.env.TERMINAL_SCRYPT_LOG2N = '14';   // scrypt mais leve só no teste
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirApp } = require('./_harness');

let h, U;
const API = '/api/emprestimo';
const MIG = path.resolve(__dirname, '../../database/migrations');
const F = {};
const SENHA = '739164', MAT = '710001';

/** Bytes de mentira com a assinatura do formato (não precisam ser uma imagem desenhável). */
const bytes = {
  jpeg: (n = 600, x = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, x)]),
  png: (n = 600) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 2)]),
  webp: (n = 600) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(n, 3)])
};
const url = (mime, b) => `data:${mime};base64,${b.toString('base64')}`;
const foto = (o = {}) => ({ imagem: url('image/jpeg', bytes.jpeg(5000)), miniatura: url('image/jpeg', bytes.jpeg(300, 7)), largura: 1600, altura: 1200, ...o });

let ipN = 0;
/** Navegador do tablet: guarda o cookie do terminal; cada um com um IP (X-Forwarded-For). */
function tablet() {
  const t = { cookie: '', ip: `10.43.0.${++ipN}` };
  t.req = async (method, u, body, extra = {}) => {
    const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': t.ip, ...extra };
    if (t.cookie && !headers.cookie) headers.cookie = t.cookie;
    const r = await fetch(h.raiz + u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      if (kv.slice(0, i) === 'biotrop_terminal') t.cookie = kv.slice(i + 1) ? kv : '';
    }
    const tipo = r.headers.get('content-type') || '';
    const corpo = tipo.startsWith('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { s: r.status, j: tipo.startsWith('application/json') ? corpo : null, b: Buffer.isBuffer(corpo) ? corpo : null, headers: r.headers };
  };
  return t;
}
/** Resposta crua com sessão do site (imagem, cabeçalhos). */
async function imagem(u, caminho, headers = {}) {
  const r = await (u ? h.raw(u, 'GET', caminho) : fetch(h.raiz + caminho, { headers }));
  return { s: r.status, tipo: r.headers.get('content-type') || '', headers: r.headers, b: Buffer.from(await r.arrayBuffer()) };
}
const auditoria = async fid => (await h.q('SELECT tipo, detalhe, por FROM emprestimo.auditoria WHERE ferramenta_id=$1 AND tipo LIKE $2 ORDER BY em, id', [fid, 'foto_%'])).rows;

test.before(async () => {
  h = await subirApp({ adm: 'admin', ges: 'gestor', alm: 'almoxarife', tec: 'tecnico', pcm: 'pcm', t1: 'terminal' });
  U = h.users;
});
test.after(() => h?.fechar());

test('preparação: ferramentas fictícias e um colaborador com acesso ao terminal', async () => {
  let r = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-F001', nome: 'Trena 5 m (teste foto)', categoria: 'Medição', controle: 'quantidade', total: 3 });
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.trena = r.j.id;
  r = await h.api(U.alm, 'POST', `${API}/ferramentas`, { codigo: 'FER-F002', nome: 'Serra tico-tico (teste foto)', categoria: 'Elétrica', controle: 'individual', unidades: ['PAT-F1'] });
  assert.equal(r.s, 201, JSON.stringify(r.j)); F.serra = r.j.id;
  r = await h.api(U.alm, 'POST', `${API}/colaboradores`, { nome: 'Pessoa t1', email: U.t1.email, matricula: MAT, setor: 'Manutenção', centroCusto: 'CC-F1' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const c = await h.api(U.alm, 'POST', `${API}/colaboradores/${U.t1.id}/convite`);
  assert.equal(c.s, 201, JSON.stringify(c.j));
  F.tab = tablet();
  r = await F.tab.req('POST', '/api/terminal/primeiro-acesso', { matricula: MAT, codigo: c.j.codigo, senha: SENHA });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(U.alm, 'GET', `${API}/ferramentas`);
  assert.ok(r.j.rows.every(f => f.foto === null), 'sem foto: foto null na lista');
});

test('enviar: a gestão grava; lista e ficha trazem a versão; a imagem sai com tipo, nosniff, CSP e cache pela versão', async () => {
  const corpo = foto();
  let r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.trena}/foto`, corpo);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.trocada, false);
  assert.match(r.j.foto.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([r.j.foto.largura, r.j.foto.altura, r.j.foto.tamanho], [1600, 1200, 5004]);
  F.v1 = r.j.foto.id;
  r = await h.api(U.alm, 'GET', `${API}/ferramentas?q=FER-F001`);
  assert.deepEqual(r.j.rows[0].foto, { id: F.v1, largura: 1600, altura: 1200 });
  r = await h.api(U.ges, 'GET', `${API}/ferramentas/${F.trena}`);
  assert.equal(r.j.ferramenta.foto.id, F.v1); assert.equal(r.j.ferramenta.foto.tamanho, 5004);
  assert.equal(r.j.ferramenta.foto.enviadaPor, 'Pessoa alm'); assert.ok(r.j.ferramenta.foto.enviadaEm);
  assert.ok(!/base64|imagem|miniatura/.test(JSON.stringify(r.j)), 'a ficha não carrega os bytes da foto');
  assert.ok(r.j.ferramenta.historico.some(x => x.tipo === 'foto_enviada' && x.por === 'Pessoa alm'), 'envio no histórico da ferramenta');

  let img = await imagem(U.alm, `${API}/ferramentas/${F.trena}/foto?v=${F.v1}`);
  assert.equal(img.s, 200);
  assert.equal(img.tipo, 'image/jpeg');
  assert.ok(img.b.equals(bytes.jpeg(5000)), 'devolve os mesmos bytes enviados');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(img.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(img.headers.get('cache-control'), 'private, max-age=604800, immutable', 'versão atual: o navegador guarda');
  const etag = img.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  img = await imagem(U.alm, `${API}/ferramentas/${F.trena}/foto?v=${F.v1}&mini=1`);
  assert.deepEqual([img.s, img.tipo], [200, 'image/jpeg']); assert.ok(img.b.equals(bytes.jpeg(300, 7)), 'miniatura');
  assert.notEqual(img.headers.get('etag'), etag);
  img = await imagem(U.alm, `${API}/ferramentas/${F.trena}/foto`);
  assert.equal(img.headers.get('cache-control'), 'private, no-cache', 'sem a versão: confere de novo');
  // como o navegador revalida (o fetch do Node põe "no-cache" sozinho se não vier um cache-control)
  const de304 = await fetch(h.raiz + `${API}/ferramentas/${F.trena}/foto`, { headers: { ...cabSessao(U.alm), 'if-none-match': etag, 'cache-control': 'max-age=0' } });
  assert.equal(de304.status, 304, 'ETag igual: 304 sem corpo');
  assert.equal((await imagem(U.alm, `${API}/ferramentas/${F.serra}/foto`)).s, 404, 'sem foto: 404');
  assert.equal((await imagem(U.alm, `${API}/ferramentas/nao-e-uuid/foto`)).s, 400);
});
function cabSessao(u) {
  const { createSession } = require('../src/auth/session');
  return { cookie: `biotrop_session=${createSession({ id: u.id, sessaoVersao: u.sv }).valor}` };
}

test('tipo inválido: o conteúdo manda, não o rótulo (SVG, HTML, GIF, PNG chamado de JPEG, miniatura que não é JPEG)', async () => {
  const svg = Buffer.from('<svg xmlns="x" onload="alert(1)"><script>alert(1)</script></svg>'.repeat(4));
  const casos = [
    [foto({ imagem: url('image/svg+xml', svg) }), /formato inválido/],
    [foto({ imagem: url('image/jpeg', svg) }), /não é a imagem que diz ser/],
    [foto({ imagem: url('image/jpeg', Buffer.from('<html><body>teste</body></html>'.repeat(10))) }), /não é a imagem que diz ser/],
    [foto({ imagem: url('image/gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(300)])) }), /formato inválido/],
    [foto({ imagem: url('image/jpeg', bytes.png()) }), /não é a imagem que diz ser/],
    [foto({ imagem: url('image/webp', bytes.jpeg()) }), /não é a imagem que diz ser/],
    [foto({ miniatura: url('image/png', bytes.png()) }), /Miniatura em formato inválido \(use JPG\)/],
    [foto({ miniatura: undefined }), /Miniatura em formato inválido/],
    [foto({ imagem: 'https://exemplo.invalido/foto.jpg' }), /formato inválido/],
    [foto({ imagem: { tipo: 'objeto' } }), /formato inválido/],
    [foto({ imagem: url('image/jpeg', bytes.jpeg(10)) }), /vazia ou corrompida/]
  ];
  for (const [corpo, msg] of casos) {
    const r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.serra}/foto`, corpo);
    assert.equal(r.s, 400, `${JSON.stringify(r.j)}`); assert.match(r.j.erro, msg);
  }
  assert.equal((await h.q('SELECT count(*)::int n FROM emprestimo.ferramenta_foto WHERE ferramenta_id=$1', [F.serra])).rows[0].n, 0, 'nada gravado');
  // o banco confere de novo, mesmo se a API deixasse passar
  await assert.rejects(h.transaction(U.alm, db => db.query('SELECT * FROM emprestimo.ferramenta_foto_salvar($1,$2,$3,$4,0,0)', [F.serra, 'image/jpeg', Buffer.alloc(500, 60), bytes.jpeg(300)])),
    e => e.code === '22023');
  await assert.rejects(h.transaction(U.alm, db => db.query('SELECT * FROM emprestimo.ferramenta_foto_salvar($1,$2,$3,$4,0,0)', [F.serra, 'image/png', bytes.png(), bytes.png()])),
    e => e.code === '22023', 'miniatura PNG no banco');
  // PNG e WEBP de verdade (pela assinatura) entram
  let r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.serra}/foto`, foto({ imagem: url('image/png', bytes.png(800)) }));
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal((await imagem(U.alm, `${API}/ferramentas/${F.serra}/foto`)).tipo, 'image/png');
  r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.serra}/foto`, foto({ imagem: url('image/webp', bytes.webp(800)) }));
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.trocada, true);
  assert.equal((await imagem(U.alm, `${API}/ferramentas/${F.serra}/foto`)).tipo, 'image/webp');
});

test('tamanho: foto até 1,2 MB e miniatura até 80 KB (API e banco)', async () => {
  let r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.trena}/foto`, foto({ imagem: url('image/jpeg', bytes.jpeg(1200001)) }));
  assert.equal(r.s, 400); assert.match(r.j.erro, /Foto grande demais/);
  r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.trena}/foto`, foto({ miniatura: url('image/jpeg', bytes.jpeg(80001)) }));
  assert.equal(r.s, 400); assert.match(r.j.erro, /Miniatura grande demais/);
  // corpo acima dos 2 MB do express.json: 413 com mensagem (antes caía no erro interno)
  r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.trena}/foto`, foto({ imagem: url('image/jpeg', bytes.jpeg(1700000)) }));
  assert.deepEqual([r.s, r.j.erro], [413, 'Envio grande demais (máximo de 2 MB por vez).']);
  r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.trena}/foto`, foto({ imagem: url('image/jpeg', bytes.jpeg(1199990)) }));
  assert.equal(r.s, 200, 'no limite entra'); F.v2 = r.j.foto.id;
  assert.notEqual(F.v2, F.v1, 'trocar muda a versão (a URL antiga sai do cache)');
  assert.equal(r.j.trocada, true);
  assert.equal((await imagem(U.alm, `${API}/ferramentas/${F.trena}/foto?v=${F.v1}`)).headers.get('cache-control'), 'private, no-cache', 'versão antiga não é guardada');
  await assert.rejects(h.transaction(U.alm, db => db.query('SELECT * FROM emprestimo.ferramenta_foto_salvar($1,$2,$3,$4,0,0)', [F.trena, 'image/jpeg', bytes.jpeg(1200001), bytes.jpeg(300)])),
    e => e.code === '22023', 'o banco também barra o tamanho');
  r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.trena}/foto`, foto());   // volta a uma foto pequena para o resto
  assert.equal(r.s, 200); F.v3 = r.j.foto.id;
});

test('permissão: técnico, PCM, perfil terminal e sem sessão não enviam nem veem; o banco recusa escrita direta e o canal terminal', async () => {
  for (const u of [U.tec, U.pcm, U.t1]) {
    assert.equal((await h.api(u, 'PUT', `${API}/ferramentas/${F.trena}/foto`, foto())).s, 403);
    assert.equal((await h.api(u, 'DELETE', `${API}/ferramentas/${F.trena}/foto`)).s, 403);
    assert.equal((await imagem(u, `${API}/ferramentas/${F.trena}/foto`)).s, 403);
  }
  assert.equal((await imagem(null, `${API}/ferramentas/${F.trena}/foto`)).s, 401, 'sem login');
  // o gestor e o admin também administram a foto
  assert.equal((await imagem(U.ges, `${API}/ferramentas/${F.trena}/foto?mini=1`)).s, 200);
  // direto no banco: sem DML para a role da API (mesmo admin), e a função recusa quem não é gestão e o canal terminal
  for (const sql of [`DELETE FROM emprestimo.ferramenta_foto`, `UPDATE emprestimo.ferramenta_foto SET largura = 1`,
    `INSERT INTO emprestimo.ferramenta_foto (ferramenta_id, mime, imagem, miniatura, sha256, enviada_por) SELECT id, 'image/jpeg', '\\xffd8ff', '\\xffd8ff', repeat('a', 64), criado_por FROM emprestimo.ferramenta LIMIT 1`]) {
    await assert.rejects(h.transaction(U.adm, db => db.query(sql)), e => e.code === '42501', sql.slice(0, 30));
  }
  await assert.rejects(h.transaction(U.tec, db => db.query('SELECT * FROM emprestimo.ferramenta_foto_salvar($1,$2,$3,$4,0,0)', [F.trena, 'image/jpeg', bytes.jpeg(), bytes.jpeg()])), e => e.code === '42501');
  await assert.rejects(h.transaction(U.alm, async db => {
    await db.query("SELECT set_config('app.canal','terminal',true)");
    return db.query('SELECT emprestimo.ferramenta_foto_remover($1)', [F.trena]);
  }), e => e.code === '42501', 'no canal terminal até o almoxarife é só colaborador');
  assert.equal((await h.transaction(U.tec, db => db.query('SELECT * FROM emprestimo.ferramenta_foto'))).rows.length, 0, 'técnico não lê pelo RLS');
  assert.equal((await h.q('SELECT id FROM emprestimo.ferramenta_foto WHERE ferramenta_id=$1', [F.trena])).rows[0].id, F.v3, 'nada mudou');
  const pol = (await h.q("SELECT cmd FROM pg_policies WHERE schemaname='emprestimo' AND tablename='ferramenta_foto' ORDER BY cmd")).rows.map(x => x.cmd);
  assert.deepEqual(pol, ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], 'policy de leitura e de escrita, inclusive UPDATE');
});

test('terminal: vê a miniatura de ferramenta ativa; inativa some (404); o cookie do terminal não envia foto', async () => {
  const t = F.tab;
  let r = await t.req('GET', '/api/terminal/ferramentas?q=FER-F00');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const trena = r.j.rows.find(x => x.id === F.trena);
  assert.deepEqual(trena.foto, { id: F.v3, largura: 1600, altura: 1200 });
  r = await t.req('GET', `/api/terminal/ferramentas/${F.trena}/foto?v=${F.v3}&mini=1`);
  assert.deepEqual([r.s, r.headers.get('content-type')], [200, 'image/jpeg']);
  assert.ok(r.b.equals(bytes.jpeg(300, 7)));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=604800, immutable');
  assert.equal((await t.req('GET', `/api/terminal/ferramentas/${F.trena}/foto`)).s, 200, 'foto grande também');
  // o cookie do terminal não grava foto: nem no painel (requireAuth do site) nem por uma rota do terminal
  r = await t.req('PUT', `${API}/ferramentas/${F.trena}/foto`, foto({ imagem: url('image/jpeg', bytes.jpeg(900, 9)) }));
  assert.equal(r.s, 401, 'painel recusa o cookie do terminal');
  assert.equal((await t.req('DELETE', `${API}/ferramentas/${F.trena}/foto`)).s, 401);
  for (const m of ['PUT', 'POST', 'DELETE']) {
    r = await t.req(m, `/api/terminal/ferramentas/${F.trena}/foto`, m === 'DELETE' ? undefined : foto());
    assert.equal(r.s, 404, `${m} no terminal não existe`);
  }
  assert.equal((await h.q('SELECT id FROM emprestimo.ferramenta_foto WHERE ferramenta_id=$1', [F.trena])).rows[0].id, F.v3, 'foto intacta');
  // o cookie do site não abre a foto pelo terminal, e sem cookie nada sai
  assert.equal((await imagem(U.alm, `/api/terminal/ferramentas/${F.trena}/foto?mini=1`)).s, 401);
  assert.equal((await tablet().req('GET', `/api/terminal/ferramentas/${F.trena}/foto?mini=1`)).s, 401);
  // ferramenta inativa: some da lista e a foto não sai no terminal (o painel continua vendo)
  r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.serra}`, { ativo: false });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await t.req('GET', '/api/terminal/ferramentas?q=FER-F00');
  assert.ok(!r.j.rows.some(x => x.id === F.serra));
  assert.equal((await t.req('GET', `/api/terminal/ferramentas/${F.serra}/foto?mini=1`)).s, 404, 'inativa: 404 no terminal');
  assert.equal((await imagem(U.alm, `${API}/ferramentas/${F.serra}/foto?mini=1`)).s, 200, 'o painel vê a foto da inativa');
  const fora = await h.transaction(U.alm, async db => { await db.query("SELECT set_config('app.canal','terminal',true)"); return (await db.query('SELECT ferramenta_id FROM emprestimo.ferramenta_foto')).rows; });
  assert.deepEqual(fora.map(x => x.ferramenta_id), [F.trena], 'RLS do canal terminal: só a foto da ativa');
  await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.serra}`, { ativo: true });
  // depois de sair, a foto também não sai (sessão encerrada no servidor)
  const copia = t.cookie;
  assert.equal((await t.req('POST', '/api/terminal/sair', {})).s, 200);
  assert.equal((await t.req('GET', `/api/terminal/ferramentas/${F.trena}/foto?mini=1`, undefined, { cookie: copia })).s, 401, 'cookie copiado antes do logout');
});

test('remover: some da lista e da imagem; remover de novo é 404; auditoria sem a imagem', async () => {
  let r = await h.api(U.ges, 'DELETE', `${API}/ferramentas/${F.trena}/foto`);
  assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await h.api(U.alm, 'GET', `${API}/ferramentas?q=FER-F001`);
  assert.equal(r.j.rows[0].foto, null);
  assert.equal((await imagem(U.alm, `${API}/ferramentas/${F.trena}/foto?v=${F.v3}`)).s, 404);
  r = await h.api(U.alm, 'DELETE', `${API}/ferramentas/${F.trena}/foto`);
  assert.deepEqual([r.s, r.j.erro], [404, 'Esta ferramenta não tem foto.']);
  assert.equal((await h.api(U.alm, 'DELETE', `${API}/ferramentas/00000000-0000-4000-8000-000000000000/foto`)).s, 404);
  const aud = await auditoria(F.trena);
  assert.deepEqual(aud.map(a => a.tipo), ['foto_enviada', 'foto_trocada', 'foto_trocada', 'foto_removida']);
  assert.equal(aud.at(-1).por, U.ges.id);
  for (const a of aud) assert.deepEqual(Object.keys(a.detalhe).sort(), ['altura', 'largura', 'tamanho'], 'só dimensões e tamanho');
  assert.deepEqual(aud[0].detalhe, { largura: 1600, altura: 1200, tamanho: 5004 });
  const hist = (await h.api(U.alm, 'GET', `${API}/ferramentas/${F.trena}`)).j.ferramenta.historico.map(x => x.tipo);
  for (const k of ['foto_enviada', 'foto_trocada', 'foto_removida']) assert.ok(hist.includes(k), k);
  // depois de remover, enviar de novo volta a ser "enviada"
  r = await h.api(U.alm, 'PUT', `${API}/ferramentas/${F.trena}/foto`, foto());
  assert.deepEqual([r.s, r.j.trocada], [200, false]);
});

test('reaplicar as migrations 40 e 43 duas vezes (como o deploy) não perde a foto nem abre a tabela', async () => {
  const antes = (await h.q('SELECT ferramenta_id, id, sha256 FROM emprestimo.ferramenta_foto ORDER BY ferramenta_id')).rows;
  assert.equal(antes.length, 2);
  for (let i = 0; i < 2; i += 1) {
    await h.db.exec(fs.readFileSync(path.join(MIG, '40-emprestimo.sql'), 'utf8'));
    await h.db.exec(fs.readFileSync(path.join(MIG, '43-ferramenta-foto.sql'), 'utf8'));
  }
  assert.deepEqual((await h.q('SELECT ferramenta_id, id, sha256 FROM emprestimo.ferramenta_foto ORDER BY ferramenta_id')).rows, antes);
  const priv = (await h.q(`SELECT grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema='emprestimo' AND table_name='ferramenta_foto' AND grantee IN ('biotrop_app','biotrop_ro','PUBLIC') ORDER BY 1, 2`)).rows;
  assert.deepEqual(priv, [{ grantee: 'biotrop_app', privilege_type: 'SELECT' }], 'só leitura da API; biotrop_ro sem nada');
  assert.equal((await imagem(U.alm, `${API}/ferramentas/${F.trena}/foto?mini=1`)).s, 200, 'continua saindo');
});
