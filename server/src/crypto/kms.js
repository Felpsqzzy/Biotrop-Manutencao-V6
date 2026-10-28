'use strict';
// Provedores de KEK (chave que protege as DEKs). A KEK nunca sai do provedor:
//
//  • azure  — Azure Key Vault (chave RSA-HSM/RSA, operações wrapKey/unwrapKey RSA-OAEP-256), acessado pela
//             identidade gerenciada da VM (sem segredo em disco). É o ÚNICO provedor aceito em produção.
//  • local  — somente desenvolvimento/testes: KEK AES-256 vinda de BIOMANUT_KEK_LOCAL (base64, 32 bytes);
//             embrulha a DEK com AES-256-GCM e AAD. Recusado quando NODE_ENV=production.
//
// Falha fechada: se o provedor não responde, nada é cifrado nem decifrado (o chamador recebe erro) —
// nunca se grava texto claro nem se usa chave de emergência.
const crypto = require('node:crypto');
const { ErroCifra } = require('./formato');

const ALG_WRAP_AZURE = 'RSA-OAEP-256';

function provedorLocal({ kekBase64, producao }) {
  if (producao) throw new ErroCifra('KMS_LOCAL_EM_PRODUCAO', 'KEK local é proibida em produção: use o Azure Key Vault.');
  const kek = Buffer.from(String(kekBase64 || ''), 'base64');
  if (kek.length !== 32) throw new ErroCifra('KMS_CONFIG', 'BIOMANUT_KEK_LOCAL deve ter 32 bytes em base64.');
  const kid = 'local:' + crypto.createHash('sha256').update(kek).digest('hex').slice(0, 16);
  const aad = (dekId, finalidade) => Buffer.from(`biomanut-dek-wrap-v1;dek=${dekId};finalidade=${finalidade}`, 'utf8');
  return {
    nome: 'local',
    kekId: kid,
    async embrulhar(dek, { dekId, finalidade }) {
      const nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', kek, nonce);
      c.setAAD(aad(dekId, finalidade));
      const ct = Buffer.concat([c.update(dek), c.final()]);
      return { kekId: kid, envelopada: Buffer.concat([Buffer.from([0x01]), nonce, ct, c.getAuthTag()]) };
    },
    async desembrulhar(envelopada, { dekId, finalidade, kekId }) {
      if (kekId !== kid) throw new ErroCifra('KEK_DESCONHECIDA', 'DEK embrulhada por outra KEK.');
      const b = Buffer.from(envelopada);
      if (b.length !== 1 + 12 + 32 + 16 || b[0] !== 0x01) throw new ErroCifra('DEK_FORMATO', 'DEK embrulhada inválida.');
      const d = crypto.createDecipheriv('aes-256-gcm', kek, b.subarray(1, 13));
      d.setAAD(aad(dekId, finalidade));
      d.setAuthTag(b.subarray(b.length - 16));
      try { return Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]); }
      catch { throw new ErroCifra('DEK_AUTENTICACAO', 'Falha ao autenticar a DEK embrulhada.'); }
    }
  };
}

function provedorAzure({ keyId, timeoutMs = 8000 }) {
  if (!/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/keys\/[A-Za-z0-9-]+(\/[0-9a-f]{32})?$/.test(String(keyId || ''))) {
    throw new ErroCifra('KMS_CONFIG', 'AZURE_KEYVAULT_KEY_ID deve ser a URL da chave no Key Vault (https://<cofre>.vault.azure.net/keys/<nome>).');
  }
  // Carregados sob demanda: os testes e o modo local não dependem do SDK.
  const { ManagedIdentityCredential, DefaultAzureCredential } = require('@azure/identity');
  const { CryptographyClient } = require('@azure/keyvault-keys');
  const credencial = process.env.AZURE_CLIENT_ID || process.env.NODE_ENV === 'production'
    ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID ? { clientId: process.env.AZURE_CLIENT_ID } : undefined)
    : new DefaultAzureCredential();
  const clientes = new Map();
  const cliente = kid => { if (!clientes.has(kid)) clientes.set(kid, new CryptographyClient(kid, credencial)); return clientes.get(kid); };
  const comPrazo = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new ErroCifra('KMS_INDISPONIVEL', 'Key Vault não respondeu no prazo.')), timeoutMs))]);
  return {
    nome: 'azure',
    kekId: keyId,
    async embrulhar(dek) {
      try {
        const r = await comPrazo(cliente(keyId).wrapKey(ALG_WRAP_AZURE, dek));
        return { kekId: r.keyID, envelopada: Buffer.from(r.result) };   // kid versionado: o desembrulho usa exatamente essa versão
      } catch (e) { throw e instanceof ErroCifra ? e : new ErroCifra('KMS_INDISPONIVEL', 'Falha no Key Vault ao embrulhar a DEK.'); }
    },
    async desembrulhar(envelopada, { kekId }) {
      if (!String(kekId || '').startsWith(keyId.replace(/\/[0-9a-f]{32}$/, ''))) throw new ErroCifra('KEK_DESCONHECIDA', 'DEK embrulhada por chave de outro cofre.');
      try {
        const r = await comPrazo(cliente(kekId).unwrapKey(ALG_WRAP_AZURE, envelopada));
        const dek = Buffer.from(r.result);
        if (dek.length !== 32) throw new ErroCifra('DEK_FORMATO', 'DEK com tamanho inválido.');
        return dek;
      } catch (e) { throw e instanceof ErroCifra ? e : new ErroCifra('KMS_INDISPONIVEL', 'Falha no Key Vault ao desembrulhar a DEK.'); }
    }
  };
}

function criarProvedor(cfg) {
  const nome = String(cfg.provedor || '').toLowerCase();
  if (nome === 'azure') return provedorAzure({ keyId: cfg.azureKeyId, timeoutMs: cfg.timeoutMs });
  if (nome === 'local') return provedorLocal({ kekBase64: cfg.kekLocal, producao: cfg.producao });
  throw new ErroCifra('KMS_CONFIG', 'KMS_PROVEDOR deve ser "azure" (produção) ou "local" (desenvolvimento).');
}

module.exports = { criarProvedor, provedorLocal, provedorAzure };
