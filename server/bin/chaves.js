#!/usr/bin/env node
'use strict';
// CLI de chaves e migração de dados cifrados (administração, fora do app web).
//   node server/bin/chaves.js status
//   node server/bin/chaves.js migrar [--simular]
//   node server/bin/chaves.js rotacionar --finalidade dados-operacionais
//   node server/bin/chaves.js reembrulhar
//   node server/bin/chaves.js recifrar --finalidade dados-pessoais
//   node server/bin/chaves.js referencias
//   node server/bin/chaves.js revogar --dek <uuid> [--forcar]
//   node server/bin/chaves.js destruir --dek <uuid>
// Usa DATABASE_ADMIN_URL (dono do schema) + o mesmo KMS do app (KMS_PROVEDOR/AZURE_KEYVAULT_KEY_ID).
// A variável DATABASE_URL do app não é necessária aqui; se ausente, reaproveita a de admin só para carregar a config.
const path = require('node:path');
if (process.env.NODE_ENV !== 'production') require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
if (!process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL) process.env.DATABASE_URL = process.env.DATABASE_ADMIN_URL;
const { Client } = require('pg');
const config = require('../src/config');
const { criarProvedor } = require('../src/crypto/kms');
const { criarChaveiro, armazemPg } = require('../src/crypto/chaveiro');
const { criarServicoCifra } = require('../src/crypto/cifra');
const cripto = require('../src/crypto/index');
const { criarAdmin } = require('../src/crypto/admin');

const [cmd, ...resto] = process.argv.slice(2);
const opt = n => { const i = resto.indexOf('--' + n); return i < 0 ? null : (resto[i + 1] && !resto[i + 1].startsWith('--') ? resto[i + 1] : true); };

(async () => {
  const url = String(process.env.DATABASE_ADMIN_URL || '').trim();
  if (!url) throw new Error('Defina DATABASE_ADMIN_URL (conexão do dono do schema).');
  const ssl = config.databaseSsl ? { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(config.databaseSslCa ? { ca: config.databaseSslCa.replace(/\\n/g, '\n') } : {}) } : undefined;
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  const q = (s, p) => client.query(s, p);
  const kms = criarProvedor({ provedor: config.kmsProvedor, azureKeyId: config.azureKeyVaultKeyId, kekLocal: config.kekLocal, producao: config.production });
  // Conexão única: as "transações" do chaveiro rodam na transação corrente (os lotes do admin já abrem a sua).
  const chaveiro = criarChaveiro({ armazem: armazemPg(q, fn => fn(q)), kms });
  const servico = Object.assign(criarServicoCifra({ chaveiro, inquilino: config.criptoInquilino }), { chaveiro });
  cripto.definirServico(servico);
  const admin = criarAdmin({ q, servico, kms });
  try {
    let r;
    if (cmd === 'status') r = await admin.status();
    else if (cmd === 'migrar') r = await admin.migrar({ simular: !!opt('simular') });
    else if (cmd === 'rotacionar') r = await admin.rotacionar({ finalidade: String(opt('finalidade') || '') });
    else if (cmd === 'reembrulhar') r = await admin.reembrulhar();
    else if (cmd === 'recifrar') r = await admin.recifrar({ finalidade: String(opt('finalidade') || '') });
    else if (cmd === 'referencias') r = Object.fromEntries(await admin.referencias());
    else if (cmd === 'revogar') r = await admin.revogar({ dek: String(opt('dek') || ''), forcar: !!opt('forcar') });
    else if (cmd === 'destruir') r = await admin.destruir({ dek: String(opt('dek') || '') });
    else { console.log('Comandos: status | migrar [--simular] | rotacionar --finalidade F | reembrulhar | recifrar --finalidade F | referencias | revogar --dek ID [--forcar] | destruir --dek ID'); process.exitCode = 2; return; }
    console.log(JSON.stringify(r, null, 2));
  } finally { chaveiro.esquecer(); await client.end(); }
})().catch(e => { console.error('ERRO:', e.codigo || '', e.message); process.exit(1); });
