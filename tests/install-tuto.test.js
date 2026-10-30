/*
 * Tuto d'installation « vu », mémorisé sur le compte
 * (users.install_tuto_seen_at, POST /api/auth/install-tuto/seen).
 * PostgreSQL réel (schéma isolé).
 */
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const { createUser, login, auth } = helpers;
let pool;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
}, 60000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

const MIGRATION = fs.readFileSync(path.join(__dirname, '../database/migrations/20261027_0014_install_tuto.sql'), 'utf8');

describe('endpoint et profil', () => {
  test('nouveau compte : jamais vu ; POST le marque « vu », définitivement', async () => {
    const identity = await login(app, await createUser({ prefix: 'tutonew' }));
    let me = await request(app).get('/api/auth/me').set(auth(identity));
    expect(me.body.data.user.install_tuto_seen).toBe(false);

    const res = await request(app).post('/api/auth/install-tuto/seen').set(auth(identity)).send({});
    expect(res.status).toBe(200);
    me = await request(app).get('/api/auth/me').set(auth(identity));
    expect(me.body.data.user.install_tuto_seen).toBe(true);

    // Reconnexion ou autre appareil : toujours « vu » (sur le compte). Première date conservée.
    const first = (await pool.query('SELECT install_tuto_seen_at FROM users WHERE id = $1', [me.body.data.user.id])).rows[0].install_tuto_seen_at;
    await request(app).post('/api/auth/install-tuto/seen').set(auth(identity)).send({}).expect(200);
    const again = (await pool.query('SELECT install_tuto_seen_at FROM users WHERE id = $1', [me.body.data.user.id])).rows[0].install_tuto_seen_at;
    expect(again.getTime()).toBe(first.getTime());
  });

  test('protégé : session obligatoire, jeton CSRF obligatoire', async () => {
    expect((await request(app).post('/api/auth/install-tuto/seen').send({})).status).toBe(401);
    const identity = await login(app, await createUser({ prefix: 'tutocsrf' }));
    const noCsrf = await request(app).post('/api/auth/install-tuto/seen').set('Cookie', identity.cookie).send({});
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_REJECTED');
    const me = await request(app).get('/api/auth/me').set(auth(identity));
    expect(me.body.data.user.install_tuto_seen).toBe(false);
  });
});

describe('migration', () => {
  test('comptes existants marqués « vu » une seule fois ; réexécutable sans toucher aux nouveaux comptes', async () => {
    const client = await pool.connect();
    try {
      await client.query('CREATE SCHEMA tuto_migration_test');
      await client.query('SET search_path TO tuto_migration_test');
      await client.query('CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT, created_at TIMESTAMPTZ DEFAULT NOW())');
      await client.query("INSERT INTO users (username) VALUES ('ancien1'), ('ancien2')");

      await client.query(MIGRATION);
      const old = (await client.query('SELECT install_tuto_seen_at FROM users ORDER BY id')).rows;
      expect(old.every((row) => row.install_tuto_seen_at !== null)).toBe(true);

      // Compte créé après la migration : jamais vu, même si la migration est rejouée.
      await client.query("INSERT INTO users (username) VALUES ('nouveau')");
      await client.query(MIGRATION);
      const fresh = (await client.query("SELECT install_tuto_seen_at FROM users WHERE username = 'nouveau'")).rows[0];
      expect(fresh.install_tuto_seen_at).toBeNull();
      expect((await client.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n).toBe(3);
    } finally {
      await client.query('DROP SCHEMA IF EXISTS tuto_migration_test CASCADE');
      await client.query('RESET search_path');
      client.release();
    }
  });

  test('non destructive : aucun DROP ni DELETE', () => {
    expect(MIGRATION).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });
});
