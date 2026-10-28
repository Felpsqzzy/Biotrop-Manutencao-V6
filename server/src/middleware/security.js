const config = require('../config');
const { verifySession, COOKIE } = require('../auth/session');

/**
 * Quem conta no limite (a fábrica inteira sai por um IP só, então o IP sozinho junta ~50 pessoas no mesmo balde):
 *  • porUsuario: a pessoa da sessão do site (cookie assinado, conferido só pelo HMAC, sem banco); sem sessão válida, o IP;
 *  • chave(req): IP + um texto da própria requisição (ex.: a matrícula do login): os erros de um não gastam o limite
 *    dos outros no mesmo aparelho;
 *  • nenhum dos dois: o IP (o estrito de /auth e do terminal).
 */
function quemConta(req, porUsuario, chave) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  if (chave) return `${ip}|${String(chave(req) ?? '').slice(0, 64)}`;
  const sessao = porUsuario ? verifySession(req.cookies?.[COOKIE]) : null;
  return sessao ? `u:${sessao.sub}` : ip;
}

// Teto de chaves por limitador na memória (o uso real é ~50 pessoas): ver entrada() abaixo.
const MAX_CHAVES = 10_000;

function rateLimit({ limit, windowMs, methods = null, bucket = null, porUsuario = false, chave = null, soFalhas = false }) {
  const clients = new Map();
  let varridoEm = 0;
  const varrer = now => {
    varridoEm = now;
    for (const [key, value] of clients) if (value.resetAt <= now && !value.reservas) clients.delete(key);
  };
  const cleanup = setInterval(() => varrer(Date.now()), Math.min(windowMs, 60_000));
  cleanup.unref();
  /**
   * Entrada da chave (janela nova se a dela venceu). Teto de MAX_CHAVES: chave nova com o Map cheio força uma varredura
   * das vencidas (no máximo uma por segundo) e, se continuar cheio, volta null e o pedido é recusado (429). Escolha:
   * nunca apagar contador ativo para abrir espaço, senão quem enchesse o Map de chaves novas "lavaria" os erros da
   * matrícula atacada. O custo é que, cheio, chave nova espera a janela; encher pede milhares de erros de credencial
   * (o soFalhas só guarda chave com erro ou pedido em andamento) e, em produção, os outros limites ficam no banco.
   */
  const entrada = (key, now) => {
    const atual = clients.get(key);
    if (atual && atual.resetAt > now) return atual;
    if (!atual && clients.size >= MAX_CHAVES) {
      if (now - varridoEm >= 1000) varrer(now);
      if (clients.size >= MAX_CHAVES) return null;
    }
    const e = { count: 0, reservas: atual?.reservas || 0, resetAt: now + windowMs };   // janela nova: os em andamento seguem contando
    clients.set(key, e);
    return e;
  };
  const recusar = (res, espera) => {
    if (espera) res.set('Retry-After', String(espera));
    return res.status(429).json({ ok: false, erro: 'Muitas requisições. Aguarde e tente novamente.' });
  };
  return function enforceRateLimit(req, res, next) {
    if (methods && !methods.includes(req.method)) return next();
    const key = quemConta(req, porUsuario, chave);
    if (soFalhas) {
      // Só os erros seguidos contam (o login certo zera, como no banco), na memória do processo e sem banco: é a divisão
      // justa entre quem usa o mesmo aparelho. O limite durável do login fica no banco (matrícula e aparelho, migration 41).
      //  • Erro é só o de credencial: 401, ou 400 com res.locals.falhaCredencial (código de convite errado). 503 do
      //    semáforo, 429 dos limites seguintes e 400 de validação devolvem a vaga.
      //  • A tentativa fica reservada na entrada (erros + em andamento ≤ limite): uma rajada paralela não passa do teto.
      //  • Conexão fechada sem resposta (aborto) conta como erro: o status ainda é o 200 padrão e não pode zerar nada.
      const now = Date.now();
      const atual = entrada(key, now);
      if (!atual) return recusar(res, Math.ceil(Math.min(windowMs, 60_000) / 1000));
      if (atual.count + atual.reservas >= limit) return recusar(res, Math.ceil((atual.resetAt - now) / 1000));
      atual.reservas += 1;
      let feito = false;
      const fechar = abortou => {
        if (feito) return;
        feito = true;
        const e = entrada(key, Date.now());
        if (!e) return;   // a chave venceu e saiu na varredura com o Map cheio: a janela dela já acabou
        e.reservas = Math.max(0, e.reservas - 1);
        const falha = abortou || res.statusCode === 401 || (res.statusCode === 400 && res.locals?.falhaCredencial === true);
        if (falha) e.count += 1;
        else if (res.statusCode < 400) e.count = 0;
        if (!e.count && !e.reservas) clients.delete(key);
      };
      res.on('finish', () => fechar(false));
      res.on('close', () => fechar(!res.writableFinished));
      return next();
    }
    if (config.production) {
      const crypto = require('node:crypto');
      const hashed = crypto.createHmac('sha256',config.sessionSecret).update((bucket || `${limit}:${windowMs}:${methods || 'all'}`) + ':' + key).digest('hex');
      const { transaction } = require('../db/pool');
      return transaction(null, async db => (await db.query('SELECT * FROM app.consumir_limite($1,$2,$3)',[hashed,limit,Math.ceil(windowMs/1000)])).rows[0]).then(row => {
        res.set('RateLimit-Limit',String(limit));res.set('RateLimit-Remaining',String(row.restante));
        if (!row.permitido) {res.set('Retry-After',String(row.espera));return res.status(429).json({ok:false,erro:'Muitas requisições. Aguarde e tente novamente.'});}
        next();
      }).catch(() => res.status(503).json({ok:false,erro:'Controle de acesso temporariamente indisponível.'}));
    }
    const entry = entrada(key, Date.now());
    if (!entry) return recusar(res, Math.ceil(Math.min(windowMs, 60_000) / 1000));
    entry.count += 1;
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    if (entry.count > limit) return recusar(res);
    next();
  };
}

function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = new URL(config.appBaseUrl).origin;
  const supplied = req.get('origin') || req.get('referer');
  // Mutação sem Origin/Referer é recusada em qualquer ambiente (navegadores sempre enviam Origin em POST/PUT/PATCH/DELETE).
  // Só scripts locais de desenvolvimento podem pular, com PERMITIR_SEM_ORIGEM=1 fora de produção.
  if (!supplied && !config.production && process.env.PERMITIR_SEM_ORIGEM === '1') return next();
  if (!supplied) return res.status(403).json({ ok: false, erro: 'Origem não informada.' });
  try {
    if (new URL(supplied).origin === expected) return next();
  } catch (_) {}
  return res.status(403).json({ ok: false, erro: 'Origem não autorizada.' });
}

module.exports = { rateLimit, requireSameOrigin };
