const fs = require('fs');
const path = require('path');

const DATABASE_DIR = path.resolve(__dirname, '../../database');
const MIGRATIONS_DIR = path.join(DATABASE_DIR, 'migrations');
const BASELINE_NAME = 'init.sql';
const MIGRATION_LOCK_ID = 7_351_204;

/**
 * Liste ordonnée des fichiers à appliquer : init.sql (schéma de base,
 * entièrement idempotent) puis database/migrations/*.sql par ordre de nom.
 */
function listMigrationFiles() {
  const migrations = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  return [
    { name: BASELINE_NAME, file: path.join(DATABASE_DIR, BASELINE_NAME) },
    ...migrations.map((name) => ({ name, file: path.join(MIGRATIONS_DIR, name) })),
  ];
}

/**
 * Le runner gère lui-même la transaction : les BEGIN; / COMMIT; présents dans
 * d'anciens fichiers sont retirés pour que le fichier ET son enregistrement
 * dans schema_migrations soient atomiques.
 */
function stripTransactionStatements(sql) {
  return sql.replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, '');
}

async function runMigrations(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  const applied = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const done = await client.query('SELECT name FROM schema_migrations');
    const doneNames = new Set(done.rows.map((row) => row.name));

    for (const migration of listMigrationFiles()) {
      if (doneNames.has(migration.name)) continue;

      const sql = stripTransactionStatements(fs.readFileSync(migration.file, 'utf8'));

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        error.message = `Migration ${migration.name} failed: ${error.message}`;
        throw error;
      }

      applied.push(migration.name);
      log(`Migration applied: ${migration.name}`);
    }

    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/**
 * Tables indispensables au fonctionnement : utilisé au démarrage pour avertir
 * clairement si les migrations n'ont pas été appliquées.
 */
const REQUIRED_TABLES = [
  'users', 'sessions', 'admins', 'affiliate_links', 'user_affiliate_codes',
  'clicks', 'conversions', 'earnings', 'admin_actions',
];

async function findMissingTables(pool) {
  const result = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES]
  );
  const present = new Set(result.rows.map((row) => row.table_name));
  return REQUIRED_TABLES.filter((table) => !present.has(table));
}

module.exports = {
  runMigrations,
  findMissingTables,
  listMigrationFiles,
  stripTransactionStatements,
};
