const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  // TLS até o PostgreSQL com verificação do certificado e do nome do servidor (nunca desligada).
  // Mínimo TLS 1.2 (padrão do Azure Flexible Server); DATABASE_TLS_MIN=TLSv1.3 quando o servidor exigir 1.3.
  ssl: config.databaseSsl ? {
    rejectUnauthorized: true,
    minVersion: process.env.DATABASE_TLS_MIN === 'TLSv1.3' ? 'TLSv1.3' : 'TLSv1.2',
    ...(config.databaseSslCa ? { ca: config.databaseSslCa.replace(/\\n/g, '\n') } : {})
  } : undefined
});

pool.on('error', error => console.error('[DB POOL]', error?.code || '', String(error?.message || '').slice(0, 200)));

async function transaction(identity, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (identity?.id) {
      await client.query("select set_config('app.usuario_id', $1, true)", [String(identity.id)]);
      await client.query("select set_config('app.usuario_email', $1, true)", [String(identity.email || '')]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, transaction };
