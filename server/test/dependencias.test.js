'use strict';
// Dependências com falha conhecida (npm audit): o MSAL do login Entra (GHSA-xcx6-jx8p-x3h5, corrigido na 7.1.1) e o
// body-parser do express.json (GHSA-27r3-jxmh-p828, corrigido na 1.20.9). Confere a versão instalada (também a que o
// @azure/identity do KMS carrega) e que a API usada em routes/auth.js continua igual na 7.x, sem rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const versao = (pacote, de = __dirname) => require(require.resolve(`${pacote}/package.json`, { paths: [de] })).version;
const pelo = (texto) => texto.split('.').map(Number);
const noMinimo = (v, min) => { const a = pelo(v), b = pelo(min); for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

test('MSAL >= 7.1.1 no login e no @azure/identity; body-parser >= 1.20.9', () => {
  assert.ok(noMinimo(versao('@azure/msal-node'), '7.1.1'), versao('@azure/msal-node'));
  const identity = path.dirname(require.resolve('@azure/identity/package.json', { paths: [__dirname] }));
  assert.ok(noMinimo(versao('@azure/msal-node', identity), '7.1.1'), 'o @azure/identity não pode trazer um MSAL antigo');
  const express = path.dirname(require.resolve('express/package.json', { paths: [__dirname] }));
  assert.ok(noMinimo(versao('body-parser', express), '1.20.9'), versao('body-parser', express));
  const pkg = require('../package.json');
  assert.equal(pkg.overrides?.['@azure/msal-node'], '$@azure/msal-node', 'override mantém uma versão só do MSAL');
});

test('MSAL 7: getAuthCodeUrl com state, nonce e PKCE como em routes/auth.js (metadados locais, sem rede)', async () => {
  const { ConfidentialClientApplication } = require('@azure/msal-node');
  const t = '00000000-0000-0000-0000-000000000000', base = `https://login.microsoftonline.com/${t}`;
  const client = new ConfidentialClientApplication({ auth: {
    clientId: t, clientSecret: 'segredo-de-teste', authority: base, knownAuthorities: ['login.microsoftonline.com'],
    authorityMetadata: JSON.stringify({ token_endpoint: `${base}/oauth2/v2.0/token`, authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      issuer: `${base}/v2.0`, end_session_endpoint: `${base}/oauth2/v2.0/logout`, jwks_uri: `${base}/discovery/v2.0/keys` }),
    cloudDiscoveryMetadata: JSON.stringify({ tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`,
      metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com'] }] })
  } });
  const url = new URL(await client.getAuthCodeUrl({ scopes: ['openid', 'profile', 'email'], redirectUri: 'https://app.exemplo.test/auth/microsoft/callback',
    state: 'estado-ficticio', nonce: 'nonce-ficticio', codeChallenge: 'desafio-ficticio', codeChallengeMethod: 'S256', prompt: 'select_account' }));
  assert.equal(url.origin + url.pathname, `${base}/oauth2/v2.0/authorize`);
  for (const [k, v] of [['state', 'estado-ficticio'], ['nonce', 'nonce-ficticio'], ['code_challenge', 'desafio-ficticio'], ['code_challenge_method', 'S256'], ['prompt', 'select_account']]) {
    assert.equal(url.searchParams.get(k), v, k);
  }
  assert.equal(url.searchParams.get('client_secret'), null, 'o segredo nunca vai na URL');
  assert.equal(typeof client.acquireTokenByCode, 'function');
});
