/*
 * Page « Activité » : GET /api/messages/activity, lecture seule, uniquement
 * des événements tirés des tables existantes et propres au membre.
 * PostgreSQL réel (schéma isolé).
 */
const crypto = require('crypto');
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let alice;
let bob;
let aliceUser;
let bobUser;
const ids = {};

let counter = 0;
function sheet() {
  counter += 1;
  return {
    title: `Activité ${counter}`,
    url: `https://www.annonceur.example/activite/${counter}`,
    campaign_name: `Campagne ${counter}`,
    description: 'Une application pour réviser ses cours, gratuite au téléchargement.',
    category: 'applications',
    countries: 'FR',
    expected_action: 'Installer et ouvrir l’application',
    min_age: null,
    conditions: 'Pas de trafic incité.',
    rights_confirmed: true,
  };
}

async function submit(identity) {
  const res = await request(app).post('/api/community/offers').set(auth(identity)).send(sheet());
  expect(res.status).toBe(201);
  const { id } = res.body.data.offer;
  await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [id]);
  return id;
}

const moderate = (id, decision, note) => request(app).post(`/api/admin/community/offers/${id}/moderate`)
  .set(auth(admin)).send({ decision, note }).expect(200);

const activityOf = async (identity) => {
  const res = await request(app).get('/api/messages/activity').set(auth(identity));
  expect(res.status).toBe(200);
  return res.body.data.items;
};

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'actadmin' }));
  aliceUser = await createUser({ prefix: 'actalice' });
  bobUser = await createUser({ prefix: 'actbob' });
  alice = await login(app, aliceUser);
  bob = await login(app, bobUser);

  ids.published = await submit(alice);
  await moderate(ids.published, 'publish');
  ids.rejected = await submit(alice);
  await moderate(ids.rejected, 'reject', 'Lien vers une page qui n’est pas officielle.');
  ids.removed = await submit(alice);
  await moderate(ids.removed, 'publish');
  await moderate(ids.removed, 'remove', 'Campagne terminée.');
  ids.expired = await submit(alice);
  await moderate(ids.expired, 'publish');
  await pool.query("UPDATE member_offers SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [ids.expired]);
  await request(app).post(`/api/admin/community/offers/${ids.published}/extend`).set(auth(admin)).expect(200);
  ids.pending = await submit(alice);

  await request(app).post('/api/messages/team').set(auth(alice)).send({ content: 'Bonjour' }).expect(201);
  const conversation = (await pool.query('SELECT id FROM conversations WHERE member_id = $1', [aliceUser.id])).rows[0].id;
  await request(app).post(`/api/admin/messages/${conversation}`).set(auth(admin)).send({ content: 'Réponse de l’équipe' }).expect(201);

  const broadcast = await pool.query(
    `INSERT INTO notification_broadcasts (public_id, title, message, target_url)
     VALUES ($1, 'Nouveauté', 'Les stories arrivent.', '/app#home') RETURNING id`,
    [crypto.randomUUID()]
  );
  await pool.query('INSERT INTO notification_recipients (broadcast_id, user_id) VALUES ($1, $2)', [broadcast.rows[0].id, aliceUser.id]);
}, 60000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

describe('GET /api/messages/activity', () => {
  test('événements réels du membre, les plus récents d’abord', async () => {
    const items = await activityOf(alice);
    const types = items.map((item) => item.type);
    expect(types).toEqual(expect.arrayContaining([
      'offer_published', 'offer_rejected', 'offer_removed', 'story_extended', 'story_expired', 'team_message', 'announcement',
    ]));
    // Une fiche en attente n'a encore rien produit.
    expect(items.some((item) => item.offer_id === ids.pending)).toBe(false);
    const dates = items.map((item) => new Date(item.at).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(items.find((item) => item.type === 'offer_rejected')).toMatchObject({ offer_id: ids.rejected, detail: expect.stringMatching(/officielle/) });
    expect(items.find((item) => item.type === 'story_expired').offer_id).toBe(ids.expired);
    expect(items.find((item) => item.type === 'team_message').detail).toBe('Réponse de l’équipe');
    expect(items.find((item) => item.type === 'announcement')).toMatchObject({ title: 'Nouveauté', url: '/app#home' });
  });

  test('cloisonné : un autre membre ne voit rien de tout cela', async () => {
    expect(await activityOf(bob)).toEqual([]);
  });

  test('lecture seule : la réponse de l’équipe reste non lue', async () => {
    await activityOf(alice);
    const unread = await request(app).get('/api/messages/unread').set(auth(alice));
    expect(unread.body.data.unread).toBe(1);
  });

  test('retrait par l’auteur lui-même : pas d’événement « retirée par l’équipe »', async () => {
    const id = await submit(bob);
    await moderate(id, 'publish');
    await request(app).delete(`/api/community/offers/${id}`).set(auth(bob));
    const types = (await activityOf(bob)).map((item) => item.type);
    expect(types).not.toContain('offer_removed');
  });

  test('sans session : refusé', async () => {
    expect((await request(app).get('/api/messages/activity')).status).toBe(401);
  });
});
