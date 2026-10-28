'use strict';
// Integração do empréstimo com o resto do servidor (fases 4 a 7): o app.js monta avisos, painel e terminal na ordem
// certa; o nginx só deixa /terminal e /api/terminal para a rede interna (nenhum caminho que o Express entrega ao terminal
// escapa da regra) e corpo JSON inválido é 400, não erro interno. Usuários e senhas FICTÍCIOS. O estático vem do build de
// exemplo (test/fixtures/web-dist, via WEB_DIR).
process.env.NODE_ENV = 'test';
process.env.APP_BASE_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgres://ninguem:x@127.0.0.1:1/nada';
process.env.SESSION_SECRET = 'teste-'.padEnd(48, 'x');
process.env.ENTRA_TENANT_ID = '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET = 'segredo-de-teste';
process.env.WEB_DIR = require('node:path').join(__dirname, 'fixtures', 'web-dist');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const ler = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------------------------------------------------------------- app.js: ordem de montagem */
test('app.js: limite antes das rotas; avisos antes do painel; terminal depois do same-origin, do JSON e dos cookies', () => {
  const src = ler('server/src/app.js');
  const pos = s => { const i = src.indexOf(s); assert.ok(i >= 0, 'no app.js: ' + s); return i; };
  const limite = pos("app.use('/api/emprestimo', rateLimit(");
  const avisos = pos("app.use('/api/emprestimo/avisos', require('./routes/emprestimo-avisos'))");
  const painel = pos("app.use('/api/emprestimo', require('./routes/emprestimo'))");
  const terminal = pos("app.use('/api/terminal', require('./routes/terminal'))");
  assert.ok(limite < avisos && avisos < painel, 'o limite vale para os dois; /avisos antes de /api/emprestimo');
  for (const antes of ["app.use('/api', requireSameOrigin)", 'app.use(express.json(', 'app.use(cookieParser())']) assert.ok(pos(antes) < terminal, antes + ' antes do terminal');
  assert.equal(src.split("require('./routes/terminal')").length, 2, 'terminal montado uma vez');
  assert.equal(src.split("require('./routes/emprestimo')").length, 2, 'painel montado uma vez');
});

/* ---------------------------------------------------------------- nginx: /terminal e /api/terminal só da rede interna */
const NGINX = ler('deploy/nginx/biotrop.conf').replace(/\r\n/g, '\n');
const SITE = NGINX.slice(NGINX.indexOf('# Site em HTTPS'));
/** As duas locations do terminal: [regex do nginx, corpo]. */
const locTerminal = () => [...SITE.matchAll(/\n {2}location ~\* (\S+) \{\n([\s\S]*?)\n {2}\}/g)].map(m => [m[1], m[2]]);
/** O que o nginx compara com a location: sem query, %XX decodificado, barras repetidas juntas, . e .. resolvidos. */
function uriNginx(cru) {
  const p = cru.split('?')[0].replace(/%([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/\/{2,}/g, '/');
  const out = [];
  for (const s of p.split('/')) { if (s === '.') continue; if (s === '..') { if (out.length > 1) out.pop(); continue; } out.push(s); }
  return out.join('/') || '/';
}
const barradoNoNginx = u => locTerminal().some(([re]) => new RegExp(re, 'i').test(uriNginx(u)));

test('guia do TI: rede do terminal (o mesmo geo do nginx), política do navegador do tablet compartilhado e o pacote sem o demo', () => {
  const guia = ler('docs/DEPLOY-TI.md');
  const secao = guia.slice(guia.indexOf('## 9. Terminal do almoxarifado'));
  assert.ok(secao.length > 500, 'seção do terminal no DEPLOY-TI');
  assert.ok(NGINX.includes('geo $biotrop_terminal_rede') && secao.includes('geo $biotrop_terminal_rede'), 'o guia cita o bloco que o nginx usa');
  // sem o gerenciador de senhas desligado, o Chrome oferece "Salvar senha?" e o próximo colaborador entra como o anterior
  for (const p of ['PasswordManagerEnabled=false', 'AutofillAddressEnabled=false', 'modo quiosque']) assert.ok(secao.includes(p), p);
  for (const v of ['TERMINAL_SCRYPT_LOG2N', 'emprestimo_lembrete', 'emprestimo_devolucao', '?v=N', 'emprestimo-demo.js']) assert.ok(secao.includes(v), v);
  assert.match(ler('.env.example'), /^TERMINAL_SCRYPT_LOG2N=17\r?$/m, 'valor preenchido: vazio vira 0 e a produção não sobe');
  assert.match(ler('.env.app.example'), /^TERMINAL_SCRYPT_LOG2N=17\r?$/m);
});

test('nginx: geo com a rede interna (padrão: fora) e as duas locations do terminal recusam quem está fora antes do proxy', () => {
  const geo = /\ngeo \$biotrop_terminal_rede \{\n([\s\S]*?)\n\}/.exec(NGINX);
  assert.ok(geo, 'bloco geo no nível http');
  assert.match(geo[1], /^\s*default\s+0;/m, 'quem não está na lista fica de fora');
  assert.doesNotMatch(geo[1], /0\.0\.0\.0\/0|::\/0/, 'nada de liberar a internet inteira');
  const locs = locTerminal();
  assert.deepEqual(locs.map(([re]) => re), ['^/api/terminal(/|$)', '^/terminal(\\.html)?/?$']);
  const raiz = /\n {2}location \/ \{\n([\s\S]*?)\n {2}\}/.exec(SITE)[1];
  const proxy = t => t.split('\n').map(l => l.trim()).filter(l => /^proxy_/.test(l));
  for (const [re, corpo] of locs) {
    const linhas = corpo.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const i = linhas.findIndex(l => l.startsWith('if ($biotrop_terminal_rede = 0) { return 403'));
    assert.ok(i >= 0 && i < linhas.findIndex(l => l.startsWith('proxy_pass')), `${re}: recusa antes do proxy_pass`);
    assert.deepEqual(proxy(corpo), proxy(raiz), `${re}: mesmos cabeçalhos do "location /" (IP real, sem X-Forwarded-For forjado)`);
    assert.doesNotMatch(corpo, /add_header/, 'add_header aqui apagaria o HSTS e a Permissions-Policy do server');
  }
  assert.match(locs[0][1], /return 403 '\{"ok":false,"erro":"[^"]+"\}';/, 'a API responde JSON (a tela mostra o erro)');
  for (const fora of ['/', '/index.html', '/api/emprestimo/ferramentas', '/api/terminais', '/api/terminalx/entrar', '/src/terminal/terminal.js', '/src/terminal/terminal.css',
    '/almox_emprestimo', '/terminalx', '/ferramentas/inventario.html']) assert.ok(!barradoNoNginx(fora), `${fora} não é do terminal`);
});

/** Requisição com o caminho cru (sem o fetch normalizar . e ..). */
function cru(base, metodo, caminho) {
  const u = new URL(base);
  return new Promise((ok, erro) => {
    const r = http.request({ host: u.hostname, port: u.port, method: metodo, path: caminho, headers: { origin: 'http://localhost:3000' } }, res => {
      const partes = []; res.on('data', c => partes.push(c)); res.on('end', () => ok({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }));
    });
    r.on('error', erro); r.end();
  });
}
async function servidor(fn) {
  const app = require('../src/app');
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('nginx × Express: todo caminho que o Express entrega ao terminal (maiúsculas, barra final, //, ;, %XX) cai numa location barrada', () => servidor(async base => {
  const api = ['/api/terminal/eu', '/API/TERMINAL/EU', '/Api/Terminal/Eu/', '/api/terminal/eu/', '/api/terminal/eu?x=1', '/api/terminal/eu;x', '/api/terminal//eu',
    '/api//terminal/eu', '/api/%74erminal/eu', '/api/terminal%2Feu', '/api/terminal/./eu', '/api/x/../terminal/eu', '/api/terminal/emprestimos/abc', '/api/terminal', '/API/terminal/'];
  const pagina = ['/terminal', '/TERMINAL', '/Terminal/', '/terminal?demo=1', '/terminal.html', '/terminal/.', '/%74erminal', '/terminal;x', '/terminal.HTML'];
  const doTerminal = [];
  for (const u of api) {
    const r = await cru(base, 'GET', u);
    if (r.status === 401 && /Sessão do terminal encerrada/.test(r.corpo)) doTerminal.push(u);
  }
  for (const u of pagina) {
    const r = await cru(base, 'GET', u);
    if (r.status === 200 && /<title>Terminal do Almoxarifado/.test(r.corpo)) doTerminal.push(u);
  }
  for (const u of ['/API/TERMINAL/EU', '/Api/Terminal/Eu/', '/api/terminal//eu', '/TERMINAL', '/Terminal/', '/terminal.html']) assert.ok(doTerminal.includes(u), `o Express entrega ${u} ao terminal`);
  assert.deepEqual(doTerminal.filter(u => !barradoNoNginx(u)), [], 'escapam da regra do nginx');
}));

/* ---------------------------------------------------------------- corpo JSON inválido: 400, não erro interno */
test('corpo JSON malformado ou que não é objeto (null, número, texto) recebe 400 com mensagem curta; nada vai para o log de erro interno', () => servidor(async base => {
  const logs = [], orig = console.error;
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  try {
    const enviar = (url, corpo, tipo = 'application/json') => fetch(base + url, { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': tipo }, body: corpo });
    for (const [url, corpo] of [['/api/terminal/entrar', '{'], ['/api/terminal/entrar', 'null'], ['/api/terminal/entrar', '123'], ['/api/terminal/entrar', '"texto"'],
      ['/api/terminal/primeiro-acesso', '{"matricula":'], ['/api/terminal/saida-admin', 'true'], ['/api/emprestimo/ferramentas', '{codigo:'], ['/api/emprestimo/colaboradores', 'null']]) {
      const r = await enviar(url, corpo);
      assert.equal(r.status, 400, `${url} ${corpo}`);
      assert.deepEqual(await r.json(), { ok: false, erro: 'Corpo da requisição inválido: envie um objeto JSON.' });
    }
    const r = await enviar('/api/terminal/entrar', '{}', 'application/json; charset=iso-8859-1');
    assert.equal(r.status, 415, 'charset que o leitor do corpo não aceita: o 4xx dele, não 500');
    assert.deepEqual(await r.json(), { ok: false, erro: 'Requisição inválida.' });
  } finally { console.error = orig; }
  assert.deepEqual(logs.filter(l => /\[HTTP\]/.test(l)), [], 'erro do cliente não é erro interno');
}));
