'use strict';
// Revisão adversarial de 27/10 (limites do login do terminal, semáforo do scrypt, modo de teste e Início):
//  1. soFalhas conta só falha de credencial (401, ou 400 marcado), nunca 503/429/400 de validação;
//  2. a tentativa é reservada na entrada (rajada paralela não passa do teto) e o aborto não zera nem some;
//  3. a vaga do scrypt vem antes da reserva no banco e fica até o último hash (sem 503 depois de reservar);
//  4. o modo de teste manda expectedVersion ao regravar o progresso do treinamento (sem 428);
//  5. botões data-nav desenhados depois de attachRoleHomeEvents navegam pelo clique delegado, sem duplicar.
// Banco falso (sem PostgreSQL) e scrypt falso; matrículas, nomes e senhas fictícios.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';
process.env.PERMITIR_SEM_ORIGEM = '1';

// scrypt falso e lento (conta quantos rodam) e banco falso, ANTES de carregar os módulos
crypto.scrypt = (_senha, _sal, tam, _op, cb) => { setTimeout(() => cb(null, Buffer.alloc(tam, 7)), 15); };
const banco = { handler: () => [] };
require.cache[require.resolve('../src/db/pool')] = { id: 'pool-falso', loaded: true, exports: {
  pool: { query: async () => ({ rows: [] }) },
  transaction: async (_quem, fn) => fn({ query: async (sql, args) => ({ rows: await banco.handler(sql, args) }) })
} };

const { rateLimit } = require('../src/middleware/security');

/* ---------------------------------------------------------------- 1 e 2: rateLimit soFalhas */
function resposta() {
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, headers: {}, locals: {}, writableFinished: false,
    set(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  return res;
}
function abrir(guard, matricula) {
  const res = resposta(); let passou = false;
  guard({ ip: '10.9.9.9', body: { matricula } }, res, () => { passou = true; });
  return { passou, res,
    fim(status, credencial = false) { res.statusCode = status; if (credencial) res.locals.falhaCredencial = true; res.writableFinished = true; res.emit('finish'); res.emit('close'); },
    abortar() { res.emit('close'); } };
}
const tenta = (guard, m, status, credencial) => { const a = abrir(guard, m); if (!a.passou) return a.res.statusCode; a.fim(status, credencial); return status; };

test('1. soFalhas: 503 do semáforo, 429 seguinte e 400 de validação não contam; 401 e 400 de credencial contam', () => {
  const guard = rateLimit({ limit: 2, windowMs: 60_000, soFalhas: true, chave: req => req.body.matricula });
  for (let i = 0; i < 6; i += 1) {
    assert.equal(tenta(guard, 'T90001', 503), 503, 'ocupado não conta');
    assert.equal(tenta(guard, 'T90001', 429), 429, 'limite seguinte não conta');
    assert.equal(tenta(guard, 'T90001', 400), 400, 'senha fraca (validação) não conta');
  }
  assert.deepEqual([tenta(guard, 'T90002', 400, true), tenta(guard, 'T90002', 401), tenta(guard, 'T90002', 200)], [400, 401, 429],
    'código de convite errado (400 marcado) e senha errada (401) contam');
});

test('2. soFalhas: rajada paralela não passa do teto; aborto conta como erro e não zera', () => {
  const guard = rateLimit({ limit: 3, windowMs: 60_000, soFalhas: true, chave: req => req.body.matricula });
  const rajada = Array.from({ length: 8 }, () => abrir(guard, 'T90003'));
  assert.equal(rajada.filter(a => a.passou).length, 3, 'só 3 em andamento ao mesmo tempo');
  assert.ok(rajada.filter(a => !a.passou).every(a => a.res.statusCode === 429));
  rajada.filter(a => a.passou).forEach(a => a.fim(401));
  assert.equal(tenta(guard, 'T90003', 200), 429, 'os 3 erros seguram a próxima');

  // vaga devolvida: em andamento que termina 503 libera a reserva
  const g2 = rateLimit({ limit: 1, windowMs: 60_000, soFalhas: true, chave: req => req.body.matricula });
  const a = abrir(g2, 'T90004');
  assert.equal(abrir(g2, 'T90004').passou, false, 'reservada: a segunda espera');
  a.fim(503);
  assert.equal(tenta(g2, 'T90004', 200), 200, 'o 503 devolveu a vaga');

  // aborto (close sem finish, status ainda 200): conta como erro, não zera os anteriores
  const g3 = rateLimit({ limit: 2, windowMs: 60_000, soFalhas: true, chave: req => req.body.matricula });
  assert.equal(tenta(g3, 'T90005', 401), 401);
  abrir(g3, 'T90005').abortar();
  assert.equal(tenta(g3, 'T90005', 200), 429, 'erro + aborto = 2: bloqueado (o 200 padrão do aborto não zerou)');
});

/* ---------------------------------------------------------------- 3: vaga do scrypt antes da reserva no banco */
async function subir() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/terminal', require('../src/routes/terminal'));
  const srv = await new Promise(ok => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  return { srv, url: `http://127.0.0.1:${srv.address().port}/api/terminal` };
}
const espera = ms => new Promise(ok => setTimeout(ok, ms));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.status);

test('3. /entrar com regravação do hash: quem reservou no banco nunca recebe 503 (vaga antes da reserva)', async () => {
  const sal = Buffer.alloc(16, 1).toString('base64'), h = Buffer.alloc(32, 7).toString('base64');
  const hashAntigo = `scrypt$1$${2 ** 12}$8$1$${sal}$${h}`;   // confere com o scrypt falso e pede regravação
  const n = { inicio: 0, fim: 0, novoHash: 0 };
  banco.handler = async (sql, args) => {
    if (sql.includes('terminal_login_inicio')) { n.inicio += 1; await espera(10);
      return [{ situacao: 'verificar', senha_hash: hashAntigo, usuario_id: '00000000-0000-0000-0000-0000000000a1', versao: 1 }]; }
    if (sql.includes('terminal_parametros_hash')) return [{ p: [] }];
    if (sql.includes('terminal_login_fim')) { n.fim += 1; if (args[6]) n.novoHash += 1;
      return [{ usuario_id: args[0], versao: 1, nome: '[TESTE] Colaborador', matricula: 'T90010', inatividade: 60, expira_em: new Date().toISOString() }]; }
    if (sql.includes('terminal_prazo_padrao')) return [{ p: 24 }];
    return [];
  };
  const { srv, url } = await subir();
  try {
    const st = await Promise.all(Array.from({ length: 40 }, () => post(`${url}/entrar`, { matricula: 'T90010', senha: 'Senha-Ficticia-1' })));
    const ocupados = st.filter(s => s === 503).length;
    assert.ok(ocupados > 0, 'a rajada encheu o semáforo');
    assert.equal(n.inicio, 40 - ocupados, 'o 503 sai antes de reservar a tentativa no banco');
    assert.equal(n.fim, n.inicio, 'toda reserva foi concluída (nenhuma ficou pendente contando como erro)');
    assert.equal(n.novoHash, n.inicio, 'a regravação do hash rodou na mesma vaga');
    assert.ok(st.every(s => s === 200 || s === 503), JSON.stringify(st));
  } finally { srv.close(); }
});

test('3. /primeiro-acesso: o 503 sai antes de terminal_reservar_tentativa; reservado sempre calcula o hash', async () => {
  const n = { reserva: 0, conclui: 0 };
  banco.handler = async sql => {
    if (sql.includes('terminal_reservar_tentativa')) { n.reserva += 1; await espera(10); return [{ ok: true }]; }
    if (sql.includes('terminal_primeiro_acesso')) { n.conclui += 1; return [{ situacao: 'codigo' }]; }
    return [];
  };
  const { srv, url } = await subir();
  try {
    const st = await Promise.all(Array.from({ length: 40 }, () => post(`${url}/primeiro-acesso`, { matricula: 'T90011', codigo: 'ABCD-EFGH', senha: '615283' })));
    const ocupados = st.filter(s => s === 503).length;
    assert.ok(ocupados > 0, 'a rajada encheu o semáforo');
    assert.equal(n.reserva, 40 - ocupados, 'nenhum 503 depois de reservar');
    assert.equal(n.conclui, n.reserva);
    assert.ok(st.filter(s => s !== 503).every(s => s === 400));
  } finally { srv.close(); }
});

/* ---------------------------------------------------------------- 4: modo de teste manda a versão do progresso */
test('4. "Fazer treinamento" duas vezes no mesmo curso: a segunda manda expectedVersion e não leva 428', async () => {
  const { Simulacao } = require('../src/simulacao/motor');
  const sim = new Simulacao();
  const store = new Map(), puts = [];
  sim.http = async (_u, _nome, method, url, body) => {
    if (method === 'GET' && url === '/api/data/lms_courses') return { s: 200, j: { rows: [{ recordId: 'curso-teste-1', payload: { id: 'curso-teste-1' } }] } };
    if (method === 'GET' && url === '/api/data/lms_progress') return { s: 200, j: { rows: [...store.values()] } };
    if (method === 'PUT' && url.startsWith('/api/data/lms_progress/')) {
      const id = url.split('/').pop(), atual = store.get(id), exp = body.expectedVersion ?? null;
      puts.push(exp);
      if (atual && exp === null) return { s: 428, j: {} };   // mesma regra de routes/data.js
      if ((atual ? atual.version : 0) !== Number(exp ?? 0)) return { s: 409, j: {} };
      store.set(id, { recordId: id, version: (atual?.version || 0) + 1, payload: body.payload });
      return { s: 200, j: {} };
    }
    return { s: 200, j: { rows: [] } };
  };
  sim.criados = { progresso: 0 };
  const u = { id: 'sim-teste-u1', nome: '[TESTE] Usuário virtual' };
  const random = Math.random; Math.random = () => 0;   // sorteia sempre o curso (não o "nenhum")
  try { await sim.treinamento(u); await sim.treinamento(u); } finally { Math.random = random; }
  assert.deepEqual(puts, [0, 1], 'primeira com 0, segunda com a versão lida');
  assert.equal(sim.criados.progresso, 2);
});


/* ---------------------------------------------------------------- A: teto do Map sem "lavar" contador ativo */
test('A. Map no teto (10.000 chaves): chave nova é recusada e o contador da matrícula atacada não é apagado', () => {
  const guard = rateLimit({ limit: 2, windowMs: 60_000, soFalhas: true, chave: req => req.body.matricula });
  assert.equal(tenta(guard, 'T99999', 401), 401);
  assert.equal(tenta(guard, 'T99999', 401), 401);   // vítima: 2 erros, bloqueada
  for (let i = 0; i < 10_000; i += 1) tenta(guard, `X${i}`, 401);   // atacante enche o Map de chaves com erro
  assert.equal(tenta(guard, 'T99999', 200), 429, 'o contador da vítima continua (não foi apagado para abrir espaço)');
  assert.equal(tenta(guard, 'NOVA1', 200), 429, 'cheio: chave nova recusada');
});
