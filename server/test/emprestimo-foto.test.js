'use strict';
// Foto opcional da ferramenta (migration 43): a conferência da imagem no servidor (server/src/lib/imagem.js) e o
// contrato estático (rotas, migration). Dados FICTÍCIOS: "fotos" são bytes com a assinatura do formato.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lerImagem, fotoDoCorpo, LIMITE } = require('../src/lib/imagem');

const RAIZ = path.resolve(__dirname, '../..');
const ler = rel => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const bytes = {
  jpeg: (n = 600, x = 1) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, x)]),
  png: (n = 600) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 2)]),
  webp: (n = 600) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(n, 3)])
};
const url = (mime, b) => `data:${mime};base64,${b.toString('base64')}`;
const foto = (o = {}) => ({ imagem: url('image/jpeg', bytes.jpeg(5000)), miniatura: url('image/jpeg', bytes.jpeg(300, 7)), largura: 1600, altura: 1200, ...o });
const SVG = Buffer.from('<svg xmlns="x" onload="alert(1)"><script>alert(1)</script></svg>'.repeat(4));

/** Casos de entrada inválida: [corpo, mensagem]. */
const INVALIDOS = [
  [foto({ imagem: url('image/svg+xml', SVG) }), 'Foto em formato inválido (use JPG, PNG ou WEBP).'],
  [foto({ imagem: url('image/jpeg', SVG) }), 'Foto: o conteúdo não é a imagem que diz ser.'],
  [foto({ imagem: url('image/gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(300)])) }), 'Foto em formato inválido (use JPG, PNG ou WEBP).'],
  [foto({ imagem: url('image/png', bytes.jpeg()) }), 'Foto: o conteúdo não é a imagem que diz ser.'],
  [foto({ imagem: url('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(300)])) }), 'Foto: o conteúdo não é a imagem que diz ser.'],
  [foto({ imagem: url('image/jpeg', bytes.jpeg(10)) }), 'Foto vazia ou corrompida.'],
  [foto({ imagem: url('image/jpeg', bytes.jpeg(LIMITE.imagem)) }), 'Foto grande demais.'],
  [foto({ imagem: 'x'.repeat(2000000) }), 'Foto grande demais.'],
  [foto({ imagem: 'https://exemplo.invalido/f.jpg' }), 'Foto em formato inválido (use JPG, PNG ou WEBP).'],
  [foto({ imagem: 12345 }), 'Foto em formato inválido (use JPG, PNG ou WEBP).'],
  [foto({ miniatura: url('image/png', bytes.png()) }), 'Miniatura em formato inválido (use JPG).'],
  [foto({ miniatura: url('image/jpeg', bytes.jpeg(LIMITE.miniatura)) }), 'Miniatura grande demais.'],
  [foto({ miniatura: undefined }), 'Miniatura em formato inválido (use JPG).']
];

/* ================================================================ servidor: lib/imagem.js */
test('lib/imagem: tipo pelos primeiros bytes (JPEG, PNG, WEBP), não pelo rótulo; limites de tamanho', () => {
  assert.deepEqual(lerImagem(url('image/jpeg', bytes.jpeg()), 1000, 'Foto').mime, 'image/jpeg');
  assert.deepEqual(lerImagem(url('image/png', bytes.png()), 1000, 'Foto').mime, 'image/png');
  assert.deepEqual(lerImagem(url('image/webp', bytes.webp()), 1000, 'Foto').mime, 'image/webp');
  assert.ok(lerImagem(url('image/jpeg', bytes.jpeg()), 1000, 'Foto').b.equals(bytes.jpeg()), 'devolve os bytes decodificados');
  for (const [corpo, msg] of INVALIDOS) {
    assert.throws(() => fotoDoCorpo(corpo), e => e.status === 400 && e.message === msg, msg);
  }
  assert.throws(() => fotoDoCorpo(null), e => e.status === 400);
  assert.throws(() => lerImagem(url('image/jpeg', bytes.jpeg()) + '%%', 1000, 'Foto'), /formato inválido/, 'base64 com lixo no fim');
  // dimensões: inteiro de 1 a 10000; o resto vira 0 (desconhecida)
  const r = fotoDoCorpo(foto({ largura: '1600', altura: -5 }));
  assert.deepEqual([r.mime, r.largura, r.altura, r.b.length, r.mini.length], ['image/jpeg', 1600, 0, 5004, 304]);
  assert.equal(fotoDoCorpo(foto({ largura: 99999, altura: 'abc' })).largura, 0);
  assert.equal(LIMITE.imagem, 1200000); assert.equal(LIMITE.miniatura, 80000);
});

test('contrato: rotas da foto no painel e no terminal, migration 43 idempotente com RLS e escrita só por função', () => {
  const painel = ler('server/src/routes/emprestimo.js'), terminal = ler('server/src/routes/terminal.js'), mig = ler('database/migrations/43-ferramenta-foto.sql');
  for (const r of ["put('/ferramentas/:id/foto'", "delete('/ferramentas/:id/foto'", "get('/ferramentas/:id/foto'"]) assert.ok(painel.includes('router.' + r), r);
  assert.ok(terminal.includes("router.get('/ferramentas/:id/foto'"), 'terminal só lê a foto');
  assert.ok(!/router\.(put|post|delete)\('\/ferramentas\/:id\/foto'/.test(terminal), 'o terminal não grava foto');
  assert.ok(terminal.indexOf("router.get('/ferramentas/:id/foto'") > terminal.indexOf('router.use(requireTerminal)'), 'foto do terminal só com a sessão do terminal');
  assert.match(mig, /^BEGIN;$/m); assert.match(mig, /^COMMIT;$/m);
  assert.match(mig, /CREATE TABLE IF NOT EXISTS emprestimo\.ferramenta_foto/);
  for (const p of ['ferramenta_foto_sel', 'ferramenta_foto_ins', 'ferramenta_foto_upd', 'ferramenta_foto_del']) {
    assert.match(mig, new RegExp(`DROP POLICY IF EXISTS ${p} ON emprestimo\\.ferramenta_foto;\\r?\\nCREATE POLICY ${p}`), p + ' recriada a cada deploy');
  }
  assert.match(mig, /REVOKE ALL ON emprestimo\.ferramenta_foto FROM PUBLIC, biotrop_app, biotrop_ro;\r?\nGRANT SELECT ON emprestimo\.ferramenta_foto TO biotrop_app;/, 'API só lê a tabela');
  assert.match(mig, /SECURITY DEFINER SET search_path = emprestimo, core, app, public, pg_temp/);
  assert.doesNotMatch(mig, /DROP TABLE|DELETE FROM emprestimo\.(?!ferramenta_foto WHERE ferramenta_id = f\.id)|TRUNCATE/, 'não apaga nada de outra migration');
  assert.match(ler('server/src/app.js'), /app\.use\('\/api\/emprestimo', rateLimit\(\{ limit: 600, windowMs: 15 \* 60_000, methods: \['POST', 'PUT', 'DELETE'\], porUsuario: true \}\)\)/, 'remover a foto conta no limite');
});


/**
 * Espera a condição dando voltas no laço de eventos (o IndexedDB de mentira responde por setImmediate). Um setTimeout
 * fixo de 20 ms vencia antes do setImmediate com a máquina carregada e o teste falhava à toa.
 */
async function ate(cond, rotulo) {
  for (let i = 0; i < 500; i++) { if (cond()) return; await new Promise(r => setImmediate(r)); }
  assert.fail(`não aconteceu: ${rotulo}`);
}
