/*
 * Environnement des tests d'intégration.
 *
 * Les tests utilisent un vrai PostgreSQL (DATABASE_URL du .env, ou
 * TEST_DATABASE_URL si défini) mais travaillent dans un schéma dédié,
 * créé puis supprimé à chaque exécution : les données réelles ne sont
 * jamais lues ni modifiées.
 *
 * Ce module doit être requis AVANT src/app.js.
 */
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const SCHEMA = `haissel_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
process.env.PROXY_SHARED_SECRET = 'test-proxy-secret-0123456789-abcdefghijklmnop';
process.env.AFFILIATE_WEBHOOK_SECRET = 'test-webhook-secret-0123456789-abcdefghijklmn';
process.env.ALLOWED_EMAIL_DOMAIN = '';
process.env.CORS_ORIGINS = '';
process.env.DATABASE_SCHEMA = SCHEMA;
process.env.DATABASE_POOL_MAX = '5';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

async function setupDatabase() {
  await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
  const { pool } = require('../../src/config/database');
  const { runMigrations } = require('../../src/db/migrator');
  await runMigrations(pool, { log: () => {} });
  return pool;
}

async function teardownDatabase() {
  const { pool } = require('../../src/config/database');
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await adminPool.end();
}

let counter = 0;

/** Crée un utilisateur directement en base (mot de passe : Password123!). */
async function createUser({ admin = false, active = true, banned = false, prefix = 'user' } = {}) {
  const { pool } = require('../../src/config/database');
  counter += 1;
  const username = `${prefix}${counter}_${crypto.randomBytes(2).toString('hex')}`;
  const hash = await bcrypt.hash('Password123!', 4);
  const result = await pool.query(
    `INSERT INTO users (username, email, password_hash, display_name, is_active, is_banned)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, email`,
    [username, `${username}@exemple.fr`, hash, `Test ${username}`, active, banned]
  );
  const user = result.rows[0];
  if (admin) {
    await pool.query("INSERT INTO admins (user_id, role) VALUES ($1, 'ADMIN')", [user.id]);
  }
  return user;
}

async function login(app, user) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ identifier: user.username, password: 'Password123!' });
  if (res.status !== 200) throw new Error(`Login failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

/** En-têtes simulant une requête relayée par Nginx depuis un appareil du LAN. */
function lanHeaders(ip = '192.168.1.50') {
  return {
    'X-Haissel-Proxy-Secret': process.env.PROXY_SHARED_SECRET,
    'X-Real-IP': ip,
  };
}

function signWebhook(body, { secret = process.env.AFFILIATE_WEBHOOK_SECRET, timestamp } = {}) {
  const ts = String(timestamp || Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { 'X-Haissel-Timestamp': ts, 'X-Haissel-Signature': `sha256=${signature}`, 'Content-Type': 'application/json' };
}

module.exports = {
  SCHEMA,
  setupDatabase,
  teardownDatabase,
  createUser,
  login,
  lanHeaders,
  signWebhook,
};
