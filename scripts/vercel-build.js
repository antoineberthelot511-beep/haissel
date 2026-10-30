/*
 * Étape de build Vercel : applique les migrations sur la base reliée au projet.
 *
 * Les variables secrètes de la base ne sont lisibles que sur Vercel : les
 * migrations y sont donc lancées à chaque déploiement. Elles sont idempotentes
 * (déjà appliquées = ignorées), protégées par un verrou et ne suppriment
 * jamais de données. Connexion directe (non poolée) quand elle existe.
 */
const { Pool } = require('pg');
const { resolveDatabaseUrl, stripSslParams, poolSslConfig } = require('../src/config/database');
const { runMigrations } = require('../src/db/migrator');

if (process.env.VERCEL !== '1') {
  console.log('vercel-build : hors Vercel, aucune migration lancée.');
  process.exit(0);
}

// Même TLS que l'application (src/config/database.js) : vérification explicite, sans sslmode dans l'adresse.
const ssl = poolSslConfig();
const url = resolveDatabaseUrl({ unpooled: true });
const pool = new Pool({ connectionString: ssl ? stripSslParams(url) : url, ssl, max: 1 });

runMigrations(pool)
  .then((applied) => {
    console.log(applied.length ? `${applied.length} migration(s) appliquée(s).` : 'Base de données déjà à jour.');
  })
  .catch((error) => {
    // Le déploiement échoue plutôt que de publier un site sans schéma.
    console.error(`Migration impossible : ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
