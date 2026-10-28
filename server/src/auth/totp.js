// Verificação em duas etapas por aplicativo autenticador (TOTP, RFC 6238).
// Funciona com Microsoft Authenticator, Google Authenticator, Authy etc.
// Módulo puro: recebe as chaves por parâmetro, não lê config nem banco.
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

function stepAt(ms = Date.now()) { return Math.floor(ms / 1000 / PERIOD); }

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Confere o código aceitando um passo de tolerância para relógio atrasado ou adiantado.
 * Devolve o passo usado (para impedir reutilização) ou null.
 */
function verify(secret, code, { lastStep = -1, now = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const current = stepAt(now);
  for (let d = -window; d <= window; d += 1) {
    const step = current + d;
    if (step <= lastStep) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

function otpauthUri(secret, account, issuer = 'BIOTROP Manutenção') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

/* ---------- segredo cifrado no banco (AES-256-GCM) ---------- */
function keyFrom(material) { return crypto.createHash('sha256').update(`biotrop-2fa:${material}`).digest(); }

function encrypt(plain, material) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(material), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(packed, material) {
  const [v, iv, tag, data] = String(packed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(material), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

/* ---------- códigos de recuperação (uso único, guardados só como hash) ---------- */
function recoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
function hashRecovery(code, material) {
  return crypto.createHmac('sha256', keyFrom(material)).update(String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '')).digest('hex');
}

/* ---------- confirmação recente ("step-up"), num cookie assinado ---------- */
function signStepUp(userId, material, minutes = 10, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + minutes * 60 })).toString('base64url');
  const sig = crypto.createHmac('sha256', keyFrom(material)).update(`stepup.${payload}`).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyStepUp(raw, userId, material, now = Date.now()) {
  const [payload, sig] = String(raw || '').split('.');
  if (!payload || !sig) return 0;
  const expected = crypto.createHmac('sha256', keyFrom(material)).update(`stepup.${payload}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 0;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (String(data.sub) !== String(userId) || data.exp * 1000 <= now) return 0;
    return data.exp * 1000;
  } catch { return 0; }
}

module.exports = {
  PERIOD, base32Encode, base32Decode, generateSecret, stepAt, codeAt, verify, otpauthUri,
  encrypt, decrypt, recoveryCodes, hashRecovery, signStepUp, verifyStepUp
};
