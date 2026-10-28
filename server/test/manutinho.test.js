// Manutinho (routes/manutinho.js): as fontes seguem as mesmas listas de perfis das rotas de origem, o e-mail de cobrança
// sai do modelo fixo com o texto escapado, e o Copiloto (IA) saiu do servidor e da configuração.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_BASE_URL ||= 'https://manutencao.example.test';
process.env.DATABASE_URL ||= 'postgresql://app:password@localhost:5432/biotrop';
process.env.SESSION_SECRET ||= 'test-session-secret-with-more-than-thirty-two-characters';
process.env.ENTRA_TENANT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_ID ||= '00000000-0000-0000-0000-000000000000';
process.env.ENTRA_CLIENT_SECRET ||= 'test-only-secret';

const raiz = path.resolve(__dirname, '../..');
const ler = f => fs.readFileSync(path.join(raiz, f), 'utf8');
const { _test } = require('../src/routes/manutinho');

test('fontes: mesmas listas de perfis das rotas de origem (nunca mais permissivas)', () => {
  const prev = require('../src/routes/pcm-preventivas')._test;
  assert.deepEqual([..._test.EQUIPE].sort(), [...prev.EQUIPE].sort(), 'preventivas/válvulas/bateladas = equipe das preventivas');
  assert.match(ler('server/src/routes/pcm-bateladas.js'), /const EQUIPE = new Set\(\['admin', 'gestor', 'pcm', 'lider', 'tecnico'\]\)/);
  assert.deepEqual([..._test.SOLICITANTES].sort(), ['admin', 'almoxarife', 'gestor', 'lider', 'pcm', 'tecnico'], 'SCI/SCM: quem grava em data.js');
  assert.deepEqual([..._test.MEDIDORES].sort(), ['admin', 'gestor', 'pcm'], 'pendências de apontamento: PCM e gestão');
  for (const s of [_test.EQUIPE, _test.SOLICITANTES, _test.MEDIDORES]) { assert.equal(s.has('viewer'), false); assert.equal(s.has('terminal'), false); }
});

test('cobrança: modelo fixo, nome e cursos escapados', () => {
  const { assunto, html } = _test.corpoCobranca('[TESTE] Líder <b>x</b>', ['[TESTE] Curso <script>alert(1)</script>']);
  assert.equal(assunto, '[Lembrete] Treinamento pendente');
  assert.match(html, /\[TESTE\] Líder &lt;b&gt;x&lt;\/b&gt; pediu que você conclua este treinamento/);
  assert.match(html, /<li>\[TESTE\] Curso &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<b>x/);
  assert.match(_test.corpoCobranca('A', ['1', '2']).html, /estes treinamentos/);
  assert.doesNotMatch(_test.corpoCobranca('A', []).html, /<ul>/);
});

test('o Copiloto saiu: rota, montagem no app e variáveis de IA', () => {
  assert.equal(fs.existsSync(path.join(raiz, 'server/src/routes/copiloto.js')), false);
  const app = ler('server/src/app.js');
  assert.match(app, /app\.use\('\/api\/manutinho', require\('\.\/routes\/manutinho'\)\)/);
  assert.doesNotMatch(app, /copiloto/i);
  for (const f of ['server/src/config.js', '.env.example', '.env.app.example', 'docker-compose.yml', 'server/src/routes/manutinho.js']) {
    assert.doesNotMatch(ler(f), /ANTHROPIC|COPILOTO_|api\.anthropic\.com/, f);
  }
  // a cobrança continua na função da migration 39 (o banco é o mesmo da V5): nenhuma migration nova renomeia
  assert.match(ler('server/src/routes/manutinho.js'), /lms\.copiloto_cobrar\(\$1, \$2, \$3\)/);
  assert.equal(fs.readdirSync(path.join(raiz, 'database/migrations')).some(f => /manutinho/i.test(f)), false);
});

test('a imagem do servidor leva as regras compartilhadas que a rota carrega', () => {
  assert.match(ler('server/src/routes/manutinho.js'), /require\('\.\.\/\.\.\/\.\.\/packages\/shared\/dist\/cjs\/manutinho\/index\.js'\)/);
  assert.match(ler('Dockerfile'), /COPY --from=web \/opt\/biotrop\/packages\/shared\/dist \.\/packages\/shared\/dist/);
});
