'use strict';
// Manutinho · cobrança de treinamento (POST /api/manutinho/cobrar, função lms.copiloto_cobrar da migration 39) contra
// PostgreSQL real. Portado do teste do Copiloto: as permissões são as mesmas; a mensagem agora é um modelo fixo.
// Nenhum teste chama a internet. Dados inventados.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h, U, grupo, outro;
const API = '/api/manutinho';
const realFetch = globalThis.fetch;
const externos = [];
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('http://127.0.0.1:')) externos.push(String(url));
  return realFetch(url, opts);
};
test.before(async () => {
  h = await subirApp({ gestor: 'gestor', lider: 'lider', tec: 'tecnico', tec2: 'tecnico', fora: 'tecnico', almox: 'almoxarife' }); U = h.users;
  grupo = (await h.q(`INSERT INTO core.grupo(codigo,nome,responsavel_id) VALUES('c-mec','[TESTE] Mecânica',$1) RETURNING id`, [U.lider.id])).rows[0].id;
  outro = (await h.q(`INSERT INTO core.grupo(codigo,nome) VALUES('c-aut','[TESTE] Automação') RETURNING id`)).rows[0].id;
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id = ANY($2::uuid[])', [grupo, [U.tec.id, U.tec2.id, U.lider.id]]);
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id=$2', [outro, U.fora.id]);
  for (const k of ['tec', 'tec2', 'lider', 'fora']) U[k].sv = (await h.q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [U[k].id])).rows[0].sessao_versao;
});
test.after(() => { globalThis.fetch = realFetch; return h?.fechar(); });

const fila = () => h.q(`SELECT destinatario::text d, copia::text c, assunto, corpo_html, motivo FROM core.email_fila WHERE motivo='copiloto_cobranca' ORDER BY criado_em`).then(r => r.rows);
const cobrar = (u, itens, extra = {}) => h.api(u, 'POST', `${API}/cobrar`, { itens, ...extra });

test('o Copiloto saiu: /api/copiloto/chat e /status não existem mais como API', async () => {
  assert.equal((await h.api(U.tec, 'POST', '/api/copiloto/chat', { mensagens: [{ role: 'user', content: 'oi' }] })).s, 404);
  const st = await h.raw(U.tec, 'GET', '/api/copiloto/status');
  assert.doesNotMatch(st.headers.get('content-type') || '', /json/, 'GET cai no index.html do front, não numa API');
  await st.arrayBuffer();
  assert.equal(externos.length, 0, 'nada vai para serviço externo');
});

test('cobrar: exige login', async () => {
  const r = await h.raw(null, 'POST', `${API}/cobrar`);
  assert.equal(r.status, 401); await r.arrayBuffer();
});

test('cobrar: só líder/gestor/admin, só a própria equipe, nunca a si, uma vez por dia, com o líder em cópia', async () => {
  const item = (u, cursos = ['[TESTE] NR-12 Segurança em máquinas']) => ({ pessoaId: u.id, cursos });
  assert.equal((await cobrar(U.tec, [item(U.tec2)])).s, 403, 'técnico não cobra');
  assert.equal((await cobrar(U.almox, [item(U.tec)])).s, 403, 'almoxarife não cobra');
  assert.equal((await cobrar(U.lider, [item(U.fora)])).s, 403, 'líder não cobra quem é de outro grupo');
  assert.equal((await cobrar(U.lider, [item(U.lider)])).s, 400, 'ninguém cobra a si mesmo');
  assert.equal((await cobrar(U.lider, [])).s, 400);
  assert.equal((await cobrar(U.lider, Array.from({ length: 26 }, () => item(U.tec)))).s, 400, 'no máximo 25 pessoas');
  assert.equal((await cobrar(U.lider, [{ pessoaId: 'não-é-uuid', cursos: [] }])).s, 400);
  assert.equal((await fila()).length, 0, 'nada foi enfileirado até aqui');
  const r = await cobrar(U.lider, [item(U.tec, ['[TESTE] NR-12 <script>alert(1)</script>', '[TESTE] Curso B'])], { mensagem: 'TEXTO LIVRE <b>por favor</b>' });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.enviados, 1);
  const f = await fila();
  assert.equal(f.length, 1);
  assert.equal(f[0].d, U.tec.email); assert.match(f[0].c, new RegExp(U.lider.email));
  assert.equal(f[0].assunto, '[Lembrete] Treinamento pendente', 'assunto do modelo fixo');
  assert.match(f[0].corpo_html, /Pessoa lider pediu que você conclua estes treinamentos/);
  assert.match(f[0].corpo_html, /Curso B/); assert.match(f[0].corpo_html, /Treinamentos › Meus cursos/);
  assert.doesNotMatch(f[0].corpo_html, /<script>/, 'título do curso é escapado');
  assert.doesNotMatch(f[0].corpo_html, /TEXTO LIVRE/, 'o texto livre do navegador não entra: o modelo é fixo');
  assert.equal((await cobrar(U.lider, [item(U.tec)])).s, 409, 'a mesma pessoa só recebe de novo depois de 24 h');
  const gestor = await cobrar(U.gestor, [item(U.fora), item(U.tec2)]);
  assert.equal(gestor.s, 200); assert.equal(gestor.j.enviados, 2, 'gestor cobra qualquer equipe');
  const misto = await cobrar(U.lider, [item(U.tec2), item(U.fora)]);
  assert.equal(misto.s, 200, 'lote misto: devolve 200 com o resultado de cada pessoa');
  assert.deepEqual(misto.j.resultado.map(x => x.resultado), ['repetida', 'fora_da_equipe']);
  assert.equal(misto.j.enviados, 0); assert.equal(misto.j.avisos.length, 2);
  assert.equal((await fila()).length, 3);
});

test('cobrar: limite diário de 40 por quem cobra', async () => {
  await h.q(`INSERT INTO core.email_fila(destinatario, copia, assunto, corpo_html, referencia_tabela, referencia_id, motivo)
    SELECT 'x'||g||'@teste.invalid', ARRAY[$1]::citext[], 'a', 'b', 'copiloto.cobranca', gen_random_uuid()::text, 'copiloto_cobranca' FROM generate_series(1,40) g`, [U.gestor.email]);
  await h.q(`UPDATE core.email_fila SET criado_em = now() WHERE motivo='copiloto_cobranca'`);
  const r = await cobrar(U.gestor, [{ pessoaId: U.almox.id, cursos: [] }]);
  assert.equal(r.s, 429, JSON.stringify(r.j));
});

test('migration 39 e reaplicação completa preservam fila, função e permissões sem conceder acesso extra', async () => {
  const fs = require('node:fs'), path = require('node:path'), dir = path.resolve(__dirname, '../../database/migrations');
  const sql = fs.readFileSync(path.join(dir, '39-copiloto-cobranca.sql'), 'utf8');
  assert.match(sql, /pg_advisory_xact_lock\(3901, hashtext\(v_eu.id::text\)\)/);
  assert.match(sql, /pg_advisory_xact_lock\(3902, hashtext\(p_alvo::text\)\)/);
  assert.ok(sql.indexOf('pg_advisory_xact_lock(3901') < sql.indexOf('pg_advisory_xact_lock(3902'));
  assert.ok(sql.indexOf('pg_advisory_xact_lock(3902') < sql.indexOf("IF EXISTS (SELECT 1 FROM core.email_fila"));
  const snapshot = async () => (await h.q("SELECT * FROM core.email_fila WHERE motivo='copiloto_cobranca' ORDER BY id")).rows;
  const before = await snapshot(); assert.ok(before.length);
  await h.db.exec(sql); assert.deepEqual(await snapshot(), before);
  for (const f of fs.readdirSync(dir).filter(f => /^\d.*\.sql$/.test(f)).sort()) await h.db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.deepEqual(await snapshot(), before);
  const permissions = (await h.q("SELECT has_function_privilege('biotrop_app','lms.copiloto_cobrar(uuid,text,text)','EXECUTE') app, has_function_privilege('biotrop_ro','lms.copiloto_cobrar(uuid,text,text)','EXECUTE') ro")).rows[0];
  assert.equal(permissions.app, true); assert.equal(permissions.ro, false);
  assert.equal((await h.transaction(U.tec, c => c.query("SELECT lms.copiloto_cobrar($1,'Sintético','Teste') r", [U.tec2.id]))).rows[0].r, 'sem_permissao');
  assert.equal((await h.transaction(U.lider, c => c.query("SELECT lms.copiloto_cobrar($1,'Sintético','Teste') r", [U.tec.id]))).rows[0].r, 'repetida');
});
