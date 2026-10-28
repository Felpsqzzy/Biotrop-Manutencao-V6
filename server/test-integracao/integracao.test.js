'use strict';
// Integração com PostgreSQL REAL (PGlite/WASM): todas as migrations, RLS ligado, role biotrop_app.
// Roda com:  npm --prefix server run test:integracao
// Cobre: validação de sessão sob RLS, revogação por versão, vínculo ao oid da conta Microsoft, proteção das
// chaves de dados, trilha sem foto/segredos, limpeza de senhas antigas e cifragem ponta a ponta das rotas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

process.env.NODE_ENV = 'test';
process.env.APP_BASE_URL = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgres://x:x@127.0.0.1:1/x';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('base64');
process.env.TWOFA_KEY = crypto.randomBytes(32).toString('base64');
process.env.ENTRA_TENANT_ID = '11111111-1111-1111-1111-111111111111';
process.env.ENTRA_CLIENT_ID = '22222222-2222-2222-2222-222222222222';
process.env.ENTRA_CLIENT_SECRET = 'teste';
process.env.KMS_PROVEDOR = 'local';
process.env.BIOMANUT_KEK_LOCAL = crypto.randomBytes(32).toString('base64');

const MIG = path.resolve(__dirname, '../../database/migrations');
let db, q, users = {}, base, srv, chain = Promise.resolve(), emTx = false;

async function transaction(identity, fn) {
  const run = async () => {
    await db.exec('BEGIN'); emTx = true;
    try {
      await q('SET LOCAL ROLE biotrop_app');
      if (identity?.id) {
        await q("select set_config('app.usuario_id',$1,true)", [String(identity.id)]);
        await q("select set_config('app.usuario_email',$1,true)", [String(identity.email || '')]);
      }
      const out = await fn(cliente);
      await db.exec('COMMIT'); return out;
    } catch (e) { await db.exec('ROLLBACK'); throw e; } finally { emTx = false; }
  };
  const p = chain.then(run, run); chain = p.catch(() => {}); return p;
}
const cliente = { query: async (s, p) => { const r = await q(s, p); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } };
const consultaApp = (s, p) => (emTx ? cliente.query(s, p) : transaction(null, c => c.query(s, p)));

test.before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const ext = {};
  for (const n of ['pgcrypto', 'citext', 'pg_trgm', 'unaccent']) ext[n] = (await import(`@electric-sql/pglite/contrib/${n}`))[n];
  db = new PGlite({ extensions: ext });
  q = (s, p) => db.query(s, p);
  const files = fs.readdirSync(MIG).filter(f => /^\d.*\.sql$/.test(f)).sort();
  for (const rodada of [1, 2]) for (const f of files) {
    try { await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8')); }
    catch (e) { throw new Error(`migration ${f} (rodada ${rodada}) falhou: ${e.message}`); }
  }
  // pessoas de teste (e-mail autorizado + usuário)
  for (const [k, perfil] of Object.entries({ tec: 'tecnico', tec2: 'tecnico', pcm: 'pcm', admin: 'admin' })) {
    const email = `${k}@teste.biotrop`;
    await q(`INSERT INTO core.email_autorizado(email, perfil_padrao, ativo) VALUES($1,$2,true) ON CONFLICT (email) DO UPDATE SET ativo=true, perfil_padrao=excluded.perfil_padrao`, [email, perfil]);
    const r = await q(`INSERT INTO core.usuario(nome,email,perfil_id) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET nome=excluded.nome RETURNING id, sessao_versao`, [`Pessoa ${k}`, email, perfil]);
    users[k] = { id: r.rows[0].id, email, perfilId: perfil, sv: r.rows[0].sessao_versao };
  }
  // app real, com o pool trocado pelo PGlite (role biotrop_app) e o serviço de cifra usando o armazém SQL de verdade
  const orig = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === '../db/pool') return { transaction, pool: { query: consultaApp } };
    return orig.call(this, req, parent, ...rest);
  };
  const { provedorLocal } = require('../src/crypto/kms');
  const { criarChaveiro, armazemPg } = require('../src/crypto/chaveiro');
  const { criarServicoCifra } = require('../src/crypto/cifra');
  const cripto = require('../src/crypto/index');
  const transacao = fn => (emTx ? fn(cliente.query) : transaction(null, c => fn(c.query)));
  const chaveiro = criarChaveiro({ armazem: armazemPg(consultaApp, transacao), kms: provedorLocal({ kekBase64: process.env.BIOMANUT_KEK_LOCAL, producao: false }) });
  cripto.definirServico(Object.assign(criarServicoCifra({ chaveiro, inquilino: 'biotrop' }), { chaveiro }));
  const app = require('../src/app');
  srv = app.listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv?.close(); });

const { createSession } = require('../src/auth/session');
function cookie(u, extra = {}) { const nome = 'biotrop_session'; return `${nome}=${createSession({ id: u.id, sessaoVersao: extra.sv ?? u.sv }).valor}`; }
async function api(u, method, url, body, extra) {
  const r = await fetch(base + url, { method, headers: { cookie: cookie(u, extra), origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j };
}
async function comoApp(identity, sql, params) { return transaction(identity, c => c.query(sql, params)); }

/* ---------------------------------------------------------------- sessão e identidade */
test('BUG corrigido: o SELECT antigo do middleware não enxerga nada sob RLS; app.sessao_usuario enxerga', async () => {
  const antigo = await comoApp(null, `SELECT u.id FROM core.usuario u JOIN core.email_autorizado a ON a.email=u.email WHERE u.id=$1`, [users.tec.id]);
  assert.equal(antigo.rows.length, 0);
  const novo = await comoApp(null, 'SELECT * FROM app.sessao_usuario($1::uuid)', [users.tec.id]);
  assert.equal(novo.rows.length, 1);
  assert.equal(novo.rows[0].email, 'tec@teste.biotrop');
});

test('rota autenticada funciona com o middleware real sob RLS', async () => {
  const r = await api(users.tec, 'GET', '/auth/me');
  assert.equal(r.s, 200); assert.equal(r.j.usuario.id, users.tec.id);
});

test('sair de todos os aparelhos invalida cookies anteriores; bloqueio e troca de perfil também', async () => {
  let r = await api(users.tec2, 'POST', '/auth/logout-todos');
  assert.equal(r.s, 200);
  r = await api(users.tec2, 'GET', '/auth/me');
  assert.equal(r.s, 401, 'cookie antigo recusado');
  const sv = (await q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [users.tec2.id])).rows[0].sessao_versao;
  users.tec2.sv = sv;
  assert.equal((await api(users.tec2, 'GET', '/auth/me')).s, 200, 'cookie novo vale');
  await q(`UPDATE core.usuario SET perfil_id='pcm' WHERE id=$1`, [users.tec2.id]);
  assert.equal((await api(users.tec2, 'GET', '/auth/me')).s, 401, 'troca de perfil derruba a sessão');
  await q(`UPDATE core.usuario SET perfil_id='tecnico' WHERE id=$1`, [users.tec2.id]);
  users.tec2.sv = (await q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [users.tec2.id])).rows[0].sessao_versao;
  await q(`UPDATE core.email_autorizado SET ativo=false, revogado_em=now() WHERE email=$1`, [users.tec2.email]);
  assert.equal((await api(users.tec2, 'GET', '/auth/me')).s, 401, 'autorização revogada derruba a sessão');
  await q(`UPDATE core.email_autorizado SET ativo=true, revogado_em=NULL WHERE email=$1`, [users.tec2.email]);
});

test('login amarrado ao oid: outra conta Microsoft com o mesmo e-mail não entra; sem oid não entra', async () => {
  const oid = crypto.randomUUID(), outro = crypto.randomUUID();
  const email = 'novo@teste.biotrop';
  await q(`INSERT INTO core.email_autorizado(email, perfil_padrao, ativo) VALUES($1,'tecnico',true) ON CONFLICT DO NOTHING`, [email]);
  const prov = (o) => comoApp(null, 'SELECT core.provisionar_acesso($1::citext,$2,$3::uuid,$4::inet,$5) AS id', [email, 'Novo', o, '10.0.0.1', 'teste']);
  const primeiro = (await prov(oid)).rows[0].id;
  assert.ok(primeiro, 'primeiro acesso vincula o oid');
  assert.equal((await prov(oid)).rows[0].id, primeiro, 'mesma conta entra de novo');
  assert.equal((await prov(outro)).rows[0].id, null, 'outra conta com o mesmo e-mail é recusada');
  assert.equal((await prov(null)).rows[0].id, null, 'token sem oid é recusado');
  const motivos = (await q(`SELECT motivo FROM core.login_evento WHERE email=$1 AND NOT sucesso`, [email])).rows.map(r => r.motivo);
  assert.ok(motivos.some(m => /conta Microsoft diferente/.test(m)) && motivos.some(m => /sem oid/.test(m)));
});

/* ---------------------------------------------------------------- chaves e trilhas */
test('app não altera material de chave, não diminui contador, não revoga; leitura só pelo app', async () => {
  const id = crypto.randomUUID();
  await comoApp(null, `INSERT INTO seguranca.chave_dados(id, finalidade, kek_id, dek_envelopada, limite_usos, expira_em) VALUES($1,'teste','local:x',$2,100, now()+interval '1 day')`, [id, crypto.randomBytes(61)]);
  await comoApp(null, 'UPDATE seguranca.chave_dados SET usos_reservados = usos_reservados + 10 WHERE id=$1', [id]);
  await assert.rejects(() => comoApp(null, 'UPDATE seguranca.chave_dados SET usos_reservados = 1 WHERE id=$1', [id]), /não pode diminuir/);
  await assert.rejects(() => comoApp(null, `UPDATE seguranca.chave_dados SET estado='revogada' WHERE id=$1`, [id]), /só pode aposentar|permission denied/);
  await assert.rejects(() => comoApp(null, `UPDATE seguranca.chave_dados SET dek_envelopada=$2 WHERE id=$1`, [id, crypto.randomBytes(61)]), /permission denied|material de chave/);
  await assert.rejects(() => comoApp(null, 'DELETE FROM seguranca.chave_dados WHERE id=$1', [id]), /permission denied/);
  await assert.rejects(() => comoApp(null, `UPDATE seguranca.chave_dados SET usos_reservados = 101 WHERE id=$1`, [id]), /ck_chave_limite|violates/);
  await comoApp(null, `UPDATE seguranca.chave_dados SET estado='aposentada', aposentada_em=now() WHERE id=$1`, [id]);
  await db.exec('BEGIN'); await q('SET LOCAL ROLE biotrop_ro');
  await assert.rejects(() => q('SELECT count(*) FROM seguranca.chave_dados'), /permission denied/);
  await db.exec('ROLLBACK');
});

test('evento de segurança: app não grava em nome de outra pessoa; não-admin não lê', async () => {
  await assert.rejects(() => comoApp(users.tec, `INSERT INTO seguranca.evento(tipo, usuario_id) VALUES('teste.x',$1)`, [users.pcm.id]), /row-level security|violates/);
  await comoApp(users.tec, `INSERT INTO seguranca.evento(tipo, usuario_id) VALUES('teste.x',$1)`, [users.tec.id]);
  assert.equal((await comoApp(users.tec, 'SELECT count(*)::int n FROM seguranca.evento')).rows[0].n, 0);
  assert.ok((await comoApp(users.admin, 'SELECT count(*)::int n FROM seguranca.evento')).rows[0].n >= 1);
});

test('trilha de auditoria não copia foto, telefone nem material de 2FA', async () => {
  await q(`UPDATE core.usuario SET foto='data:image/png;base64,AAAA', telefone='41 99999-0000', totp_pendente='v1.a.b.c' WHERE id=$1`, [users.pcm.id]);
  const r = (await q(`SELECT antes, depois FROM core.auditoria WHERE tabela='core.usuario' AND registro_id=$1 ORDER BY em DESC LIMIT 1`, [users.pcm.id])).rows[0];
  for (const k of ['foto', 'telefone', 'totp_pendente', 'totp_segredo']) { assert.ok(!(k in (r.depois || {})), `depois sem ${k}`); assert.ok(!(k in (r.antes || {})), `antes sem ${k}`); }
});

test('migration 17 remove senhas em claro da importação antiga (mig.dump) ao ser reaplicada', async () => {
  const lote = (await q(`INSERT INTO mig.lote(arquivo) VALUES('teste.json') RETURNING id`)).rows[0].id;
  await q(`INSERT INTO mig.dump(lote_id, chave, conteudo) VALUES($1,'biotrop_users_v2',$2::jsonb)`, [lote, JSON.stringify({ users: [{ email: 'a@b.c', senha: '123456', perfil: 'x', filhos: [{ password: 'p' }] }] })]);
  await db.exec(fs.readFileSync(path.join(MIG, '17-criptografia-e-sessoes.sql'), 'utf8'));
  const t = (await q(`SELECT conteudo::text t FROM mig.dump`)).rows.map(r => r.t).join('');
  assert.ok(!/senha|password/i.test(t), t.slice(0, 200));
  assert.ok(/a@b\.c/.test(t), 'demais dados preservados');
});

/* ---------------------------------------------------------------- cifragem ponta a ponta nas rotas */
test('SCI: foto, observações e trilha vão cifradas para o banco; dono e gestão leem; outro técnico não vê', async () => {
  const foto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let r = await api(users.tec, 'PUT', '/api/data/sci/SCI-T-1', { payload: { id: 'SCI-T-1', status: 'aberto', solicitanteId: users.tec.id, solicitanteNome: 'Pessoa tec', observacoes: 'Válvula com vazamento no dreno', foto }, expectedVersion: 0 });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.row.payload.observacoes, 'Válvula com vazamento no dreno', 'resposta ao autor vem em claro');
  const bruto = (await q(`SELECT payload FROM app.sync_registro WHERE namespace='sci' AND record_id='SCI-T-1'`)).rows[0].payload;
  assert.ok(typeof bruto._cifrado === 'string' && bruto._cifrado.startsWith('bm1.'));
  assert.equal(bruto.observacoes, undefined); assert.equal(bruto.foto, undefined);
  assert.ok(!JSON.stringify(bruto).includes('vazamento'), 'texto sensível não aparece no banco');
  assert.equal(bruto.status, 'aberto', 'campos de autorização ficam em claro para o RLS');
  r = await api(users.tec, 'GET', '/api/data/sci');
  assert.equal(r.j.rows.find(x => x.recordId === 'SCI-T-1').payload.foto, foto);
  r = await api(users.pcm, 'GET', '/api/data/sci');
  assert.equal(r.j.rows.find(x => x.recordId === 'SCI-T-1').payload.observacoes, 'Válvula com vazamento no dreno');
  r = await api(users.tec2, 'GET', '/api/data/sci');
  assert.ok(!r.j.rows.some(x => x.recordId === 'SCI-T-1'), 'outro técnico não recebe o registro');
});

test('bloco cifrado copiado para outro registro não abre (AAD) e gera evento de segurança', async () => {
  await api(users.tec, 'PUT', '/api/data/sci/SCI-T-2', { payload: { id: 'SCI-T-2', status: 'aberto', solicitanteId: users.tec.id, observacoes: 'outro texto' }, expectedVersion: 0 });
  const a = (await q(`SELECT payload FROM app.sync_registro WHERE namespace='sci' AND record_id='SCI-T-1'`)).rows[0].payload._cifrado;
  await q(`UPDATE app.sync_registro SET payload = jsonb_set(payload, '{_cifrado}', to_jsonb($1::text)) WHERE namespace='sci' AND record_id='SCI-T-2'`, [a]);
  const r = await api(users.pcm, 'GET', '/api/data/sci');
  const b = r.j.rows.find(x => x.recordId === 'SCI-T-2');
  assert.equal(b.payload._cifradoIlegivel, true);
  assert.equal(b.payload.observacoes, undefined, 'nenhum texto não autenticado é devolvido');
  await new Promise(res => setTimeout(res, 200));
  assert.ok((await q(`SELECT count(*)::int n FROM seguranca.evento WHERE tipo='cifra.registro_ilegivel'`)).rows[0].n >= 1);
});

test('restaurar o bloco de uma versão antiga na linha atual não abre (versão no AAD)', async () => {
  const v1 = (await q(`SELECT payload FROM app.sync_registro WHERE namespace='sci' AND record_id='SCI-T-1'`)).rows[0].payload._cifrado;
  let r = await api(users.tec, 'PUT', '/api/data/sci/SCI-T-1', { payload: { id: 'SCI-T-1', status: 'aberto', solicitanteId: users.tec.id, observacoes: 'texto da versão 2' }, expectedVersion: 1 });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  await q(`UPDATE app.sync_registro SET payload = jsonb_set(payload, '{_cifrado}', to_jsonb($1::text)) WHERE namespace='sci' AND record_id='SCI-T-1'`, [v1]);
  r = await api(users.pcm, 'GET', '/api/data/sci');
  assert.equal(r.j.rows.find(x => x.recordId === 'SCI-T-1').payload._cifradoIlegivel, true);
});

test('leitura de utilidade: GPS, foto e observação cifrados no banco', async () => {
  const r = await api(users.tec, 'PUT', '/api/data/utility_readings/L-1', { payload: { id: 'L-1', reading: 1234, latitude: -25.43, longitude: -49.27, photoData: 'data:image/jpeg;base64,/9j/AA==', observation: 'visor embaçado' }, expectedVersion: 0 });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const bruto = (await q(`SELECT payload FROM app.sync_registro WHERE namespace='utility_readings' AND record_id='L-1'`)).rows[0].payload;
  assert.equal(bruto.latitude, undefined); assert.equal(bruto.photoData, undefined); assert.equal(bruto.reading, 1234);
  assert.equal(bruto.usuarioId, users.tec.id, 'dono da leitura vem da sessão');
  const lida = (await api(users.tec, 'GET', '/api/data/utility_readings')).j.rows.find(x => x.recordId === 'L-1');
  assert.equal(lida.payload.latitude, -25.43);
});

test('id de registro com caracteres de HTML é recusado', async () => {
  const r = await api(users.tec, 'PUT', '/api/data/sci/' + encodeURIComponent('x"><img src=x onerror=alert(1)>'), { payload: { status: 'Aberto' } });
  assert.equal(r.s, 400);
});

test('Minha conta: telefone e foto gravados cifrados em core.usuario e devolvidos em claro só ao dono', async () => {
  const r = await api(users.tec, 'PATCH', '/api/conta/perfil', { telefone: '41 98888-7777', foto: 'data:image/png;base64,AAAA' });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.perfil.telefone, '+55 (41) 9 8888-7777', 'gravado no formato único, cifrado');
  const bruto = (await q('SELECT telefone, foto FROM core.usuario WHERE id=$1', [users.tec.id])).rows[0];
  assert.ok(bruto.telefone.startsWith('bm1.') && bruto.foto.startsWith('bm1.'));
  // colado na linha de outra pessoa, não abre
  await q('UPDATE core.usuario SET telefone=$1 WHERE id=$2', [bruto.telefone, users.pcm.id]);
  users.pcm.sv = (await q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [users.pcm.id])).rows[0].sessao_versao;
  const me = await api(users.pcm, 'GET', '/auth/me');
  assert.equal(me.j.usuario.telefone, '');
});

test('chaves de dados no banco estão sempre embrulhadas (nunca 32 bytes crus) e com limite de uso', async () => {
  const linhas = (await q('SELECT finalidade, octet_length(dek_envelopada) n, usos_reservados, limite_usos FROM seguranca.chave_dados')).rows;
  assert.ok(linhas.length >= 2);
  for (const l of linhas) { assert.notEqual(l.n, 32); assert.ok(Number(l.usos_reservados) <= Number(l.limite_usos)); }
});

/* ---------------------------------------------------------------- administração de chaves */
// os testes rodam em série (--test-concurrency=1) e nada do app está em andamento aqui; o serviço de cifra usa o pool
// (que no harness passa pela mesma fila), então não se pode segurar a fila enquanto ele roda.
function exclusivo(fn) { return fn(); }
function adminCli() {
  const { criarAdmin } = require('../src/crypto/admin');
  const { obterServico } = require('../src/crypto/index');
  const { provedorLocal } = require('../src/crypto/kms');
  return criarAdmin({ q: (s, p) => db.query(s, p), servico: obterServico(), kms: provedorLocal({ kekBase64: process.env.BIOMANUT_KEK_LOCAL, producao: false }), log: () => {} });
}

test('migrar: registros legados em claro e segredo 2FA no formato v1 passam a ser cifrados', async () => {
  const totp = require('../src/auth/totp');
  const segredo = totp.generateSecret();
  await q(`INSERT INTO app.sync_registro(namespace, record_id, payload) VALUES('scm','SCM-LEG-1',$1::jsonb)`,
    [JSON.stringify({ id: 'SCM-LEG-1', status: 'pendente_aprovacao_lider', solicitanteId: users.tec.id, descricaoUso: 'uso legado em claro' })]);
  await q(`UPDATE core.usuario SET totp_segredo=$2, totp_ativo=true, telefone='41 3333-2222' WHERE id=$1`, [users.admin.id, totp.encrypt(segredo, process.env.TWOFA_KEY)]);
  const r = await exclusivo(() => adminCli().migrar());
  assert.ok(r.registros >= 1 && r.segredos2fa >= 1 && r.telefones >= 1, JSON.stringify(r));
  const bruto = (await q(`SELECT payload FROM app.sync_registro WHERE record_id='SCM-LEG-1'`)).rows[0].payload;
  assert.ok(bruto._cifrado && !JSON.stringify(bruto).includes('legado em claro'));
  const u = (await q('SELECT totp_segredo, telefone FROM core.usuario WHERE id=$1', [users.admin.id])).rows[0];
  assert.ok(u.totp_segredo.startsWith('bm1.') && u.telefone.startsWith('bm1.'));
  const { abrirSegredo2fa } = require('../src/crypto/pessoais');
  assert.equal((await abrirSegredo2fa(users.admin.id, u.totp_segredo)).segredo, segredo);
  const lida = (await api(users.pcm, 'GET', '/api/data/scm')).j.rows.find(x => x.recordId === 'SCM-LEG-1');
  assert.equal(lida.payload.descricaoUso, 'uso legado em claro');
  assert.equal((await exclusivo(() => adminCli().migrar())).registros, 0, 'rodar de novo não refaz nada');
});

test('rotação: aposenta DEK e recifra; DEK antiga só é destruída sem dado apontando (com dado adulterado: só revogação forçada)', async () => {
  const adm = adminCli();
  const { obterServico } = require('../src/crypto/index');
  const antigas = (await q(`SELECT id::text id FROM seguranca.chave_dados WHERE finalidade='dados-operacionais' AND estado='ativa'`)).rows.map(r => r.id);
  assert.ok(antigas.length >= 1);
  await exclusivo(() => adm.rotacionar({ finalidade: 'dados-operacionais' }));
  obterServico().chaveiro.esquecer();   // equivale a reiniciar o app (descarta blocos reservados da DEK antiga)
  await assert.rejects(() => exclusivo(() => adm.revogar({ dek: antigas[0] })), /ainda protege/);   // antes de recifrar
  const rc = await exclusivo(() => adm.recifrar({ finalidade: 'dados-operacionais' }));
  assert.ok(rc.registros >= 1, JSON.stringify(rc));
  // os únicos dados que ainda usam DEK antiga são os dois registros adulterados de propósito nos testes de AAD
  // (SCI-T-1: versão antiga restaurada; SCI-T-2: bloco copiado de outro registro) — ilegíveis, não são recifrados
  const { desempacotar } = require('../src/crypto/formato');
  const adulterados = (await q(`SELECT payload->>'_cifrado' c FROM app.sync_registro WHERE namespace='sci' AND record_id IN ('SCI-T-1','SCI-T-2')`)).rows.map(r => desempacotar(r.c).dekId);
  const refs = await exclusivo(() => adm.referencias());
  for (const id of antigas) assert.equal(refs.get(id) || 0, adulterados.filter(x => x === id).length, 'só os registros adulterados seguram a DEK antiga');
  const dekAdulterado = adulterados.find(id => antigas.includes(id));
  const livres = antigas.filter(id => !adulterados.includes(id));
  for (const id of livres) { await exclusivo(() => adm.revogar({ dek: id })); await exclusivo(() => adm.destruir({ dek: id })); }
  for (const id of livres) {
    const d = (await q(`SELECT estado, dek_envelopada FROM seguranca.chave_dados WHERE id=$1::uuid`, [id])).rows[0];
    assert.equal(d.estado, 'destruida'); assert.equal(d.dek_envelopada, null);
  }
  if (dekAdulterado) {
    // caminho de incidente: revogar só com --forcar; destruir continua proibido enquanto houver dado apontando para ela
    await exclusivo(() => adm.revogar({ dek: dekAdulterado, forcar: true }));
    await assert.rejects(() => exclusivo(() => adm.destruir({ dek: dekAdulterado })), /não pode ser destruída/);
    assert.equal((await q(`SELECT estado FROM seguranca.chave_dados WHERE id=$1::uuid`, [dekAdulterado])).rows[0].estado, 'revogada');
  }
  obterServico().chaveiro.esquecer();
  const rows = (await api(users.pcm, 'GET', '/api/data/sci')).j.rows;
  assert.equal(rows.find(x => x.recordId === 'SCI-T-1').payload._cifradoIlegivel, true, 'registro adulterado no teste anterior continua ilegível');
  const lidos = (await api(users.pcm, 'GET', '/api/data/scm')).j.rows.find(x => x.recordId === 'SCM-LEG-1');
  assert.equal(lidos.payload.descricaoUso, 'uso legado em claro', 'dado recifrado abre com a DEK nova');
  assert.ok((await q(`SELECT count(*)::int n FROM seguranca.evento WHERE tipo LIKE 'chave.%'`)).rows[0].n >= 4, 'operações de chave auditadas');
});
