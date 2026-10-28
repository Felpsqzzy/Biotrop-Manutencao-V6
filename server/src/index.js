const app = require('./app');
const config = require('./config');
const { pool } = require('./db/pool');

// Só na interface local por padrão (o nginx é a porta de entrada; ninguém forja X-Forwarded-For direto na porta 3000).
const server = app.listen(config.port, config.host, () => console.log(`BIOTROP ouvindo em ${config.host}:${config.port}`));

async function shutdown(signal) {
  console.log(`${signal}: encerrando com segurança`);
  server.close(async () => { await pool.end().catch(()=>{}); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
