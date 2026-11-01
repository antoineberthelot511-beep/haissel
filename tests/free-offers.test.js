/*
 * Bons plans gratuits (migration 0019, kind = 'free') : migration rejouable
 * sans doublon, visibles côté membre sans badge « Lien affilié », ouverture
 * sans sous-identifiant ni clic suivi.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const helpers = require('./helpers/setup');

const { app } = require('../src/app');

const { createUser, login, auth } = helpers;
const SQL = fs.readFileSync(path.join(__dirname, '../database/migrations/20261101_0019_seed_bons_plans_gratuits.sql'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');

let pool;
let adult;
let minor;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  // Base vierge : aucun ADMIN au passage du migrateur, donc rien n'a été inséré.
  expect(Number((await pool.query("SELECT COUNT(*) FROM member_offers WHERE kind = 'free'")).rows[0].count)).toBe(0);
  await createUser({ admin: true, prefix: 'freeadmin' });
  const adultUser = await createUser({ prefix: 'freeadult', adult: true });
  const minorUser = await createUser({ prefix: 'freeminor', adult: false });
  [adult, minor] = await Promise.all([login(app, adultUser), login(app, minorUser)]);
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

describe('migration 0019', () => {
  test('deux passages : 10 offres, aucun doublon', async () => {
    await pool.query(SQL);
    await pool.query(SQL);
    const { rows } = await pool.query(
      "SELECT title, COUNT(*)::int AS n FROM member_offers WHERE kind = 'free' GROUP BY title"
    );
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });

  test('publiées, non incitées, sans champ de monétisation, liens https', async () => {
    const { rows } = await pool.query("SELECT * FROM member_offers WHERE kind = 'free'");
    for (const o of rows) {
      expect(o.status).toBe('published');
      expect(o.incentive_allowed).toBe(false);
      expect(o.subid_param).toBeNull();
      expect(o.payout_note).toBeNull();
      expect(o.url.startsWith('https://')).toBe(true);
      expect(o.description.startsWith('Gratuit · pas un lien affilié')).toBe(true);
    }
  });
});

describe('côté membre', () => {
  const list = async (identity) => (await request(app).get('/api/community/offers?kind=free&limit=50').set(auth(identity)))
    .body.data.items;

  test('les 10 offres s’affichent pour un majeur, kind « free », sans réglage de monétisation', async () => {
    const items = await list(adult);
    expect(items).toHaveLength(10);
    for (const o of items) {
      expect(o.kind).toBe('free');
      expect(o.can_open).toBe(true);
      expect(o).not.toHaveProperty('subid_param');
      expect(o.member_benefit).toBeNull();
    }
  });

  test('un mineur (15 ans certifiés) voit et ouvre les 10 bons plans', async () => {
    const items = await list(minor);
    expect(items).toHaveLength(10);
    expect(items.every((o) => o.can_open)).toBe(true);
  });

  test('le badge d’un bon plan est « Gratuit · pas un lien affilié », jamais « Lien affilié »', () => {
    const badge = APP_JS.slice(APP_JS.indexOf('function kindBadge'), APP_JS.indexOf("if (offer.kind === 'campaign')", APP_JS.indexOf('function kindBadge')));
    expect(badge).toContain('Gratuit · pas un lien affilié');
    expect(badge).not.toContain('Lien affilié\'');
  });

  test('ouverture : URL inchangée, aucun sous-identifiant, aucun clic enregistré', async () => {
    const before = Number((await pool.query('SELECT COUNT(*) FROM offer_clicks')).rows[0].count);
    const { rows } = await pool.query("SELECT id, url FROM member_offers WHERE kind = 'free'");
    for (const who of [adult, minor]) {
      for (const o of rows) {
        const res = await request(app).get(`/api/community/offers/${o.id}/open`).set(auth(who));
        expect(res.status).toBe(200);
        expect(res.body.data.url).toBe(o.url);
      }
    }
    const after = Number((await pool.query('SELECT COUNT(*) FROM offer_clicks')).rows[0].count);
    expect(after).toBe(before);
  });
});
