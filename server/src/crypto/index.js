'use strict';
// Serviço de cifragem configurado para o app (singleton preguiçoso).
// Produção: KMS_PROVEDOR=azure + AZURE_KEYVAULT_KEY_ID; qualquer outra combinação é recusada na inicialização.
const config = require('../config');
const { criarProvedor } = require('./kms');
const { criarChaveiro, armazemPg } = require('./chaveiro');
const { criarServicoCifra } = require('./cifra');

let servico = null;

function obterServico() {
  if (servico) return servico;
  const { pool } = require('../db/pool');
  const consulta = (sql, params) => pool.query(sql, params);
  const transacao = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn((s, p) => client.query(s, p));
      await client.query('COMMIT');
      return r;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  };
  const kms = criarProvedor({ provedor: config.kmsProvedor, azureKeyId: config.azureKeyVaultKeyId, kekLocal: config.kekLocal, producao: config.production });
  const chaveiro = criarChaveiro({ armazem: armazemPg(consulta, transacao), kms });
  servico = criarServicoCifra({ chaveiro, inquilino: config.criptoInquilino });
  servico.chaveiro = chaveiro;
  return servico;
}

/** Para testes: injeta um serviço já montado (ex.: chaveiro em memória + KEK local). */
function definirServico(s) { servico = s; }

module.exports = { obterServico, definirServico };
