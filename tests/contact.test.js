/*
 * Formulaire de contact : validation, membre connecté (CSRF, e-mail
 * facultatif), limite par compte, Turnstile, console admin, notification,
 * rétention. PostgreSQL réel (schéma isolé).
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const push = require('../src/services/push.service');
const { purgeExpiredData } = require('../src/services/retention.service');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let adminUser;
let member;
let memberUser;
let pushSpy;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  adminUser = await createUser({ admin: true, prefix: 'ctadmin' });
  admin = await login(app, adminUser);
  memberUser = await createUser({ prefix: 'ctmember' });
  member = await login(app, memberUser);
}, 30000);

beforeEach(() => {
  pushSpy = jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 1 });
});

afterEach(() => {
  pushSpy.mockRestore();
  process.env.TURNSTILE_SITE_KEY = '';
  process.env.TURNSTILE_SECRET_KEY = '';
});

afterAll(async () => {
  await helpers.teardownDatabase();
});

const MESSAGE = 'Bonjour, je voudrais une précision sur une fiche publiée.';
const body = (overrides = {}) => ({ subject: 'question', message: MESSAGE, reply_email: 'visiteur@exemple.fr', ...overrides });
const sendAnonymous = (payload) => request(app).post('/api/contact').send(payload);

describe('validation', () => {
  test.each([
    ['sujet inconnu', { subject: 'pub' }, 'INVALID_SUBJECT'],
    ['sujet absent', { subject: undefined }, 'INVALID_SUBJECT'],
    ['message trop court', { message: 'Trop court.' }, 'INVALID_MESSAGE'],
    ['message trop long', { message: 'a'.repeat(2001) }, 'INVALID_MESSAGE'],
    ['e-mail absent sans compte', { reply_email: '' }, 'EMAIL_REQUIRED'],
    ['e-mail invalide', { reply_email: 'pas-un-email' }, 'INVALID_EMAIL'],
  ])('%s → 400', async (_, overrides, code) => {
    const res = await sendAnonymous(body(overrides));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('visiteur sans compte : demande enregistrée, admins notifiés sans le contenu', async () => {
    const res = await sendAnonymous(body({ subject: 'privacy', message: `${MESSAGE} <script>alert(1)</script>` }));
    expect(res.status).toBe(201);
    const row = (await pool.query('SELECT * FROM contact_requests WHERE id = $1', [res.body.data.id])).rows[0];
    expect(row).toMatchObject({ user_id: null, subject: 'privacy', reply_email: 'visiteur@exemple.fr', handled_at: null });
    expect(pushSpy).toHaveBeenCalledWith(adminUser.id, expect.objectContaining({ body: 'Nouvelle demande de contact' }), { urgency: 'high' });
    for (const [, payload] of pushSpy.mock.calls) expect(JSON.stringify(payload)).not.toContain('précision');
  });
});

describe('membre connecté', () => {
  test('sans jeton CSRF : refusé', async () => {
    const res = await request(app).post('/api/contact').set('Cookie', auth(member).Cookie).send(body());
    expect(res.status).toBe(403);
  });

  test('e-mail facultatif, demande liée au compte, puis 3 par heure au plus', async () => {
    await pool.query('DELETE FROM contact_requests WHERE user_id = $1', [memberUser.id]);
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/contact').set(auth(member)).send(body({ reply_email: '' }));
      expect(res.status).toBe(201);
    }
    const rows = (await pool.query('SELECT user_id, reply_email FROM contact_requests WHERE user_id = $1', [memberUser.id])).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0].reply_email).toBeNull();
    const fourth = await request(app).post('/api/contact').set(auth(member)).send(body());
    expect(fourth.status).toBe(429);
  });
});

describe('Turnstile', () => {
  test('clés actives sans jeton : refusé', async () => {
    process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    const res = await sendAnonymous(body());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TURNSTILE_REQUIRED');
  });
});

describe('console admin', () => {
  test('liste, puis « Marquer comme traité »', async () => {
    const created = await sendAnonymous(body({ subject: 'report' }));
    const list = await request(app).get('/api/admin/contact').set(auth(admin));
    expect(list.status).toBe(200);
    const item = list.body.data.items.find((row) => row.id === created.body.data.id);
    expect(item).toMatchObject({ subject_label: 'Signaler un contenu', handled_at: null, message: MESSAGE });

    const done = await request(app).post(`/api/admin/contact/${item.id}/handled`).set(auth(admin)).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.handled_at).toBeTruthy();
    expect((await request(app).post('/api/admin/contact/999999/handled').set(auth(admin)).send({})).status).toBe(404);
  });

  test('réservée aux administrateurs', async () => {
    const res = await request(app).get('/api/admin/contact').set(auth(member));
    expect([401, 403]).toContain(res.status);
  });
});

describe('rétention et suppression de compte', () => {
  test('supprimées après 12 mois', async () => {
    const res = await sendAnonymous(body());
    await pool.query("UPDATE contact_requests SET created_at = NOW() - INTERVAL '13 months' WHERE id = $1", [res.body.data.id]);
    await purgeExpiredData();
    expect((await pool.query('SELECT 1 FROM contact_requests WHERE id = $1', [res.body.data.id])).rows).toHaveLength(0);
  });

  test('compte supprimé : la demande reste, sans lien vers le compte', async () => {
    const user = await createUser({ prefix: 'ctgone' });
    const { rows } = await pool.query(
      "INSERT INTO contact_requests (user_id, subject, message) VALUES ($1, 'other', $2) RETURNING id", [user.id, MESSAGE]
    );
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const row = (await pool.query('SELECT user_id FROM contact_requests WHERE id = $1', [rows[0].id])).rows[0];
    expect(row.user_id).toBeNull();
  });
});

describe('page /contact', () => {
  test('publique, sans connexion', async () => {
    const res = await request(app).get('/contact');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="contact-form"');
    for (const option of ['Question', 'Signaler un contenu', 'Données personnelles (RGPD)', 'Autre']) {
      expect(res.text).toContain(`>${option}</option>`);
    }
    expect(res.text).toContain('data-turnstile-action="contact"');
    expect(res.text).not.toMatch(/<script>(?!<\/script>)/);
  });
});
