/*
 * Feuille « Filtres » de Recherche (type, tri) et aperçu de la liste des
 * messages. PostgreSQL réel (schéma isolé).
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let alice;
let bob;
let bobUser;
const ids = {};

let counter = 0;
function sheet(overrides = {}) {
  counter += 1;
  return {
    title: `Filtre ${counter}`,
    url: `https://www.annonceur.example/filtre/${counter}`,
    campaign_name: `Campagne filtre ${counter}`,
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

async function publish(identity) {
  const res = await request(app).post('/api/community/offers').set(auth(identity)).send(sheet());
  expect(res.status).toBe(201);
  const { id } = res.body.data.offer;
  await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [id]);
  await request(app).post(`/api/admin/community/offers/${id}/moderate`).set(auth(admin)).send({ decision: 'publish' }).expect(200);
  return id;
}

const listIds = async (query) => (await request(app)
  .get(`/api/community/offers${query}`).set(auth(alice))).body.data.items.map((o) => o.id);

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'filtadmin' }));
  alice = await login(app, await createUser({ prefix: 'filtalice' }));
  bobUser = await createUser({ prefix: 'filtbob' });
  bob = await login(app, bobUser);
  ids.older = await publish(alice);
  ids.newer = await publish(bob);
  ids.team = await publish(bob);
  // Une offre de l'équipe (lien affilié) : la sorte est fixée en base pour le test.
  await pool.query("UPDATE member_offers SET kind = 'affiliate', expires_at = NULL WHERE id = $1", [ids.team]);
  await pool.query("UPDATE member_offers SET published_at = published_at - INTERVAL '2 hours' WHERE id = $1", [ids.older]);
  // La plus ancienne est la plus sauvegardée.
  await request(app).post(`/api/community/offers/${ids.older}/save`).set(auth(alice)).expect((res) => expect(res.status).toBeLessThan(300));
  await request(app).post(`/api/community/offers/${ids.older}/save`).set(auth(bob)).expect((res) => expect(res.status).toBeLessThan(300));
}, 60000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

describe('Recherche : type et tri', () => {
  test('type « fiche campagne » ou « lien de l’équipe »', async () => {
    const campaigns = await listIds('?kind=campaign');
    expect(campaigns).toEqual(expect.arrayContaining([ids.older, ids.newer]));
    expect(campaigns).not.toContain(ids.team);
    expect(await listIds('?kind=affiliate')).toEqual([ids.team]);
  });

  test('valeur inconnue ignorée', async () => {
    const all = await listIds('');
    expect(await listIds('?kind=autre&sort=n_importe')).toEqual(all);
  });

  test('par défaut les plus récentes, « populaires » d’abord les plus sauvegardées', async () => {
    const recent = await listIds('?kind=campaign');
    expect(recent.indexOf(ids.newer)).toBeLessThan(recent.indexOf(ids.older));
    const popular = await listIds('?kind=campaign&sort=popular');
    expect(popular[0]).toBe(ids.older);
  });
});

describe('Messages : aperçu dans la liste', () => {
  test('dernier message renvoyé sans marquer les réponses comme lues', async () => {
    const empty = await request(app).get('/api/messages/unread').set(auth(bob));
    expect(empty.body.data).toEqual({ unread: 0, last: null });

    await request(app).post('/api/messages/team').set(auth(bob)).send({ content: 'Bonjour l’équipe' }).expect(201);
    const conversation = (await pool.query('SELECT id FROM conversations WHERE member_id = $1', [bobUser.id])).rows[0].id;
    await request(app).post(`/api/admin/messages/${conversation}`).set(auth(admin)).send({ content: 'Réponse de l’équipe' }).expect(201);

    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).get('/api/messages/unread').set(auth(bob));
      expect(res.body.data.unread).toBe(1);
      expect(res.body.data.last).toMatchObject({ content: 'Réponse de l’équipe', from_team: true });
      expect(res.body.data.last.created_at).toBeTruthy();
    }
  });
});
