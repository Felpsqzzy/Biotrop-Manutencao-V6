const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const { rateLimit, requireSameOrigin } = require('./middleware/security');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
// CSP: script só de arquivo da mesma origem (nada de <script> inline nem on*=). Exceção: o Inventário offline
// (/ferramentas/inventario.html, página única com JS embutido), que mantém 'unsafe-inline'.
const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com'],
  mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
  // Aulas de treinamento: YouTube (com e sem cookie) e PDF/arquivo anexado.
  frameSrc: ["'self'", 'blob:', 'https://www.youtube-nocookie.com', 'https://www.youtube.com'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"]
};
const INVENTARIO = /^\/ferramentas\/inventario(?:\.html)?$/;
const cspEstrita = helmet.contentSecurityPolicy({ directives: CSP });
const cspInventario = helmet.contentSecurityPolicy({ directives: { ...CSP, scriptSrc: ["'self'", "'unsafe-inline'"] } });
app.use((req, res, next) => (INVENTARIO.test(req.path) ? cspInventario : cspEstrita)(req, res, next));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // HSTS é enviado pelo nginx (um cabeçalho só, com a política definida na borda).
  strictTransportSecurity: false,
  // O player do YouTube recusa embed sem Referer (erro 153).
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(compression());

const web = config.webDir;   // apps/web/dist (build do Vite)
// Estático ANTES dos limites: os arquivos de cada página não podem gastar o limite de ninguém nem abrir transação no
// banco (em produção o limite é contado no PostgreSQL). dist/assets/ tem hash no nome (Vite): cache de 1 ano, imutável.
// HTML e os demais JS/CSS/JSON fora do hash: no-cache + ETag (o navegador revalida e recebe 304; depois de um deploy, o
// index novo nunca roda com o JS antigo). Imagens e ícones: 1 dia.
const REVALIDAR = /\.(?:js|mjs|css|html|json|webmanifest)$/i;
const ASSETS_COM_HASH = path.join(web, 'assets') + path.sep;
// Página do terminal (tablet): arquivo próprio, fora do index.html do site; sem o arquivo, 404 (nunca cai no site).
app.get('/terminal', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(web, 'terminal.html'), err => { if (err && !res.headersSent) res.status(404).end(); });
});
app.use(express.static(web, { etag:true, maxAge:config.production?'1d':0, index:false, dotfiles:'ignore',
  setHeaders: (res, arquivo) => {
    if (arquivo.startsWith(ASSETS_COM_HASH)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (REVALIDAR.test(arquivo)) res.setHeader('Cache-Control', 'no-cache');
  } }));

// Cookies antes dos limites: o limite geral conta por pessoa da sessão (só confere a assinatura do cookie, sem banco).
app.use(cookieParser());
// Recusa abuso e mutações de outra origem antes de gastar CPU/memória analisando JSON. Números para a fábrica (~50 pessoas
// atrás de um IP só): 600/min por pessoa com sessão (a aba de cadastros do PCM faz ~9 GETs a cada 15 s = 36/min; sobra
// para várias abas, navegação e importações) e 600/min por IP sem sessão (tela de login de todo mundo na troca de turno).
app.use(rateLimit({ limit: 600, windowMs: 60_000, porUsuario: true, bucket: 'geral' }));
// Login Microsoft (/auth/me é sessão: fica no geral, por pessoa). Estrito por IP: 300 em 15 min = 50 pessoas × 2
// pedidos por login (/microsoft e /callback) × 3 tentativas. A senha fica no Entra, que tem a própria proteção.
app.use(/^\/auth\/(?!me$).*/, rateLimit({ limit: 300, windowMs: 15 * 60_000, bucket: 'auth' }));
// Força bruta no código de 6 dígitos: além do limite por pessoa no banco (twofa.js), 20 tentativas por pessoa a cada 15 min.
app.use('/api/conta/2fa', rateLimit({ limit: 20, windowMs: 15 * 60_000, methods: ['POST'], porUsuario: true, bucket: 'conta-2fa' }));
// Rotas pesadas de escrita: importação de folhas (preventivas) e o catálogo do almoxarifado (planilha em partes, fotos).
app.use('/api/pcm/preventivas/importar', rateLimit({ limit: 20, windowMs: 15 * 60_000, methods: ['POST'], porUsuario: true, bucket: 'preventivas-importar' }));
app.use('/api/almox/materiais', rateLimit({ limit: 400, windowMs: 15 * 60_000, methods: ['POST', 'PUT', 'DELETE'], porUsuario: true }));
// Terminal do almoxarifado (tablet = um IP só para todo mundo): limites por IP, buckets próprios. Geral do terminal:
// 3000 em 15 min (50 pessoas × ~60 pedidos: lista com miniaturas, retirada, devolução). Login, primeiro acesso e saída
// administrativa: mais abaixo, depois do JSON (a chave usa a matrícula). Sem diferenciar maiúsculas e com barra final
// opcional, como o roteador do Express (senão /ENTRAR/ escaparia do limite).
const LOGIN_TERMINAL = /^\/api\/terminal\/(entrar|primeiro-acesso|saida-admin)\/?$/i;
app.use('/api/terminal', rateLimit({ limit: 3000, windowMs: 15 * 60_000, bucket: 'terminal-api' }));
app.use('/api', requireSameOrigin);
app.use(express.json({ limit:'2mb' }));
// Login do terminal, nesta ordem: 10 ERROS em 15 min por IP + matrícula (quem erra a própria senha, ou um robô numa
// matrícula só, para aqui e não gasta o limite do tablet; login certo não conta) e 200 pedidos em 15 min por IP
// (50 pessoas × retirada e devolução, com folga para erro; segura quem varia a matrícula). O apertado continua no
// banco: 5 erros bloqueiam a matrícula e 30 erros em 15 min bloqueiam o aparelho (migration 41).
app.use(LOGIN_TERMINAL, rateLimit({ limit: 10, windowMs: 15 * 60_000, methods: ['POST'], bucket: 'terminal-login-matricula', soFalhas: true,
  chave: req => String(typeof req.body?.matricula === 'string' || typeof req.body?.matricula === 'number' ? req.body.matricula : '').trim().toLowerCase() }));
app.use(LOGIN_TERMINAL, rateLimit({ limit: 200, windowMs: 15 * 60_000, methods: ['POST'], bucket: 'terminal-login' }));

app.use('/health', require('./routes/health'));
app.use('/auth', require('./routes/auth'));
app.use('/api/data', require('./routes/data'));
app.use('/api/master-data', require('./routes/master-data'));
app.use('/api/pcm/preventivas', require('./routes/pcm-preventivas'));
app.use('/api/pcm/bateladas/importar', rateLimit({ limit: 30, windowMs: 15 * 60_000, methods: ['POST'], porUsuario: true }));
app.use('/api/pcm/bateladas', require('./routes/pcm-bateladas'));
app.use('/api/almox/materiais', require('./routes/almox-materiais'));
app.use('/api/inventario', require('./routes/inventario'));
app.use('/api/emprestimo', rateLimit({ limit: 600, windowMs: 15 * 60_000, methods: ['POST', 'PUT', 'DELETE'], porUsuario: true }));   // DELETE: remover a foto
app.use('/api/emprestimo/avisos', require('./routes/emprestimo-avisos'));
app.use('/api/emprestimo', require('./routes/emprestimo'));
app.use('/api/terminal', require('./routes/terminal'));   // sessão própria (cookie do terminal); o requireAuth do site não vale aqui
app.use('/api/admin/simulacao', require('./routes/simulacao'));
app.use('/api/realtime', require('./routes/realtime'));
app.use('/api/lms', require('./routes/lms'));
app.use('/api/copiloto', require('./routes/copiloto'));
app.use('/api/conta/2fa', require('./routes/twofa'));
app.use('/api/conta', require('./routes/account'));

// Modelos de planilha da operação (prontuário de diafragmas): ficam FORA da pasta pública (server/modelos) e só
// saem por esta rota, com sessão válida e nome exato da lista. Caminho codificado (%6Dodelos) ou duplicado não
// cai aqui e também não encontra o arquivo no estático — antes, o estático servia o arquivo sem login.
const MODELOS = path.resolve(__dirname, '..', 'modelos');
const MODELOS_PERMITIDOS = new Set(['prontuario-diafragmas-rev12.xlsx']);
app.get('/assets/modelos/:arquivo', requireAuth, (req, res) => {
  const nome = String(req.params.arquivo || '');
  if (!MODELOS_PERMITIDOS.has(nome)) return res.status(404).end();
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(MODELOS, nome), { dotfiles: 'deny', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
});
app.get('*', (_req,res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(web,'index.html')); });

// Log sem dados: nada de parâmetros de SQL, "detail" do PostgreSQL, corpo da requisição, cookies ou texto cifrado.
function resumoErro(error) {
  return { nome: /^[A-Za-z]{1,40}$/.test(error?.name||'')?error.name:'Error', codigo: /^[A-Z0-9_]{1,40}$/.test(error?.codigo||error?.code||'')?(error.codigo||error.code):'INTERNO' };
}
app.use((error,req,res,_next) => {
  if (error?.codigo === 'KMS_INDISPONIVEL') {
    console.error('[CIFRA] KMS indisponível — requisição recusada (falha fechada)', req.method, req.path);
    return res.status(503).json({ ok:false, erro:'Serviço de chaves indisponível. Tente em instantes.' });
  }
  // Corpo acima do limite do express.json (2 MB): resposta clara em vez de erro interno (ex.: foto que não foi reduzida).
  if (error?.type === 'entity.too.large') return res.status(413).json({ ok:false, erro:'Envio grande demais (máximo de 2 MB por vez).' });
  // Corpo que o express.json recusa: JSON malformado, ou null/número/texto solto (o modo estrito só aceita objeto ou
  // lista). É erro de quem chamou (400), não do serviço: antes caía no 500 abaixo e disparava o log de erro interno.
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ ok:false, erro:'Corpo da requisição inválido: envie um objeto JSON.' });
  // Demais recusas do leitor do corpo (charset ou compressão não suportados, envio interrompido): o 4xx que ele indicou.
  const st = Number(error?.status ?? error?.statusCode);
  if (typeof error?.type === 'string' && error.expose === true && st >= 400 && st < 500) return res.status(st).json({ ok:false, erro:'Requisição inválida.' });
  // Corpo gzip/deflate corrompido: o leitor do corpo marca 400, mas o erro do zlib (code Z_DATA_ERROR...) não traz "type".
  if (/^Z_[A-Z_]+$/.test(String(error?.code || '')) && error.expose === true && st === 400) return res.status(400).json({ ok:false, erro:'Corpo da requisição inválido.' });
  // Caminho com porcentagem malformada (/emprestimos/%E0%A4%A): o roteador do Express lança URIError com status 400.
  if (error instanceof URIError && st === 400) return res.status(400).json({ ok:false, erro:'Endereço inválido.' });
  console.error('[HTTP]', req.method, req.path, JSON.stringify(resumoErro(error)));
  res.status(500).json({ ok:false, erro:'Erro interno. Consulte os logs do serviço.' });
});

module.exports = app;
