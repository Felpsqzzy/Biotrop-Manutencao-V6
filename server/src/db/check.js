const { pool } = require('./pool');

(async () => {
  const result = await pool.query(`SELECT current_database() AS banco,
    to_regclass('core.usuario') AS usuarios,
    to_regclass('core.email_autorizado') AS autorizados,
    to_regclass('app.sync_registro') AS sincronizacao`);
  const row = result.rows[0];
  if (!row.usuarios || !row.autorizados || !row.sincronizacao) throw new Error('Schema BIOTROP incompleto.');
  console.log(JSON.stringify({ ok: true, ...row }, null, 2));
  await pool.end();
})().catch(error => { console.error(error); process.exit(1); });
