/*
 * Publication réservée à l'équipe (MEMBER_PUBLISHING_ENABLED=false, défaut) :
 *  - un membre majeur reçoit 403 PUBLISHING_RESTRICTED en création et en
 *    modification ;
 *  - un ADMIN publie toujours ;
 *  - le retrait de ses propres offres reste permis à tous.
 *
 * La variable est lue à chaque requête : on la bascule entre les tests.
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const { createUser, login, auth } = helpers;

let admin;
let alice;

beforeAll(async () => {
  await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'pubadmin' }));
  alice = await login(app, await createUser({ prefix: 'pubalice' }));
}, 30000);

beforeEach(() => {
  process.env.MEMBER_PUBLISHING_ENABLED = 'false';
});

afterAll(async () => {
  await helpers.teardownDatabase();
});

let counter = 0;
function offer(overrides = {}) {
  counter += 1;
  return {
    title: `Offre réservée ${counter}`,
    url: `https://exemple.fr/reserve/${counter}?sub=haissel`,
    description: 'Une application pour réviser ses cours, gratuite au téléchargement.',
    category: 'applications',
    countries: 'FR, BE',
    expected_action: 'Installer et ouvrir l’application',
    payout_text: null,
    min_age: null,
    conditions: 'Pas de trafic incité.',
    rights_confirmed: true,
    ...overrides,
  };
}

function expectRestricted(res) {
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('PUBLISHING_RESTRICTED');
  expect(res.body.error.message).toBe("La publication est réservée à l'équipe pour le moment.");
}

describe('publication réservée à l équipe', () => {
  test('/api/auth/config expose publishing_open', async () => {
    const closed = await request(app).get('/api/auth/config');
    expect(closed.body.data.publishing_open).toBe(false);
    process.env.MEMBER_PUBLISHING_ENABLED = 'true';
    const open = await request(app).get('/api/auth/config');
    expect(open.body.data.publishing_open).toBe(true);
  });

  test('un membre majeur ne peut ni publier ni modifier', async () => {
    expectRestricted(await request(app).post('/api/community/offers').set(auth(alice)).send(offer()));

    process.env.MEMBER_PUBLISHING_ENABLED = 'true';
    const created = await request(app).post('/api/community/offers').set(auth(alice)).send(offer());
    expect(created.status).toBe(201);
    const { id } = created.body.data.offer;

    process.env.MEMBER_PUBLISHING_ENABLED = 'false';
    expectRestricted(await request(app).patch(`/api/community/offers/${id}`).set(auth(alice)).send(offer()));

    // Le retrait reste permis.
    await request(app).delete(`/api/community/offers/${id}`).set(auth(alice)).expect(200);
  });

  test('un membre majeur publie quand la variable vaut true', async () => {
    process.env.MEMBER_PUBLISHING_ENABLED = 'true';
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send(offer());
    expect(res.status).toBe(201);
  });

  test('un ADMIN publie, modifie et retire toujours', async () => {
    const created = await request(app).post('/api/community/offers').set(auth(admin)).send(offer());
    expect(created.status).toBe(201);
    const { id } = created.body.data.offer;
    const edited = await request(app).patch(`/api/community/offers/${id}`).set(auth(admin)).send(offer({ title: 'Titre corrigé admin' }));
    expect(edited.status).toBe(200);
    await request(app).delete(`/api/community/offers/${id}`).set(auth(admin)).expect(200);
  });
});
