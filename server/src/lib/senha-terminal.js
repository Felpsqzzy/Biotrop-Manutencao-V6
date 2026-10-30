'use strict';
// Senha do terminal do almoxarifado (matrícula + PIN de 6 dígitos no tablet) — a única senha que o sistema guarda:
//  • PIN (decisão de 21/10/2026, validarSenha): exatamente 6 dígitos, nem todos iguais, nem sequência (123456, 654321),
//    nem os 6 últimos dígitos da matrícula. Vale ao definir (primeiro acesso e redefinição); o login confere qualquer
//    texto até SENHA_MAX com o mesmo trabalho de scrypt (nada muda no tempo de resposta);
//  • hash scrypt do node:crypto (N=2^17, r=8, p=1, 32 bytes, sal de 16) no formato versionado
//    scrypt$1$<N>$<r>$<p>$<sal>$<hash>: trocar por Argon2id depois é criar a versão 2 e regravar no próximo login
//    (precisaRehash);
//  • comparação em tempo constante; toda conferência calcula um scrypt de cada conjunto de parâmetros em uso (o atual
//    e os dos hashes ainda gravados com custo antigo): o real entra no lugar do fictício do seu conjunto, e quem não
//    tem hash (matrícula inexistente, sem senha, bloqueado) faz o mesmo trabalho só com fictícios — o tempo de
//    resposta não revela quem existe, nem depois de mudar TERMINAL_SCRYPT_LOG2N;
//  • código de convite de uso único (XXXX-XXXX, sem 0/O/1/I), guardado só como HMAC com chave própria;
//  • IP do tablet guardado só como HMAC (conta erros por aparelho sem gravar o endereço).
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const config = require('../config');
const { chave } = require('../auth/session');

const scryptCru = promisify(crypto.scrypt);
const VERSAO = '1';

// Semáforo: no máximo 2 conferências/hashes ao mesmo tempo (cada scrypt ocupa uma thread do libuv e ~128 MiB; sem
// limite, uma rajada no tablet tomava a threadpool inteira e travava DNS, arquivos e o TLS do banco). Até 32 esperam na
// fila (o banco já segura 30 tentativas por aparelho: uma rajada de um tablet cabe inteira, sem deixar reserva pendente);
// acima disso, erro 503 ("ocupado") na hora, sem calcular nada. Threadpool maior: UV_THREADPOOL_SIZE=8 (.env.example).
const MAX_SIMULTANEOS = 2, MAX_FILA = 32;
let ativos = 0;
const fila = [];
const VEZ = Object.freeze({});   // prova de que o chamador já está dentro de naVez
function ocupado() { return ativos >= MAX_SIMULTANEOS && fila.length >= MAX_FILA; }
async function comVez(fn) {
  if (ativos >= MAX_SIMULTANEOS) {
    if (fila.length >= MAX_FILA) throw Object.assign(new Error('Terminal ocupado. Tente de novo em instantes.'), { status: 503, codigo: 'SCRYPT_OCUPADO' });
    await new Promise(ok => fila.push(ok));   // quem sai passa a vez direto (ativos não cai entre os dois)
  } else ativos += 1;
  try { return await fn(); } finally {
    const proximo = fila.shift();
    if (proximo) proximo(); else ativos -= 1;
  }
}
const N = 2 ** config.terminalScryptLog2N, R = 8, P = 1, TAM = 32, SAL = 16;
const SENHA_MAX = 128;
const K_CONVITE = chave('terminal-convite');
const K_IP = chave('terminal-ip');
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem 0/O/1/I: ditado ao colaborador sem confusão
const DIGITOS = '0123456789';   // sequências do PIN (e o inverso)

const MAX_CONJUNTOS = 6;   // conjuntos de parâmetros conferidos por login (o atual + os antigos ainda gravados)
const normalizar = s => String(s).normalize('NFKC');
const memoria = (n, r) => 256 * n * r;   // o dobro do que o scrypt usa (128·N·r): margem sem abrir para parâmetro absurdo
/** Texto vindo do corpo: só string ou número viram texto; objeto ({"toString":1}), lista ou nulo viram vazio. */
const textoDe = v => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

async function gerarHashNaVez(senha) {
  const sal = crypto.randomBytes(SAL);
  const h = await scryptCru(normalizar(senha), sal, TAM, { N, r: R, p: P, maxmem: memoria(N, R) });
  return ['scrypt', VERSAO, N, R, P, sal.toString('base64'), h.toString('base64')].join('$');
}
// vez: a de naVez (o pedido já segura a vaga); sem ela, pega uma vaga só para este hash
const gerarHash = (senha, vez) => (vez === VEZ ? gerarHashNaVez(senha) : comVez(() => gerarHashNaVez(senha)));

/** Parâmetros 'scrypt$1$N$r$p' (o começo do hash); null se fugirem do razoável. */
function lerParametros(texto) {
  const p = String(texto || '').split('$');
  if (p.length < 5 || p[0] !== 'scrypt' || p[1] !== VERSAO) return null;
  const [n, r, pp] = p.slice(2, 5).map(Number);
  if (!Number.isInteger(n) || n < 2 ** 12 || n > 2 ** 20 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(pp) || pp < 1 || pp > 4) return null;
  return { n, r, p: pp };
}
/** Lê o texto guardado; null se não for um hash conhecido (ou se os parâmetros fugirem do razoável). */
function ler(hash) {
  const p = String(hash || '').split('$');
  const par = p.length === 7 ? lerParametros(hash) : null;
  if (!par) return null;
  const sal = Buffer.from(p[5], 'base64'), h = Buffer.from(p[6], 'base64');
  if (sal.length < 16 || h.length !== TAM) return null;
  return { ...par, sal, h };
}

// Alvo fictício por conjunto de parâmetros (sal e "hash" aleatórios): o scrypt contra ele custa o mesmo que o real.
const ficticios = new Map();
const chaveDe = c => `${c.n}$${c.r}$${c.p}`;
function ficticio(c) {
  if (!ficticios.has(chaveDe(c))) ficticios.set(chaveDe(c), { n: c.n, r: c.r, p: c.p, sal: crypto.randomBytes(SAL), h: crypto.randomBytes(TAM) });
  return ficticios.get(chaveDe(c));
}
/** Alvo fictício dos parâmetros atuais (compatível com quem já chamava antes de conferir a primeira senha). */
function hashFicticio() { return Promise.resolve(ficticio({ n: N, r: R, p: P })); }

/**
 * Conjuntos conferidos em toda chamada, em ordem fixa: o atual, os informados pelo banco (emprestimo.terminal_parametros_hash:
 * os dos hashes gravados) e o do próprio hash (lista do banco ainda sem ele). Mesma lista para quem existe e quem não existe.
 */
function conjuntos(emUso, real) {
  const m = new Map([[chaveDe({ n: N, r: R, p: P }), { n: N, r: R, p: P }]]);
  if (real) m.set(chaveDe(real), { n: real.n, r: real.r, p: real.p });
  for (const t of Array.isArray(emUso) ? emUso : []) {
    const c = lerParametros(t);
    if (c && m.size < MAX_CONJUNTOS) m.set(chaveDe(c), c);
  }
  return [...m.values()].sort((a, b) => a.n - b.n || a.r - b.r || a.p - b.p);
}

/**
 * true só se a senha confere com o hash. Sempre executa um scrypt completo de cada conjunto de parâmetros em uso
 * (emUso: 'scrypt$1$N$r$p' dos hashes gravados): o hash real substitui o fictício do seu conjunto. Assim, depois de
 * subir o custo, quem ainda tem hash antigo e quem não existe fazem o mesmo trabalho (antes o fictício usava só o custo
 * novo e uma requisição bastava para saber quem existe).
 */
async function verificarNaVez(senha, hash, emUso = []) {
  const valida = typeof senha === 'string' && senha.length >= 1 && senha.length <= SENHA_MAX;
  const real = ler(hash);
  let confere = false;
  for (const c of conjuntos(emUso, real)) {
    const usaReal = valida && !!real && chaveDe(c) === chaveDe(real);
    const alvo = usaReal ? real : ficticio(c);
    const calc = await scryptCru(normalizar(valida ? senha : ''), alvo.sal, alvo.h.length, { N: alvo.n, r: alvo.r, p: alvo.p, maxmem: memoria(alvo.n, alvo.r) });
    const igual = crypto.timingSafeEqual(calc, alvo.h);
    if (usaReal) confere = igual;
  }
  return confere;
}
// uma vez no semáforo para todos os conjuntos: a conferência não para no meio por falta de vaga (vez: como em gerarHash)
const verificar = (senha, hash, emUso = [], vez) => (vez === VEZ ? verificarNaVez(senha, hash, emUso) : comVez(() => verificarNaVez(senha, hash, emUso)));

/**
 * Uma vaga do semáforo para o pedido inteiro do terminal: a vaga vem ANTES da reserva da tentativa no banco e fica até
 * o último hash (conferência + regravação). Sem vaga, 503 sem tocar no banco; com ela, nenhum hash do pedido recebe
 * "ocupado" depois de a tentativa estar reservada (a reserva não fica pendente contando como erro).
 * fn recebe a vez, repassada a verificar(..., vez) e gerarHash(senha, vez) para rodarem dentro desta vaga.
 */
const naVez = fn => comVez(() => fn(VEZ));

/** Hash com versão ou parâmetros diferentes dos atuais: regravar depois de um login certo. */
function precisaRehash(hash) {
  const d = ler(hash);
  return !d || d.n !== N || d.r !== R || d.p !== P;
}

/**
 * Regra do PIN (decisão de 21/10/2026): exatamente 6 dígitos de 0 a 9 (sem espaço, letra nem dígito de outro alfabeto);
 * nem todos iguais (111111), nem sequência crescente ou decrescente (012345…456789, 987654…543210), nem igual aos 6
 * últimos dígitos da matrícula (só quando ela tem 6 dígitos ou mais). null = PIN aceito.
 */
function validarSenha(senha, matricula = '') {
  if (typeof senha !== 'string' || !/^[0-9]{6}$/.test(senha)) return 'O PIN precisa ter exatamente 6 dígitos (só números).';
  if (/^(\d)\1{5}$/.test(senha)) return 'O PIN não pode ter todos os dígitos iguais.';
  if (DIGITOS.includes(senha) || [...DIGITOS].reverse().join('').includes(senha)) return 'O PIN não pode ser uma sequência (123456, 654321).';
  const dig = textoDe(matricula).replace(/[^0-9]/g, '');
  if (dig.length >= 6 && senha === dig.slice(-6)) return 'O PIN não pode ser igual aos 6 últimos dígitos da matrícula.';
  return null;
}

function gerarCodigo() {
  let c = '';
  for (let i = 0; i < 8; i += 1) c += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
/** HMAC do código, sem traço nem espaço e em maiúsculas (o colaborador digita como quiser). */
function hashCodigo(codigo) {
  const limpo = textoDe(codigo).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
  return crypto.createHmac('sha256', K_CONVITE).update(`convite.v1.${limpo}`).digest('hex');
}
function hashIp(ip) {
  return crypto.createHmac('sha256', K_IP).update(`ip.v1.${String(ip || 'desconhecido')}`).digest('hex');
}

module.exports = { SENHA_MAX, MAX_SIMULTANEOS, MAX_FILA, ocupado, naVez, gerarHash, verificar, precisaRehash, validarSenha, gerarCodigo, hashCodigo, hashIp, hashFicticio, textoDe };
