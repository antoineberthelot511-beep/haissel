/*
 * Espace pédagogique : guides, tutoriels, opportunités, parrainage.
 * PostgreSQL réel (schéma isolé).
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const { FORBIDDEN_CLAIMS } = require('../src/controllers/learn.controller');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let member;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'learnadmin' }));
  member = await login(app, await createUser({ prefix: 'learner' }));
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

const COMPLETE_OPPORTUNITY = {
  name: 'Offre de test',
  advertiser: 'Annonceur',
  network: 'MyLead',
  paid_action: 'Inscription avec e-mail confirmé',
  countries: 'FR, BE',
  min_age: 18,
  restrictions: '- Pas de trafic incité\n- Pas de spam',
  url: 'https://exemple.fr/offre',
  terms_url: 'https://exemple.fr/conditions',
  conditions_checked_at: '2026-10-01',
};

describe('accès', () => {
  test('les routes membres exigent une session', async () => {
    for (const path of ['/api/learn/content', '/api/learn/opportunities', '/api/learn/referral']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  test("un membre n'accède pas à la gestion", async () => {
    expect((await request(app).get('/api/admin/learn/content').set(auth(member))).status).toBe(403);
    const res = await request(app).post('/api/admin/learn/content').set(auth(member))
      .send({ kind: 'guide', slug: 'pirate', title: 'Pirate', body: 'x'.repeat(30), level: 'debutant', position: 1 });
    expect(res.status).toBe(403);
  });

  test('une modification admin sans jeton CSRF est refusée', async () => {
    const res = await request(app).post('/api/admin/learn/content').set('Cookie', admin.cookie)
      .send({ kind: 'guide', slug: 'sans-csrf', title: 'Sans CSRF', body: 'x'.repeat(30) });
    expect(res.status).toBe(403);
  });
});

describe('guides et tutoriels', () => {
  test('les contenus de départ sont des brouillons invisibles des membres', async () => {
    const seeded = await pool.query("SELECT COUNT(*)::int AS n FROM learning_content WHERE status = 'draft' AND verified_at IS NULL");
    expect(seeded.rows[0].n).toBeGreaterThanOrEqual(7);
    const res = await request(app).get('/api/learn/content').set(auth(member));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  test('cycle brouillon -> vérifié -> publié, puis modification = retour en brouillon', async () => {
    const created = await request(app).post('/api/admin/learn/content').set(auth(admin)).send({
      kind: 'tutorial', slug: 'tuto-test', title: 'Tutoriel test', summary: 'Résumé',
      body: '## Étape\n- point un\n- point deux', level: 'debutant', position: 5,
    });
    expect(created.status).toBe(201);
    const { id } = created.body.data.item;
    expect(created.body.data.item.status).toBe('draft');

    const early = await request(app).post(`/api/admin/learn/content/${id}/status`).set(auth(admin)).send({ status: 'published' });
    expect(early.status).toBe(409);

    expect((await request(app).post(`/api/admin/learn/content/${id}/verify`).set(auth(admin))).status).toBe(200);
    const published = await request(app).post(`/api/admin/learn/content/${id}/status`).set(auth(admin)).send({ status: 'published' });
    expect(published.status).toBe(200);

    let list = await request(app).get('/api/learn/content?kind=tutorial').set(auth(member));
    expect(list.body.data.items.map((item) => item.slug)).toEqual(['tuto-test']);

    const edited = await request(app).patch(`/api/admin/learn/content/${id}`).set(auth(admin)).send({ title: 'Tutoriel modifié' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.item.status).toBe('draft');
    expect(edited.body.data.item.verified_at).toBeNull();

    list = await request(app).get('/api/learn/content').set(auth(member));
    expect(list.body.data.items).toEqual([]);

    const actions = await pool.query("SELECT action FROM admin_actions WHERE target_type = 'learning_content' AND target_id = $1 ORDER BY id", [id]);
    expect(actions.rows.map((row) => row.action)).toEqual([
      'learning_content.create', 'learning_content.verify', 'learning_content.status', 'learning_content.update',
    ]);
  });

  test('les promesses de gains garantis sont refusées', async () => {
    const res = await request(app).post('/api/admin/learn/content').set(auth(admin)).send({
      kind: 'guide', slug: 'promesse', title: 'Des revenus garantis chaque mois', body: 'x'.repeat(30), level: 'debutant', position: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISLEADING_CLAIM');
  });

  test('identifiant en double -> 409, type inconnu -> 400', async () => {
    const dup = await request(app).post('/api/admin/learn/content').set(auth(admin))
      .send({ kind: 'guide', slug: 'cpl-explique', title: 'Doublon', body: 'x'.repeat(30) });
    expect(dup.status).toBe(409);
    expect((await request(app).get('/api/learn/content?kind=autre').set(auth(member))).status).toBe(400);
  });
});

describe('opportunités', () => {
  test('vérification impossible tant que les conditions ne sont pas documentées', async () => {
    const created = await request(app).post('/api/admin/learn/opportunities').set(auth(admin)).send({ name: 'Offre incomplète' });
    expect(created.status).toBe(201);
    const { id } = created.body.data.item;
    const verify = await request(app).post(`/api/admin/learn/opportunities/${id}/verify`).set(auth(admin));
    expect(verify.status).toBe(409);
    expect(verify.body.error.message).toMatch(/âge minimum/);
  });

  test('publication, affichage membre, puis désactivation', async () => {
    const created = await request(app).post('/api/admin/learn/opportunities').set(auth(admin)).send(COMPLETE_OPPORTUNITY);
    expect(created.status).toBe(201);
    const { id } = created.body.data.item;
    expect(created.body.data.item.conditions_checked_at).toBe('2026-10-01');

    await request(app).post(`/api/admin/learn/opportunities/${id}/verify`).set(auth(admin)).expect(200);
    await request(app).post(`/api/admin/learn/opportunities/${id}/status`).set(auth(admin)).send({ status: 'published' }).expect(200);

    let list = await request(app).get('/api/learn/opportunities').set(auth(member));
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({ name: 'Offre de test', min_age: 18, is_affiliate: true });

    await request(app).post(`/api/admin/learn/opportunities/${id}/status`).set(auth(admin)).send({ status: 'disabled' }).expect(200);
    list = await request(app).get('/api/learn/opportunities').set(auth(member));
    expect(list.body.data.items).toEqual([]);
  });

  test('URL dangereuse et date future refusées', async () => {
    const badUrl = await request(app).post('/api/admin/learn/opportunities').set(auth(admin))
      .send({ ...COMPLETE_OPPORTUNITY, url: 'javascript:alert(1)' });
    expect(badUrl.status).toBe(400);
    const future = await request(app).post('/api/admin/learn/opportunities').set(auth(admin))
      .send({ ...COMPLETE_OPPORTUNITY, conditions_checked_at: '2099-01-01' });
    expect(future.status).toBe(400);
  });

  test('la base refuse une offre publiée non documentée', async () => {
    await expect(pool.query("INSERT INTO opportunities (name, status, verified_at) VALUES ('X', 'published', NOW())"))
      .rejects.toThrow(/opportunities_published_complete/);
  });
});

describe('parrainage', () => {
  test('masqué tant que la configuration est incomplète', async () => {
    let res = await request(app).get('/api/learn/referral').set(auth(member));
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.url).toBeNull();
    expect(res.body.data.rate_text).toMatch(/5 %/);

    await request(app).put('/api/admin/learn/settings').set(auth(admin))
      .send({ referral_url: 'https://mylead.global/ref/test' }).expect(200);
    res = await request(app).get('/api/learn/referral').set(auth(member));
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.url).toBeNull();
  });

  test('affiché une fois les conditions vérifiées', async () => {
    const saved = await request(app).put('/api/admin/learn/settings').set(auth(admin)).send({
      referral_terms_url: 'https://mylead.global/conditions',
      referral_terms_checked_at: '2026-10-10',
      referral_min_age: 18,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.referral_ready).toBe(true);

    const res = await request(app).get('/api/learn/referral').set(auth(member));
    expect(res.body.data).toMatchObject({
      available: true, url: 'https://mylead.global/ref/test', min_age: 18, terms_checked_at: '2026-10-10',
    });
  });

  test('lien invalide refusé', async () => {
    const res = await request(app).put('/api/admin/learn/settings').set(auth(admin)).send({ referral_url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });
});

describe('détection des promesses de gains', () => {
  test.each([
    'Gains garantis', 'revenu assuré', 'argent facile', 'garanti de gagner 100 €',
  ])('refuse « %s »', (text) => expect(FORBIDDEN_CLAIMS.test(text)).toBe(true));

  test.each([
    "Aucun gain n'est garanti.", 'Les gains ne sont jamais garantis.', 'Rien n’est garanti.',
  ])('accepte « %s »', (text) => expect(FORBIDDEN_CLAIMS.test(text)).toBe(false));
});
