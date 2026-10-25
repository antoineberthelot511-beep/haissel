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
process.env.APP_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
process.env.JWT_SECRET = '';
process.env.MAIL_TRANSPORT = 'memory';
process.env.ADMIN_REQUIRE_MFA = 'true';
process.env.COOKIE_SECURE = 'false';
process.env.PROXY_SHARED_SECRET = 'test-proxy-secret-0123456789-abcdefghijklmnop';
process.env.AFFILIATE_WEBHOOK_SECRET = 'test-webhook-secret-0123456789-abcdefghijklmn';
process.env.ALLOWED_EMAIL_DOMAIN = '';
/*
 * Turnstile neutralisé : les tests n'ont pas de navigateur pour resoudre le
 * défi anti-robot. Pose AVANT dotenv.config() ci-dessous, qui n'écrase jamais
 * une variable deja définie -- sinon les clés réelles du .env rendraient
 * toute connexion impossible (400 TURNSTILE_REQUIRED).
 */
process.env.TURNSTILE_SITE_KEY = '';
process.env.TURNSTILE_SECRET_KEY = '';
process.env.CORS_ORIGINS = '';
process.env.DATABASE_SCHEMA = SCHEMA;
process.env.DATABASE_POOL_MAX = '5';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const { Pool } = require('pg');
const argon2 = require('argon2');
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

const PASSWORD = 'Password123!';
// Hash Argon2id rapide pour les tests (format identique, coût réduit).
let fastHashPromise;
const fastHash = () => {
  if (!fastHashPromise) fastHashPromise = argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 1024, timeCost: 2, parallelism: 1 });
  return fastHashPromise;
};

/**
 * Crée un utilisateur directement en base (mot de passe : Password123!).
 * Les administrateurs ont la double authentification déjà activée
 * (secret TOTP connu des tests, voir login()).
 */
async function createUser({
  admin = false, active = true, banned = false, verified = true, mfaSecret = null, prefix = 'user',
  adult = true,
} = {}) {
  const { pool } = require('../../src/config/database');
  const mfa = require('../../src/services/mfa.service');
  counter += 1;
  const username = `${prefix}${counter}_${crypto.randomBytes(2).toString('hex')}`;
  const secret = mfaSecret || (admin ? mfa.generateSecret() : null);
  /*
   * adult : true (defaut) = majeur déclaré, false = mineur déclaré,
   * null = question pas encore posée (comptes antérieurs a la declaration).
   * Le défaut est « majeur » pour que les suites existantes, qui publient des
   * offres, continuent de fonctionner sans modification.
   */
  const result = await pool.query(
    `INSERT INTO users (username, email, password_hash, display_name, first_name, last_name,
                        is_active, is_banned, email_verified_at, mfa_enabled, mfa_secret_enc,
                        is_adult, adult_declared_at)
     VALUES ($1, $2, $3, $4, 'Test', 'User', $5, $6, $7, $8, $9, $10,
             CASE WHEN $10::boolean IS NULL THEN NULL ELSE NOW() END)
     RETURNING id, username, email, is_adult`,
    [username, `${username}@exemple.fr`, await fastHash(), `Test ${username}`, active, banned,
      verified ? new Date() : null, Boolean(secret), secret ? mfa.encryptSecret(secret) : null,
      adult]
  );
  const user = { ...result.rows[0], mfaSecret: secret };
  if (admin) {
    await pool.query("INSERT INTO admins (user_id, role) VALUES ($1, 'ADMIN')", [user.id]);
  }
  return user;
}

/** Code TOTP valide « maintenant » ; l'anti-rejeu est réinitialisé pour les tests. */
async function totpFor(user) {
  const { pool } = require('../../src/config/database');
  const mfa = require('../../src/services/mfa.service');
  await pool.query('UPDATE users SET mfa_last_step = NULL WHERE id = $1', [user.id]);
  return mfa.hotp(user.mfaSecret, mfa.currentStep());
}

function extractCookie(res) {
  const header = (res.headers['set-cookie'] || []).find((c) => /^(__Host-)?haissel_sid=[^;]+/.test(c));
  return header ? header.split(';')[0] : null;
}

/**
 * Connexion complète (mot de passe, puis TOTP si nécessaire).
 * Retourne une « identité » de test : { cookie, csrf }.
 */
async function login(app, user, { headers = {} } = {}) {
  let res = await request(app).post('/api/auth/login').set(headers)
    .send({ identifier: user.username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed (${res.status}): ${JSON.stringify(res.body)}`);
  let identity = { cookie: extractCookie(res), csrf: res.body.data.csrf_token };

  if (res.body.data.mfa_required) {
    res = await request(app).post('/api/auth/mfa/verify').set(headers).set(auth(identity))
      .send({ code: await totpFor(user) });
    if (res.status !== 200) throw new Error(`MFA failed (${res.status}): ${JSON.stringify(res.body)}`);
    identity = { cookie: extractCookie(res), csrf: res.body.data.csrf_token };
  }
  return identity;
}

/** En-têtes d'une requête authentifiée (cookie de session + jeton CSRF). */
function auth(identity) {
  return { Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf };
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
  PASSWORD,
  auth,
  totpFor,
  extractCookie,
  SCHEMA,
  setupDatabase,
  teardownDatabase,
  createUser,
  login,
  lanHeaders,
  signWebhook,
};
