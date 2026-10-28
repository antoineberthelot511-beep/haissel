const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

// Schéma PostgreSQL optionnel (utilisé par les tests d'intégration pour
// travailler dans un schéma isolé sans toucher aux données réelles).
const schema = process.env.DATABASE_SCHEMA || '';
if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
  throw new Error('DATABASE_SCHEMA must be a simple lowercase identifier.');
}

/*
 * Adresse de la base.
 * Sur Vercel, une base Neon/Postgres reliée au projet publie son adresse
 * sous « <PRÉFIXE>_DATABASE_URL » (préfixe choisi à la création). Si
 * DATABASE_URL est absente ou pointe vers localhost (copie d'un .env local,
 * inutilisable sur Vercel), cette adresse est utilisée à la place.
 * Option { unpooled } : connexion directe (migrations, verrou consultatif).
 */
function isLocalhostUrl(url) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch (error) {
    return false;
  }
}

function resolveDatabaseUrl({ unpooled = false } = {}) {
  const explicit = process.env.DATABASE_URL || '';
  if (explicit && !(process.env.VERCEL === '1' && isLocalhostUrl(explicit))) return explicit;

  const suffix = unpooled ? '_DATABASE_URL_UNPOOLED' : '_DATABASE_URL';
  const candidates = Object.keys(process.env)
    .filter((key) => key.endsWith(suffix) && process.env[key])
    .sort();
  if (candidates.length) return process.env[candidates[0]];
  return unpooled ? resolveDatabaseUrl() : explicit;
}

/*
 * TLS : pg signale que sslmode=prefer/require/verify-ca dans l'adresse sont
 * traités comme verify-full (avertissement répété dans les journaux). On
 * retire donc sslmode (et les paramètres associés) de l'adresse donnée à pg
 * et on demande explicitement la vérification du certificat : même
 * comportement sécurisé, sans avertissement. DATABASE_URL n'est pas modifiée
 * et l'adresse n'est jamais journalisée.
 */
const SSL_URL_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

function stripSslParams(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    SSL_URL_PARAMS.forEach((name) => parsed.searchParams.delete(name));
    return parsed.toString();
  } catch (error) {
    return url;
  }
}

function poolSslConfig(env = process.env) {
  return env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false;
}

const databaseSsl = poolSslConfig();

const pool = new Pool({
  connectionString: databaseSsl ? stripSslParams(resolveDatabaseUrl()) : resolveDatabaseUrl(),
  max: Number(process.env.DATABASE_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: databaseSsl,
  ...(schema ? { options: `-c search_path=${schema}` } : {}),
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err.message);
});

async function testConnection() {
  const result = await pool.query('SELECT NOW() AS current_time');
  return result.rows[0];
}

/**
 * Exécute fn(client) dans une transaction ; rollback automatique en cas
 * d'erreur.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

module.exports = {
  stripSslParams,
  poolSslConfig,
  pool,
  resolveDatabaseUrl,
  testConnection,
  withTransaction,
};
