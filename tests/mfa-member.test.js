/*
 * Double authentification réservée aux administrateurs.
 *
 *  - un membre sans double authentification ne peut pas la mettre en place
 *    (setup / enable : 403) et ne voit pas le bloc dans Sécurité ;
 *  - un membre qui l'avait déjà activée la garde : le code lui est toujours
 *    demandé à la connexion, et il peut la désactiver (mot de passe + code) ;
 *  - administrateur : inchangé (obligatoire, mise en place possible, pas de
 *    désactivation).
 */
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const mfa = require('../src/services/mfa.service');

const { createUser, login, auth, totpFor, extractCookie, PASSWORD } = helpers;

let pool;

async function codeFor(secret) {
  return mfa.hotp(secret, mfa.currentStep());
}

/** Administrateur dont la double authentification n'est pas encore en place. */
async function adminWithoutMfa() {
  const user = await createUser({ prefix: 'mfanewadmin' });
  await pool.query("INSERT INTO admins (user_id, role) VALUES ($1, 'ADMIN')", [user.id]);
  return user;
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

// ===========================================================================
describe('Membre sans double authentification', () => {
  let member;
  let identity;

  beforeEach(async () => {
    member = await createUser({ prefix: 'mfamembre' });
    identity = await login(app, member);
  });

  test('la mise en place est refusée (403), même avec le bon mot de passe', async () => {
    const setup = await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD });
    expect(setup.status).toBe(403);
    expect(setup.body.error.code).toBe('MFA_ADMIN_ONLY');
    const enable = await request(app).post('/api/auth/mfa/enable').set(auth(identity)).send({ code: '123456' });
    expect(enable.status).toBe(403);
    const row = await pool.query('SELECT mfa_enabled, mfa_pending_secret_enc FROM users WHERE id = $1', [member.id]);
    expect(row.rows[0]).toEqual({ mfa_enabled: false, mfa_pending_secret_enc: null });
  });

  test('le compte reste pleinement utilisable', async () => {
    expect((await request(app).get('/api/auth/me').set(auth(identity))).body.data.user.mfa_enabled).toBe(false);
    expect((await request(app).get('/api/community/offers').set(auth(identity))).status).toBe(200);
    expect((await request(app).get('/api/community/offers/mine').set(auth(identity))).status).toBe(200);
  });

  test('aucun bloc dans Sécurité : masqué par défaut, montré seulement aux ADMIN ou si déjà active', () => {
    const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
    expect(html).toMatch(/<div class="profile-card-box security-box" id="mfa-box" hidden>/);
    expect(app).toContain("const isAdmin = String(state.user.role || '').toUpperCase() === 'ADMIN';");
    expect(app).toContain('box.hidden = !isAdmin && !active;');
  });
});

// ===========================================================================
describe('Membre qui l’avait déjà activée', () => {
  let member;

  beforeEach(async () => {
    member = await createUser({ prefix: 'mfaancien', mfaSecret: mfa.generateSecret() });
  });

  test('le code est toujours demandé à la connexion', async () => {
    const step1 = await request(app).post('/api/auth/login').send({ identifier: member.username, password: PASSWORD });
    expect(step1.body.data.mfa_required).toBe(true);
    const pending = { cookie: extractCookie(step1), csrf: step1.body.data.csrf_token };
    expect((await request(app).get('/api/community/offers').set(auth(pending))).status).toBe(401);
    const verified = await request(app).post('/api/auth/mfa/verify').set(auth(pending)).send({ code: await totpFor(member) });
    expect(verified.status).toBe(200);
  });

  test('désactivation : mot de passe seul refusé, mot de passe + code acceptés', async () => {
    const identity = await login(app, member);
    expect((await request(app).post('/api/auth/mfa/disable').set(auth(identity)).send({ password: PASSWORD })).status).toBe(401);

    await pool.query('UPDATE users SET mfa_last_step = NULL WHERE id = $1', [member.id]);
    const res = await request(app).post('/api/auth/mfa/disable')
      .set(auth(identity)).send({ password: PASSWORD, code: await codeFor(member.mfaSecret) });
    expect(res.status).toBe(200);
    const row = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [member.id]);
    expect(row.rows[0].mfa_enabled).toBe(false);
    const codes = await pool.query('SELECT COUNT(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1', [member.id]);
    expect(codes.rows[0].n).toBe(0);
  });

  test('une fois désactivée, il ne peut plus la remettre', async () => {
    await pool.query('UPDATE users SET mfa_enabled = FALSE, mfa_secret_enc = NULL WHERE id = $1', [member.id]);
    const identity = await login(app, member);
    expect((await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD })).status).toBe(403);
  });
});

// ===========================================================================
describe('Administrateur : inchangé', () => {
  test('ne peut pas la désactiver', async () => {
    const admin = await createUser({ admin: true, prefix: 'mfaadmin' });
    const identity = await login(app, admin);
    const res = await request(app).post('/api/auth/mfa/disable')
      .set(auth(identity)).send({ password: PASSWORD, code: await totpFor(admin) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED_FOR_ADMIN');
  });

  test('mise en place : clé chiffrée au repos, jamais renvoyée par /me, code exigé', async () => {
    const admin = await adminWithoutMfa();
    const identity = await login(app, admin);
    const setup = await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD });
    expect(setup.status).toBe(200);
    expect(setup.body.data.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    const { secret } = setup.body.data;

    const row = await pool.query('SELECT mfa_pending_secret_enc FROM users WHERE id = $1', [admin.id]);
    expect(row.rows[0].mfa_pending_secret_enc).not.toContain(secret);
    const me = JSON.stringify((await request(app).get('/api/auth/me').set(auth(identity))).body);
    expect(me).not.toMatch(/secret|otpauth/i);

    const bad = await request(app).post('/api/auth/mfa/enable').set(auth(identity)).send({ code: '000000' });
    expect(bad.status).toBe(400);
    const enable = await request(app).post('/api/auth/mfa/enable').set(auth(identity)).send({ code: await codeFor(secret) });
    expect(enable.status).toBe(200);
    expect(enable.body.data.recovery_codes.length).toBeGreaterThan(0);
    // Session renouvelée : l'ancien cookie ne vaut plus.
    expect((await request(app).get('/api/auth/me').set(auth(identity))).status).toBe(401);
  });
});
