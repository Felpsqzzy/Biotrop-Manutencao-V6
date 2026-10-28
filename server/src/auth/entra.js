const crypto = require('node:crypto');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const config = require('../config');

const client = new ConfidentialClientApplication({
  auth: {
    clientId: config.entraClientId,
    clientSecret: config.entraClientSecret,
    authority: `https://login.microsoftonline.com/${config.entraTenantId}`
  }
});

function random(size = 32) { return crypto.randomBytes(size).toString('base64url'); }
// Chave própria (HKDF) para o estado OAuth: um cookie de sessão nunca é aceito como estado e vice-versa.
const K_OAUTH = require('./session').chave('oauth-state');
function signature(value) { return crypto.createHmac('sha256', K_OAUTH).update(`oauth.v1.${value}`).digest('base64url'); }
function redirectUri() { return `${config.appBaseUrl}/auth/microsoft/callback`; }

function createOauthState() {
  const verifier = random(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const value = { state: random(), nonce: random(), verifier, exp: Date.now() + 10 * 60 * 1000 };
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return { value, challenge, cookie: `${payload}.${signature(payload)}` };
}

function readOauthState(raw) {
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  const expected = signature(payload);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return state.exp > Date.now() ? state : null;
  } catch { return null; }
}

module.exports = { client, redirectUri, createOauthState, readOauthState };
