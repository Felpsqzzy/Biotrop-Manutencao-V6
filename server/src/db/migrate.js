const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const root = path.resolve(__dirname, '..', '..', '..');
const migrationDir = path.join(root, 'database', 'migrations');
const enabled = value => String(value || '').toLowerCase() === 'true';
const databaseAdminUrl = String(process.env.DATABASE_ADMIN_URL || '').trim();
if (!databaseAdminUrl) throw new Error('Variável obrigatória ausente: DATABASE_ADMIN_URL');

(async () => {
  const client = new Client({
    connectionString: databaseAdminUrl,
    ssl: enabled(process.env.DATABASE_SSL) ? {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(process.env.DATABASE_SSL_CA ? { ca: String(process.env.DATABASE_SSL_CA).replace(/\\n/g, '\n') } : {})
    } : undefined
  });
  try {
    await client.connect();
    const files = fs.readdirSync(migrationDir).filter(name => /^\d.*\.sql$/i.test(name)).sort();
    for (const file of files) {
      process.stdout.write(`Aplicando ${file}... `);
      await client.query(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
      process.stdout.write('ok\n');
    }
    if (process.env.APP_DB_PASSWORD) {
      const literal = String(process.env.APP_DB_PASSWORD).replaceAll("'", "''");
      await client.query(`ALTER ROLE biotrop_app LOGIN PASSWORD '${literal}'`);
    }
    if (process.env.WORKER_DB_PASSWORD) {
      const literal = String(process.env.WORKER_DB_PASSWORD).replaceAll("'", "''");
      await client.query(`ALTER ROLE biotrop_worker LOGIN PASSWORD '${literal}'`);
    }
    console.log('Banco BIOTROP atualizado.');
  } finally {
    await client.end().catch(() => {});
  }
})().catch(error => { console.error(error); process.exit(1); });
