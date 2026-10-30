'use strict';
// Cobertura adicional (unitária e estática) do terminal e do empréstimo, escrita pelo testador: bordas da senha, do hash,
// do cookie e do código de convite; critérios de tablet (toque, orientação, zoom) e de implantação (variáveis e documentos).
// Dados FICTÍCIOS. Os achados (antes marcados como "todo" do node:test) foram corrigidos em 2026-10-21: tudo aqui precisa passar.
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
process.env.TERMINAL_SCRYPT_LOG2N = '12';   // scrypt leve só neste arquivo (o hash guarda o N usado)

const s = require('../src/lib/senha-terminal');
const T = require('../src/auth/terminal-sessao');
const RAIZ = path.resolve(__dirname, '../..');
const ler = rel => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const UID = '0b9d2c1e-1111-4222-8333-944455556666';

/* ---------------------------------------------------------------- regra da senha */
test('PIN: exatamente 6 dígitos; nem todos iguais, nem sequência (crescente ou decrescente), nem os 6 últimos dígitos da matrícula', () => {
  const ruim = (senha, matricula, trecho) => { const r = s.validarSenha(senha, matricula); assert.ok(r && r.includes(trecho), `${JSON.stringify(senha)} → ${r}`); };
  const boa = (senha, matricula = '') => assert.equal(s.validarSenha(senha, matricula), null, JSON.stringify(senha));
  // tipo e formato: só texto de 6 dígitos ASCII (número, espaço, letra, largura total e outros alfabetos ficam de fora)
  for (const v of [undefined, null, 480613, ['480613'], {}, '', '48061', '4806139', ' 480613', '480613 ', '48 613', '4806a3', '４８０６１３', '٤٨٠٦١٣', '480613\n'])
    ruim(v, '', 'exatamente 6 dígitos');
  for (const d of '0123456789') ruim(d.repeat(6), '', 'todos os dígitos iguais');
  for (const q of ['012345', '123456', '234567', '345678', '456789', '987654', '876543', '765432', '654321', '543210']) ruim(q, '', 'sequência');
  boa('890123'); boa('121212'); boa('480613'); boa('000001'); boa('135790');   // sequência que "dá a volta" ou alternada não é a regra
  ruim('800001', '800001', 'matrícula'); ruim('234801', 'T1234801', 'matrícula'); ruim('000123', 'AB0001-23'.replace('-', ''), 'matrícula');
  boa('800001', '10421');            // matrícula com menos de 6 dígitos: a regra não se aplica
  boa('800002', '800001'); boa('480613', { toString: 1 });
});

/* ---------------------------------------------------------------- hash */
test('hash: formatos estranhos ou parâmetros absurdos no banco nunca confirmam a senha, não derrubam e não pedem memória a mais', async () => {
  const h = await s.gerarHash('Furadeira#Azul7');
  const [, , n, r, p, sal, hh] = h.split('$');
  const falsos = [
    ['versão 2', ['scrypt', '2', n, r, p, sal, hh]], ['N gigante (2^30)', ['scrypt', '1', String(2 ** 30), r, p, sal, hh]], ['N pequeno demais', ['scrypt', '1', '16', r, p, sal, hh]],
    ['N que não é potência de 2', ['scrypt', '1', '5000', r, p, sal, hh]], ['r = 0', ['scrypt', '1', n, '0', p, sal, hh]], ['r gigante', ['scrypt', '1', n, '9999', p, sal, hh]],
    ['p = 99', ['scrypt', '1', n, r, '99', sal, hh]], ['sal curto', ['scrypt', '1', n, r, p, Buffer.alloc(4).toString('base64'), hh]], ['hash curto', ['scrypt', '1', n, r, p, sal, Buffer.alloc(8).toString('base64')]],
    ['N texto', ['scrypt', '1', 'abc', r, p, sal, hh]], ['campo a mais', ['scrypt', '1', n, r, p, sal, hh, 'x']], ['campo a menos', ['scrypt', '1', n, r, p, sal]]
  ];
  for (const [rotulo, partes] of falsos) {
    const t0 = Date.now();
    assert.equal(await s.verificar('Furadeira#Azul7', partes.join('$')), false, rotulo);
    assert.ok(Date.now() - t0 < 5000, `${rotulo}: demorou ${Date.now() - t0} ms`);
    assert.equal(s.precisaRehash(partes.join('$')), true, `${rotulo}: precisa regravar`);
  }
  for (const lixo of [null, undefined, '', 'x', 12345, {}, [], 'scrypt$', '$$$$$$']) assert.equal(await s.verificar('Furadeira#Azul7', lixo), false, JSON.stringify(lixo));
  assert.equal(await s.verificar('Furadeira#Azul7', h), true, 'o hash verdadeiro continua conferindo');
  // normalização: a mesma senha, composta ou decomposta, confere
  const h2 = await s.gerarHash('Caf\u00e9-Forte-77');
  assert.equal(await s.verificar('Cafe\u0301-Forte-77', h2), true);
  assert.equal(await s.verificar('Cafe-Forte-77', h2), false);
});

/* ---------------------------------------------------------------- convite e IP */
test('código de convite: formato XXXX-XXXX sem 0/O/1/I em 3000 sorteios, sem repetição; o HMAC ignora caixa, traço e espaço e não confunde códigos diferentes', () => {
  const vistos = new Set();
  for (let i = 0; i < 3000; i += 1) {
    const c = s.gerarCodigo();
    assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    vistos.add(c);
  }
  assert.equal(vistos.size, 3000, 'sem repetição em 3000 sorteios');
  const c = 'ABCD-EF23';
  const base = s.hashCodigo(c);
  for (const v of ['abcd-ef23', 'ABCDEF23', ' abcd ef23 ', 'abcd_ef23', 'AB-CD-EF-23']) assert.equal(s.hashCodigo(v), base, JSON.stringify(v));
  for (const v of ['ABCD-EF24', 'ABCD-EF2', 'ABCD-EF233', '', null, undefined, 'ABCDEF23' + 'X'.repeat(40)]) assert.notEqual(s.hashCodigo(v), base, JSON.stringify(v));
  assert.match(s.hashCodigo('x'.repeat(100000)), /^[0-9a-f]{64}$/, 'entrada enorme não quebra');
  assert.notEqual(s.hashIp('10.0.0.1'), s.hashIp('10.0.0.2'));
  assert.equal(s.hashIp('10.0.0.1'), s.hashIp('10.0.0.1'));
  assert.match(s.hashIp(undefined), /^[0-9a-f]{64}$/);
  assert.ok(!s.hashIp('10.0.0.1').includes('10.0.0.1'));
});

/* ---------------------------------------------------------------- cookie do terminal */
test('cookie do terminal: relógio nas bordas (30 min, adiantado em 60 s), campos fora do formato e tamanhos recusados', () => {
  const agora = Date.UTC(2026, 9, 16, 12, 0, 0);
  const novo = (extra = {}, quando = agora) => T.criarSessaoTerminal({ usuarioId: UID, versao: 1, ...extra }, quando).valor;
  assert.ok(T.verificarSessaoTerminal(novo(), agora), 'recém-criado');
  assert.ok(T.verificarSessaoTerminal(novo(), agora + 30 * 60_000 - 1000), 'a 1 s do fim');
  assert.equal(T.verificarSessaoTerminal(novo(), agora + 30 * 60_000), null, 'no instante do fim');
  assert.ok(T.verificarSessaoTerminal(novo({}, agora + 59_000), agora), 'relógio do servidor 59 s atrás');
  assert.equal(T.verificarSessaoTerminal(novo({}, agora + 61_000), agora), null, 'emitido no futuro (61 s)');
  assert.equal(T.verificarSessaoTerminal(novo({}, agora - 31 * 60_000), agora), null, 'emitido há 31 min');
  for (const versao of [0, -1, 1.5, NaN, 'x']) assert.equal(T.verificarSessaoTerminal(novo({ versao }), agora), null, `versão ${versao}`);
  for (const usuarioId of ['', 'nao-e-uuid', '0b9d2c1e-1111-4222-8333-94445555666', 'x'.repeat(36)]) assert.equal(T.verificarSessaoTerminal(novo({ usuarioId }), agora), null, `sub ${usuarioId}`);
  for (const sid of ['curto', 'x'.repeat(19), 'x'.repeat(65), 'com espaço no meio 1234567890', 'acentuação-ç-123456789012']) assert.equal(T.verificarSessaoTerminal(novo({ sid }), agora), null, `sid ${sid}`);
  assert.ok(T.verificarSessaoTerminal(novo({ sid: 'A'.repeat(20) }), agora)); assert.ok(T.verificarSessaoTerminal(novo({ sid: 'A'.repeat(64) }), agora));
  for (const raw of [undefined, null, 12345, {}, [], '', '.', '..', 'a.b', `${novo()}x`.repeat(30), novo().slice(0, 50)]) assert.equal(T.verificarSessaoTerminal(raw, agora), null, JSON.stringify(raw)?.slice(0, 40));
  assert.equal(T.verificarSessaoTerminal('a'.repeat(1025) + '.b', agora), null, 'acima de 1024 caracteres');
  assert.match(T.sidHash('qualquer-coisa-com-20-caracteres'), /^[0-9a-f]{64}$/);
  assert.notEqual(T.sidHash('a'.repeat(24)), T.sidHash('b'.repeat(24)));
  assert.equal(new Set(Array.from({ length: 500 }, () => T.novoSid())).size, 500, 'sid aleatório, sem repetição');
  assert.match(T.novoSid(), /^[A-Za-z0-9_-]{20,64}$/);
});


/* ---------------------------------------------------------------- implantação (critério 13: variáveis e documentos) */
test('implantação documentada: variáveis novas, motivos de e-mail, URL do terminal e as fases 4 a 7 no plano',
  () => {
    const docs = fs.readdirSync(path.join(RAIZ, 'docs')).filter(n => n.endsWith('.md')).map(n => [n, ler(`docs/${n}`)]);
    const em = (re, onde = docs) => onde.some(([, t]) => re.test(t));
    const faltas = [];
    if (!/TERMINAL_SCRYPT_LOG2N/.test(ler('.env.example')) && !em(/TERMINAL_SCRYPT_LOG2N/)) faltas.push('TERMINAL_SCRYPT_LOG2N (.env.example ou docs)');
    if (!em(/emprestimo_lembrete/, docs.filter(([n]) => /EMAIL|DEPLOY|OPERACAO|HOMOLOGACAO/.test(n)))) faltas.push('motivos emprestimo_* em EMAIL-MICROSOFT-GRAPH/DEPLOY-TI/OPERACAO');
    if (!em(/\/terminal\b/, docs.filter(([n]) => /DEPLOY|OPERACAO|HOMOLOGACAO/.test(n)))) faltas.push('URL /terminal e o tablet em DEPLOY-TI/OPERACAO/HOMOLOGACAO');
    const plano = ler('docs/FERRAMENTAS-E-EMPRESTIMOS-PLANO.md');
    for (const mig of ['41-terminal-acesso', '42-emprestimo-avisos', '43-ferramenta-foto']) if (!plano.includes(mig)) faltas.push(`migration ${mig} no plano`);
    assert.deepEqual(faltas, [], 'critério 13: "migrações, variáveis de ambiente e instruções de implantação documentadas"');
  });

/* ---------------------------------------------------------------- rodada 2 do testador */
