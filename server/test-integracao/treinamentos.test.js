'use strict';
// Treinamentos (migration 29): equipe vinda do banco, certificado por e-mail, cobrança de prazo, curso não se exclui.
const test = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_harness');

let h, grupo, outroGrupo;
test.before(async () => {
  h = await subirApp({ adm: 'admin', gest: 'gestor', lider: 'lider', tec: 'tecnico', tec2: 'tecnico', fora: 'tecnico' });
  grupo = (await h.q(`INSERT INTO core.grupo(codigo,nome,responsavel_id) VALUES('t-mec','Mecânica',$1) RETURNING id`, [h.users.lider.id])).rows[0].id;
  outroGrupo = (await h.q(`INSERT INTO core.grupo(codigo,nome) VALUES('t-aut','Automação') RETURNING id`)).rows[0].id;
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id = ANY($2::uuid[])', [grupo, [h.users.tec.id, h.users.tec2.id, h.users.lider.id]]);
  await h.q('UPDATE core.usuario SET grupo_id=$1 WHERE id=$2', [outroGrupo, h.users.fora.id]);
  // trocar o grupo encerra as sessões abertas: pega a versão nova da sessão
  for (const u of Object.values(h.users)) u.sv = (await h.q('SELECT sessao_versao FROM core.usuario WHERE id=$1', [u.id])).rows[0].sessao_versao;
});
test.after(() => h?.fechar());

const curso = (id, extra = {}) => ({
  id, code: 'TR-T1', title: 'Bloqueio e etiquetagem', category: 'Segurança', area: 'Segurança', tipo: 'Procedimento',
  status: 'publicado', version: 1, mandatory: true, audience: { groups: [], users: [] }, deadline_days: 30, validity_months: 12,
  sections: [{ id: 'sec1', title: 'Aula', lessons: [{ id: 'les1', title: 'Leitura', kind: 'texto', body: 'conteúdo', required: true }] }],
  quiz: { enabled: false, questions: [] }, published_at: new Date().toISOString(), ...extra
});
// Alteração de registro existente leva a versão lida (como core/sync.js); sem ela, 428.
const versaoDe = async (u, ns, id) => (await h.api(u, 'GET', `/api/data/${ns}`)).j.rows.find(x => x.recordId === id).version;
const conclui = (u, cursoId) => h.api(u, 'PUT', `/api/data/lms_progress/${u.id}__${cursoId}`, {
  payload: { id: `${u.id}__${cursoId}`, course_id: cursoId, usuarioId: u.id, enrolled_at: new Date().toISOString(), lessons: { les1: { done: true } } }
});

test('equipe: gestor vê todos, responsável vê o próprio grupo, técnico só a si', async () => {
  let r = await h.api(h.users.gest, 'GET', '/api/lms/equipe');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.ok(r.j.pessoas.length >= 6);
  const mec = r.j.grupos.find(g => g.id === grupo);
  assert.equal(mec.responsavelNome, 'Pessoa lider', 'o gestor do time é o responsável do grupo');
  r = await h.api(h.users.lider, 'GET', '/api/lms/equipe');
  const ids = r.j.pessoas.map(p => p.id).sort();
  assert.deepEqual(ids, [h.users.lider.id, h.users.tec.id, h.users.tec2.id].sort(), 'responsável não vê o técnico de outro grupo');
  r = await h.api(h.users.tec, 'GET', '/api/lms/equipe');
  assert.deepEqual(r.j.pessoas.map(p => p.id), [h.users.tec.id]);
});

test('curso não pode ser excluído, só desativado; área e tipo e revisões são gravados', async () => {
  let r = await h.api(h.users.adm, 'PUT', '/api/data/lms_courses/crs-a', { payload: curso('crs-a', { revisions: [{ version: 1, at: new Date().toISOString(), by: 'Adm', note: 'Primeira versão' }], tipo: 'Inventado' }) });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.row.payload.area, 'Segurança');
  assert.equal(r.j.row.payload.tipo, '', 'tipo fora da lista é descartado');
  assert.equal(r.j.row.payload.revisions[0].note, 'Primeira versão');
  r = await h.api(h.users.adm, 'PUT', '/api/data/lms_courses/crs-a', { payload: curso('crs-a'), deleted: true });
  assert.equal(r.s, 403);
  assert.match(r.j.erro, /Desative/);
});

test('ao concluir, o certificado vai por e-mail ao colaborador com o responsável do grupo em cópia (uma vez)', async () => {
  let r = await conclui(h.users.tec, 'crs-a');
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.ok(r.j.row.payload.certificate_code, 'curso sem prova conclui no servidor');
  const fila = (await h.q(`SELECT destinatario::text AS para, copia::text[] AS cc, assunto, corpo_html FROM core.email_fila WHERE motivo='lms_certificado'`)).rows;
  assert.equal(fila.length, 1);
  assert.equal(fila[0].para, h.users.tec.email);
  assert.deepEqual(fila[0].cc, [h.users.lider.email]);
  assert.match(fila[0].assunto, /Bloqueio e etiquetagem/);
  assert.match(fila[0].corpo_html, /Rev\. 01/);
  r = await h.api(h.users.tec, 'PUT', `/api/data/lms_progress/${h.users.tec.id}__crs-a`, { payload: { ...r.j.row.payload, last_lesson_id: 'les1' }, expectedVersion: r.j.row.version });
  assert.equal(r.s, 200);
  assert.equal((await h.q(`SELECT count(*)::int AS n FROM core.email_fila WHERE motivo='lms_certificado'`)).rows[0].n, 1, 'salvar de novo não reenvia');
});

test('cobrança: avisa o responsável de quem está com prazo vencendo; revisão que pede para refazer cobra quem já concluiu', async () => {
  const antigo = new Date(Date.now() - 40 * 864e5).toISOString();
  let r = await h.api(h.users.adm, 'PUT', '/api/data/lms_courses/crs-b', { payload: curso('crs-b', { code: 'TR-T2', title: 'NR 10', published_at: antigo, audience: { groups: [grupo], users: [] } }) });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  const n = (await h.q('SELECT lms.enfileirar_cobrancas_treinamento() AS n')).rows[0].n;
  const fila = (await h.q(`SELECT copia::text[] AS cc, destinatario::text AS para, referencia_id FROM core.email_fila WHERE motivo='lms_cobranca_gestor'`)).rows;
  assert.ok(n >= 2, 'tec e tec2 (e o próprio responsável) estão atrasados no NR 10');
  assert.ok(fila.every(f => f.para === h.users.lider.email));
  assert.ok(!fila.some(f => f.cc.includes(h.users.fora.email)), 'quem é de outro grupo não entra no público do curso');
  assert.equal((await h.q('SELECT lms.enfileirar_cobrancas_treinamento() AS n')).rows[0].n, 0, 'no máximo uma cobrança por semana');

  // crs-a: tec concluiu a versão 1; a revisão 2 pede para todos refazerem
  r = await h.api(h.users.adm, 'PUT', '/api/data/lms_courses/crs-a', { expectedVersion: await versaoDe(h.users.adm, 'lms_courses', 'crs-a'), payload: curso('crs-a', { version: 2, retrain_version: 2, retrain_at: antigo, audience: { groups: [], users: [h.users.tec.id] } }) });
  assert.equal(r.s, 200);
  await h.q('SELECT lms.enfileirar_cobrancas_treinamento()');
  const ref = (await h.q(`SELECT 1 FROM core.email_fila WHERE motivo='lms_cobranca_gestor' AND referencia_id=$1`, [`${h.users.tec.id}__crs-a`])).rows;
  assert.equal(ref.length, 1, 'certificado desatualizado pela revisão é cobrado');
  // e o próprio aluno consegue reiniciar o curso (antes só com certificado vencido)
  const linha = (await h.api(h.users.tec, 'GET', '/api/data/lms_progress')).j.rows.find(x => x.recordId === `${h.users.tec.id}__crs-a`), atual = linha.payload;
  r = await h.api(h.users.tec, 'PUT', `/api/data/lms_progress/${h.users.tec.id}__crs-a`, { expectedVersion: linha.version, payload: { ...atual, lessons: {}, attempts: [], completed_at: null, score: null, certificate_code: null, expires_at: null } });
  assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.row.payload.completed_at, null);
  assert.equal(r.j.row.payload.history.length, 1, 'o certificado antigo fica no histórico');
});
