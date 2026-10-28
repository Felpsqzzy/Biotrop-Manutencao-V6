const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

const read = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
const { _test } = require('../src/routes/pcm-preventivas');
const route = read('server/src/routes/pcm-preventivas.js');
const migration = read('database/migrations/15-pcm-preventivas.sql');

test('PCM manages, the maintenance team fills, other profiles stay out', () => {
  for (const p of ['admin', 'gestor', 'pcm']) assert.equal(_test.gestao({ perfilId: p }), true, p);
  for (const p of ['lider', 'tecnico', 'almoxarife', 'viewer']) assert.equal(_test.gestao({ perfilId: p }), false, p);
  for (const p of ['admin', 'gestor', 'pcm', 'lider', 'tecnico']) assert.equal(_test.equipe({ perfilId: p }), true, p);
  for (const p of ['almoxarife', 'viewer', '']) assert.equal(_test.equipe({ perfilId: p }), false, p);
});

test('validates life (1–4), replaced flag and calendar dates', () => {
  assert.equal(_test.vida(1), 1);
  assert.equal(_test.vida('4'), 4);
  assert.equal(_test.vida(null), null);
  assert.equal(_test.vida(0), undefined);
  assert.equal(_test.vida(5), undefined);
  assert.equal(_test.vida(2.5), undefined);
  assert.equal(_test.trocado(true), true);
  assert.equal(_test.trocado(false), false);
  assert.equal(_test.trocado(null), null);
  assert.equal(_test.trocado('talvez'), undefined);
  assert.equal(_test.date('2026-09-21'), '2026-09-21');
  assert.equal(_test.date('2026-02-30'), null);
  assert.equal(_test.date("2026-09-21'; drop table x"), null);
});

test('technician name comes from the session; only PCM/gestão may transcribe a paper sheet for someone else', () => {
  assert.match(route, /tecnico_id=\$6,tecnico_nome=\$7,preenchido_em=\$8,registrado_por=\$9,registrado_por_nome=\$10/);
  // Outro nome só entra para a gestão; quem digitou (registrado_por) é sempre a sessão.
  assert.match(route, /const transc = gestao\(req\.user\) \? clean\(req\.body\?\.tecnicoNome, 160\) : '';/);
  assert.match(route, /const executor = transc \|\| quem;/);
  assert.match(route, /vazio \? null : req\.user\.id, vazio \? '' : quem\]/);
  assert.equal((route.match(/req\.body\??\.tecnicoNome/g) || []).length, 2, 'tecnicoNome só é lido nos dois pontos guardados por gestao()');
  assert.match(route, /const executor = gestao\(req\.user\) \? clean\(req\.body\?\.tecnicoNome, 160\) : '';/);
  assert.match(route, /INSERT INTO pcm\.preventiva_observacao\(preventiva_id,texto,autor_id,autor_nome\) VALUES\(\$1,\$2,\$3,\$4\)',\s*\[id, texto, req\.user\.id/);
});

test('route is mounted behind authentication and same-origin protection', () => {
  const app = read('server/src/app.js');
  assert.match(app, /app\.use\('\/api\/pcm\/preventivas', require\('\.\/routes\/pcm-preventivas'\)\)/);
  assert.ok(app.indexOf("app.use('/api', requireSameOrigin)") < app.indexOf("'/api/pcm/preventivas'"));
  assert.ok(route.indexOf('router.use(requireAuth)') < route.indexOf("router.get('/painel'"));
});

test('migration 15 creates the tables with RLS and explicit grants', () => {
  for (const t of ['checklist_item', 'preventiva', 'preventiva_item', 'preventiva_observacao']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS pcm\\.${t} \\(`));
    assert.match(migration, new RegExp(`ALTER TABLE pcm\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON pcm\.ativo, pcm\.checklist_item, pcm\.preventiva,/);
  assert.match(migration, /CHECK \(vida IS NULL OR vida BETWEEN 1 AND 4\)/);
  // Técnico só altera folha aberta e só registra observação em nome próprio.
  assert.match(migration, /preventiva_equipe_upd ON pcm\.preventiva FOR UPDATE TO biotrop_app\s+USING \(app\.pcm_equipe\(\) AND status IN \('aberta','em_execucao'\)\)/);
  assert.match(migration, /autor_id = app\.usuario_atual\(\) AND app\.pcm_preventiva_aberta\(preventiva_id\)/);
  // A carga do prontuário nunca recria nem sobrescreve equipamento já existente.
  assert.match(migration, /ON CONFLICT \(codigo\) DO NOTHING\s+RETURNING id INTO v_ativo;\s+CONTINUE WHEN v_ativo IS NULL;/);
});

test('prontuário REV 12 is loaded: 34 equipments, including FTD01 and PGD15', () => {
  const seed = migration.match(/\$seed\$([\s\S]*?)\$seed\$/)[1];
  const data = JSON.parse(seed);
  assert.equal(data.length, 34);
  const codes = data.map(e => e.c);
  for (const c of ['FTD01', 'FTD15', 'PGD01', 'PGD15', 'BLD02', 'BLD05']) assert.ok(codes.includes(c), c);
  const ftd01 = data.find(e => e.c === 'FTD01');
  assert.equal(ftd01.i.length, 42);
  assert.deepEqual(ftd01.i[0].slice(0, 8), ['Inferior', 'BV - 14.24', 'Bloco 2 vias fundo – fundo', '1 ½”', 'DN-40', 'MAN8921', 'GEMÜ', 'trocar']);
  assert.ok(data.every(e => e.i.every(i => i[10] === null || (i[10] >= 1 && i[10] <= 4))));
});

test('the workbook template lives outside the public folder and has an authenticated route', () => {
  const app = read('server/src/app.js');
  assert.ok(app.includes("app.get('/assets/modelos/:arquivo', requireAuth"));
  assert.ok(!fs.existsSync(path.resolve(__dirname, '../../apps/web/public/modelos')), 'modelo não pode ficar na pasta pública apps/web/public/');
});
