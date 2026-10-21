/*
 * Double authentification proposée aux membres.
 *
 * Elle existait déjà côté serveur mais n'était atteignable que depuis la
 * console d'administration : aucun écran ne la proposait aux membres. Ces
 * tests fixent le contrat sur lequel s'appuie le nouvel écran du Profil.
 *
 * Facultative pour un membre, imposée aux administrateurs.
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const mfa = require('../src/services/mfa.service');

const { createUser, login, auth, totpFor, PASSWORD } = helpers;

let pool;
let member;
let identity;

/** Code valide calculé à partir d'un secret connu du test. */
async function codeFor(secret) {
  return mfa.hotp(secret, mfa.currentStep());
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
}, 30000);

beforeEach(async () => {
  member = await createUser({ prefix: 'mfamembre', adult: true });
  identity = await login(app, member);
});

afterAll(async () => {
  await helpers.teardownDatabase();
});

// ===========================================================================
describe('Un membre peut activer la double authentification', () => {
  test('elle est inactive par défaut : le compte reste utilisable sans', async () => {
    const me = await request(app).get('/api/auth/me').set(auth(identity));
    expect(me.status).toBe(200);
    expect(me.body.data.user.mfa_enabled).toBe(false);
  });

  test('la mise en place exige le mot de passe', async () => {
    const res = await request(app).post('/api/auth/mfa/setup')
      .set(auth(identity)).send({ password: 'mauvais mot de passe' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('parcours complet : clé, code, codes de secours', async () => {
    const setup = await request(app).post('/api/auth/mfa/setup')
      .set(auth(identity)).send({ password: PASSWORD });
    expect(setup.status).toBe(200);
    expect(typeof setup.body.data.secret).toBe('string');
    // L'URI otpauth sert au QR code ; l'écran mobile affiche la clé en clair.
    expect(setup.body.data.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);

    // Tant que le code n'est pas confirmé, la protection n'est pas active.
    const stillOff = await request(app).get('/api/auth/me').set(auth(identity));
    expect(stillOff.body.data.user.mfa_enabled).toBe(false);

    const enable = await request(app).post('/api/auth/mfa/enable')
      .set(auth(identity)).send({ code: await codeFor(setup.body.data.secret) });
    expect(enable.status).toBe(200);

    const codes = enable.body.data.recovery_codes;
    expect(Array.isArray(codes)).toBe(true);
    expect(codes.length).toBeGreaterThan(0);
    // Codes affichés une seule fois : seuls leurs condensés sont conservés.
    const stored = await pool.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [member.id]);
    expect(stored.rows.length).toBe(codes.length);
    expect(stored.rows.every((r) => !codes.includes(r.code_hash))).toBe(true);

    // La session a été renouvelée : le nouveau jeton CSRF est fourni.
    expect(typeof enable.body.data.csrf_token).toBe('string');
  });

  test('un code faux ne l’active pas', async () => {
    await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD }).expect(200);
    const res = await request(app).post('/api/auth/mfa/enable').set(auth(identity)).send({ code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MFA_CODE');

    const row = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [member.id]);
    expect(row.rows[0].mfa_enabled).toBe(false);
  });

  test('confirmer un code sans avoir généré de clé est refusé', async () => {
    const res = await request(app).post('/api/auth/mfa/enable').set(auth(identity)).send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MFA_SETUP_MISSING');
  });

  test('on ne la met pas en place deux fois', async () => {
    const setup = await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD });
    const enable = await request(app).post('/api/auth/mfa/enable')
      .set(auth(identity)).send({ code: await codeFor(setup.body.data.secret) });
    expect(enable.status).toBe(200);

    /*
     * Activer la double authentification change le niveau de sécurité : le
     * serveur révoque les sessions et en ouvre une nouvelle. Il faut donc
     * reprendre le cookie et le jeton CSRF renvoyés — c'est ce que fait
     * l'interface, où api() met state.csrf à jour automatiquement.
     */
    const session = { cookie: helpers.extractCookie(enable) || identity.cookie, csrf: enable.body.data.csrf_token };

    const again = await request(app).post('/api/auth/mfa/setup').set(auth(session)).send({ password: PASSWORD });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('MFA_ALREADY_ENABLED');
  });

  test('la session est renouvelée à l’activation : l’ancien cookie ne vaut plus', async () => {
    const setup = await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD });
    await request(app).post('/api/auth/mfa/enable')
      .set(auth(identity)).send({ code: await codeFor(setup.body.data.secret) }).expect(200);

    // Protection contre un vol de session antérieur à l'activation.
    const old = await request(app).get('/api/auth/me').set(auth(identity));
    expect(old.status).toBe(401);
  });
});

// ===========================================================================
describe('Désactivation : mot de passe ET code', () => {
  let secret;
  let session;

  beforeEach(async () => {
    const setup = await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD });
    secret = setup.body.data.secret;
    const enable = await request(app).post('/api/auth/mfa/enable')
      .set(auth(identity)).send({ code: await codeFor(secret) });
    // L'activation renouvelle la session : on reprend le jeton CSRF renvoyé.
    session = { cookie: helpers.extractCookie(enable) || identity.cookie, csrf: enable.body.data.csrf_token };
  });

  test('le mot de passe seul ne suffit pas', async () => {
    const res = await request(app).post('/api/auth/mfa/disable').set(auth(session)).send({ password: PASSWORD });
    expect(res.status).toBe(401);
  });

  test('le code seul ne suffit pas', async () => {
    await pool.query('UPDATE users SET mfa_last_step = NULL WHERE id = $1', [member.id]);
    const res = await request(app).post('/api/auth/mfa/disable')
      .set(auth(session)).send({ code: await codeFor(secret) });
    expect(res.status).toBe(401);
  });

  test('les deux ensemble la désactivent', async () => {
    await pool.query('UPDATE users SET mfa_last_step = NULL WHERE id = $1', [member.id]);
    const res = await request(app).post('/api/auth/mfa/disable')
      .set(auth(session)).send({ password: PASSWORD, code: await codeFor(secret) });
    expect(res.status).toBe(200);

    const row = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [member.id]);
    expect(row.rows[0].mfa_enabled).toBe(false);
    // Les codes de secours sont effacés avec elle.
    const codes = await pool.query('SELECT COUNT(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1', [member.id]);
    expect(codes.rows[0].n).toBe(0);
  });
});

// ===========================================================================
describe('Elle reste facultative pour un membre, imposée aux administrateurs', () => {
  test('un membre sans double authentification accède normalement au site', async () => {
    const res = await request(app).get('/api/community/offers').set(auth(identity));
    expect(res.status).toBe(200);
  });

  test('un administrateur ne peut pas la désactiver', async () => {
    const admin = await createUser({ admin: true, prefix: 'mfaadmin' });
    const adminIdentity = await login(app, admin);
    const res = await request(app).post('/api/auth/mfa/disable')
      .set(auth(adminIdentity)).send({ password: PASSWORD, code: await totpFor(admin) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED_FOR_ADMIN');
  });

  test('aucune route ne la rend obligatoire pour un membre', async () => {
    // Publication, lecture, profil : tout fonctionne sans double authentification.
    expect((await request(app).get('/api/auth/me').set(auth(identity))).status).toBe(200);
    expect((await request(app).get('/api/learn/content').set(auth(identity))).status).toBe(200);
    expect((await request(app).get('/api/community/offers/mine').set(auth(identity))).status).toBe(200);
  });
});

// ===========================================================================
describe('Le secret ne fuite pas', () => {
  test('le secret en attente est chiffré en base, jamais stocké en clair', async () => {
    const setup = await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD });
    const secret = setup.body.data.secret;

    const row = await pool.query('SELECT mfa_pending_secret_enc FROM users WHERE id = $1', [member.id]);
    expect(row.rows[0].mfa_pending_secret_enc).toBeTruthy();
    expect(row.rows[0].mfa_pending_secret_enc).not.toContain(secret);
  });

  test('/api/auth/me ne renvoie jamais le secret', async () => {
    await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD }).expect(200);
    const me = await request(app).get('/api/auth/me').set(auth(identity));
    const body = JSON.stringify(me.body);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/otpauth/i);
  });
});
