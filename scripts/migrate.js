/*
 * Applique le schéma de base et les migrations non encore appliquées.
 *
 *   npm run migrate
 *
 * Idempotent : les migrations déjà enregistrées dans schema_migrations
 * sont ignorées. Ne supprime jamais de données.
 */
const { pool } = require('../src/config/database');
const { runMigrations } = require('../src/db/migrator');

runMigrations(pool)
  .then((applied) => {
    console.log(applied.length
      ? `${applied.length} migration(s) appliquée(s).`
      : 'Base de données déjà à jour.');
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
