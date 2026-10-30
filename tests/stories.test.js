/*
 * Fiches campagne au format « story » : visibles 24 h à partir de leur
 * validation, republiables par l'auteur. L'horloge est simulée en base :
 * on recule published_at / expires_at / renewed_at.
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let alice;
let bob;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'storyadmin' }));
  alice = await login(app, await createUser({ prefix: 'storyalice' }));
  bob = await login(app, await createUser({ prefix: 'storybob' }));
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

let counter = 0;
function sheet(overrides = {}) {
  counter += 1;
  return {
    title: `Story ${counter}`,
    url: `https://www.annonceur.example/story/${counter}`,
    campaign_name: `Campagne story ${counter}`,
    description: 'Une application pour réviser ses cours, gratuite au téléchargement.',
    category: 'applications',
    countries: 'FR',
    expected_action: 'Installer et ouvrir l’application',
    min_age: null,
    conditions: 'Pas de trafic incité.',
    rights_confirmed: true,
    ...overrides,
  };
}

async function publish(identity, data = sheet()) {
  const res = await request(app).post('/api/community/offers').set(auth(identity)).send(data);
  expect(res.status).toBe(201);
  const { id } = res.body.data.offer;
  await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [id]);
  await request(app).post(`/api/admin/community/offers/${id}/moderate`).set(auth(admin)).send({ decision: 'publish' }).expect(200);
  return id;
}

/** Fait comme si la publication avait eu lieu il y a `hours` heures. */
async function age(id, hours) {
  await pool.query(
    `UPDATE member_offers
     SET published_at = published_at - make_interval(hours => $2),
         renewed_at = renewed_at - make_interval(hours => $2),
         expires_at = expires_at - make_interval(hours => $2)
     WHERE id = $1`,
    [id, hours]
  );
}

const feedIds = async (identity, query = '') => (await request(app)
  .get(`/api/community/offers${query}`).set(auth(identity))).body.data.items.map((o) => o.id);

describe('visibilité 24 h', () => {
  test('expires_at est fixé à la validation, pas à l envoi', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send(sheet());
    const { id } = res.body.data.offer;
    expect((await pool.query('SELECT expires_at FROM member_offers WHERE id = $1', [id])).rows[0].expires_at).toBeNull();
    await request(app).post(`/api/admin/community/offers/${id}/moderate`).set(auth(admin)).send({ decision: 'publish' }).expect(200);
    const row = (await pool.query(
      "SELECT EXTRACT(EPOCH FROM expires_at - published_at) AS s FROM member_offers WHERE id = $1", [id]
    )).rows[0];
    expect(Number(row.s)).toBe(24 * 3600);
  });

  test('visible avant 24 h, invisible après (fil et recherche)', async () => {
    const id = await publish(alice, sheet({ title: 'Story chercheuse' }));
    await age(id, 23);
    expect(await feedIds(bob)).toContain(id);
    await age(id, 2);
    expect(await feedIds(bob)).not.toContain(id);
    expect(await feedIds(bob, '?q=chercheuse')).not.toContain(id);
    // Toujours en base.
    expect((await pool.query('SELECT status FROM member_offers WHERE id = $1', [id])).rows[0].status).toBe('published');
  });

  test('un autre membre reçoit 404 sur une fiche expirée, pas l auteur', async () => {
    const id = await publish(alice);
    await age(id, 25);
    expect((await request(app).get(`/api/community/offers/${id}/open`).set(auth(bob))).status).toBe(404);
    expect((await request(app).get(`/api/community/offers/${id}/open`).set(auth(alice))).status).toBe(200);
  });

  test('une fiche sauvegardée expirée reste dans « Sauvegardées », marquée expirée', async () => {
    const id = await publish(alice);
    await request(app).post(`/api/community/offers/${id}/save`).set(auth(bob)).expect(200);
    await age(id, 25);
    const res = await request(app).get('/api/community/offers?saved=1').set(auth(bob));
    const item = res.body.data.items.find((o) => o.id === id);
    expect(item.expired).toBe(true);
    expect(item.url).toBeNull();
  });

  test('une offre ADMIN n expire jamais', async () => {
    const id = await publish(admin, sheet({ url: 'https://mylead.global/stl/equipe-story', min_age: 18 }));
    expect((await pool.query('SELECT expires_at FROM member_offers WHERE id = $1', [id])).rows[0].expires_at).toBeNull();
    await pool.query("UPDATE member_offers SET published_at = NOW() - INTERVAL '30 days' WHERE id = $1", [id]);
    expect(await feedIds(bob)).toContain(id);
  });
});

describe('republication', () => {
  test('refusée avant 20 h, possible après expiration, sans modération', async () => {
    const id = await publish(alice);
    const early = await request(app).post(`/api/community/offers/${id}/renew`).set(auth(alice));
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('RENEW_TOO_SOON');

    await age(id, 25);
    const res = await request(app).post(`/api/community/offers/${id}/renew`).set(auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.data.offer.status).toBe('published');
    expect(res.body.data.offer.expired).toBe(false);
    expect(await feedIds(bob)).toContain(id);

    // Republiée à l'instant : une nouvelle demande attend 20 h.
    expect((await request(app).post(`/api/community/offers/${id}/renew`).set(auth(alice))).status).toBe(403);
  });

  test('la fiche republiée remonte en tête du fil', async () => {
    const old = await publish(alice);
    await publish(alice);
    await age(old, 25);
    await request(app).post(`/api/community/offers/${old}/renew`).set(auth(alice)).expect(200);
    expect((await feedIds(bob))[0]).toBe(old);
  });

  test('modifier le contenu repasse en modération', async () => {
    const id = await publish(alice);
    await age(id, 25);
    const res = await request(app).patch(`/api/community/offers/${id}`).set(auth(alice))
      .send(sheet({ title: 'Story corrigée' }));
    expect(res.status).toBe(200);
    expect(res.body.data.offer.status).toBe('pending');
    expect((await request(app).post(`/api/community/offers/${id}/renew`).set(auth(alice))).status).toBe(409);
  });

  test('un autre membre ne peut pas republier la fiche', async () => {
    const id = await publish(alice);
    await age(id, 25);
    expect((await request(app).post(`/api/community/offers/${id}/renew`).set(auth(bob))).status).toBe(404);
  });
});

describe('console ADMIN', () => {
  test('prolonger une fiche expirée la rend visible et est journalisé', async () => {
    const id = await publish(alice);
    await age(id, 25);
    await request(app).post(`/api/admin/community/offers/${id}/extend`).set(auth(admin)).expect(200);
    expect(await feedIds(bob)).toContain(id);
    const logged = await pool.query(
      "SELECT 1 FROM admin_actions WHERE action = 'member_offer.extend' AND target_id = $1", [id]
    );
    expect(logged.rows).toHaveLength(1);
  });

  test('un membre ne peut pas prolonger', async () => {
    const id = await publish(alice);
    expect((await request(app).post(`/api/admin/community/offers/${id}/extend`).set(auth(alice))).status).toBe(403);
  });
});
