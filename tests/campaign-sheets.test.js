/*
 * Fiches campagne : un membre majeur partage la page officielle d'une
 * campagne, jamais son lien affilié. Seuls les ADMIN publient des liens
 * affiliés. PostgreSQL réel (schéma isolé).
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const { isAffiliateTrackingUrl } = require('../src/utils/affiliate-tracking');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let alice;
let bob;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'ficheadmin' }));
  alice = await login(app, await createUser({ prefix: 'fichealice' }));
  bob = await login(app, await createUser({ prefix: 'fichebob' }));
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

let counter = 0;
function sheet(overrides = {}) {
  counter += 1;
  return {
    title: `Fiche campagne ${counter}`,
    url: `https://www.annonceur.example/produit/${counter}`,
    campaign_name: `Campagne officielle ${counter}`,
    tips: 'Lis bien les conditions de pays avant de commencer.',
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

const TRACKING_MESSAGE = 'Ne partage pas ton lien affilié ici : partage la page officielle. '
  + 'Chacun récupère son propre lien sur MyLead.';

describe('reconnaissance des liens de suivi', () => {
  test.each([
    'https://mylead.global/stl/abc123',
    'https://www.annonceur.example/?ml_sub1=moi',
    'https://www.annonceur.example/landing?aff_id=42',
    'https://track.reseau.example/c/42',
    'https://www.annonceur.example/x?clickid=99',
  ])('%s est un lien de suivi', (url) => expect(isAffiliateTrackingUrl(url)).toBe(true));

  test.each([
    'https://www.annonceur.example/produit',
    'https://mylead.global/fr/start',
    'https://www.annonceur.example/x?utm_source=newsletter',
  ])('%s est une page officielle', (url) => expect(isAffiliateTrackingUrl(url)).toBe(false));
});

describe('fiches campagne des membres', () => {
  test('un membre ne peut pas publier une URL de suivi affilié', async () => {
    for (const url of ['https://mylead.global/stl/abc123', 'https://www.annonceur.example/?ml_sub1=alice']) {
      const res = await request(app).post('/api/community/offers').set(auth(alice)).send(sheet({ url }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AFFILIATE_LINK_FORBIDDEN');
      expect(res.body.error.message).toBe(TRACKING_MESSAGE);
    }
  });

  test('un membre publie une fiche avec une URL officielle', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send(sheet());
    expect(res.status).toBe(201);
    const { offer } = res.body.data;
    expect(offer.kind).toBe('campaign');
    expect(offer.campaign_name).toMatch(/^Campagne officielle/);
    expect(offer.tips).toBe('Lis bien les conditions de pays avant de commencer.');
  });

  test('le nom de la campagne est obligatoire pour un membre', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send(sheet({ campaign_name: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('campaign_name');
  });

  test('un membre ne peut pas glisser un lien de suivi en modifiant sa fiche', async () => {
    const created = await request(app).post('/api/community/offers').set(auth(bob)).send(sheet());
    expect(created.status).toBe(201);
    const res = await request(app).patch(`/api/community/offers/${created.body.data.offer.id}`)
      .set(auth(bob)).send(sheet({ url: 'https://www.annonceur.example/?aff_id=7' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AFFILIATE_LINK_FORBIDDEN');
  });
});

describe('liens affiliés de l équipe', () => {
  test('un ADMIN publie un lien affilié', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(admin))
      .send(sheet({ url: 'https://mylead.global/stl/equipe42', campaign_name: undefined, tips: undefined }));
    expect(res.status).toBe(201);
    expect(res.body.data.offer.kind).toBe('affiliate');
  });
});

describe('signalements', () => {
  test('le motif « Échange d inscriptions » est accepté', async () => {
    const created = await request(app).post('/api/community/offers').set(auth(alice)).send(sheet());
    const { id } = created.body.data.offer;
    await pool.query("UPDATE member_offers SET status = 'published', published_at = NOW() WHERE id = $1", [id]);

    const res = await request(app).post(`/api/community/offers/${id}/report`).set(auth(bob))
      .send({ reason: 'signup_exchange', details: 'Demande de s’inscrire sur son lien en échange.' });
    expect(res.status).toBe(200);
    const stored = await pool.query('SELECT reason FROM member_offer_reports WHERE offer_id = $1', [id]);
    expect(stored.rows[0].reason).toBe('signup_exchange');
  });
});

describe('migration 0010 : reprise des offres existantes', () => {
  /*
   * La reprise ne s'exécute qu'une fois, à l'ajout de la colonne kind. On la
   * rejoue dans le schéma de test isolé : colonne retirée, offres « d'avant »
   * insérées, puis fichier de migration réappliqué.
   */
  test('offres ADMIN en affiliate, liens de suivi des membres repassés en pending', async () => {
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/20261024_0010_campaign_sheets.sql'), 'utf8');

    const ids = async (username) => (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
    const me = async (identity) => (await request(app).get('/api/auth/me').set(auth(identity))).body.data.user.username;
    const adminId = await ids(await me(admin));
    const aliceId = await ids(await me(alice));

    await pool.query('ALTER TABLE member_offers DROP COLUMN kind CASCADE');
    const insert = (userId, url, status) => pool.query(
      `INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action,
                                  rights_confirmed_at, status, published_at)
       VALUES ($1, 'Offre historique', $2, 'Une description assez longue pour passer.', 'applications', 'FR',
               'Installer l’application', NOW(), $3::text, CASE WHEN $3::text = 'published' THEN NOW() END)
       RETURNING id`,
      [userId, url, status]
    ).then((r) => r.rows[0].id);

    const adminOffer = await insert(adminId, 'https://mylead.global/stl/historique', 'published');
    const memberTracking = await insert(aliceId, 'https://www.annonceur.example/?ml_sub1=alice', 'published');
    const memberOfficial = await insert(aliceId, 'https://www.annonceur.example/officiel', 'published');

    await pool.query(sql);

    const rows = (await pool.query(
      'SELECT id, kind, status, moderation_note FROM member_offers WHERE id = ANY($1)',
      [[adminOffer, memberTracking, memberOfficial]]
    )).rows;
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[adminOffer]).toMatchObject({ kind: 'affiliate', status: 'published' });
    expect(byId[memberTracking]).toMatchObject({ kind: 'campaign', status: 'pending', moderation_note: 'À convertir en fiche campagne' });
    expect(byId[memberOfficial]).toMatchObject({ kind: 'campaign', status: 'published' });

    // Réexécutable : un second passage ne change rien.
    await pool.query("UPDATE member_offers SET status = 'published' WHERE id = $1", [memberTracking]);
    await pool.query(sql);
    expect((await pool.query('SELECT status FROM member_offers WHERE id = $1', [memberTracking])).rows[0].status).toBe('published');

    // Guide : nouvelle version en brouillon, l'ancienne inchangée.
    const guides = (await pool.query(
      "SELECT slug, status FROM learning_content WHERE slug LIKE 'respecter-les-regles%' ORDER BY slug"
    )).rows;
    expect(guides.find((g) => g.slug === 'respecter-les-regles-v2').status).toBe('draft');
  });
});
