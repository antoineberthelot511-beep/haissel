/*
 * Catégories des offres (table offer_categories) et file de modération.
 *
 * Les catégories étaient une constante JavaScript : elles sont maintenant en
 * base et administrables. La migration reprend les valeurs existantes, y
 * compris celles qui seraient déjà présentes dans member_offers.
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const { FALLBACK_CATEGORIES, invalidateCategories } = require('../src/controllers/community.controller');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let member;
let memberIdentity;

const offerBody = (overrides = {}) => ({
  title: `Offre catégorie ${Math.random().toString(16).slice(2, 6)}`,
  url: `https://partenaire.exemple.fr/c/${Math.random().toString(16).slice(2, 8)}`,
  description: 'Une description assez longue pour passer la validation de longueur.',
  category: 'applications',
  countries: 'FR',
  expected_action: 'Créer un compte',
  campaign_name: 'Campagne de test',
  rights_confirmed: true,
  ...overrides,
});

/** Publie une offre et la fait valider par la modération. */
async function publish(identity, body = offerBody()) {
  const res = await request(app).post('/api/community/offers').set(auth(identity)).send(body);
  expect(res.status).toBe(201);
  const { id } = res.body.data.offer;
  await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [id]);
  await request(app).post(`/api/admin/community/offers/${id}/moderate`)
    .set(auth(admin)).send({ decision: 'publish' }).expect(200);
  return id;
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'catadmin' }));
  member = await createUser({ prefix: 'catmembre', adult: true });
  memberIdentity = await login(app, member);
}, 30000);

afterEach(() => invalidateCategories());

afterAll(async () => {
  await helpers.teardownDatabase();
});

// ===========================================================================
describe('Migration : les valeurs existantes sont reprises', () => {
  test('les sept catégories de l’ancienne constante sont en base', async () => {
    const { rows } = await pool.query('SELECT slug, label FROM offer_categories ORDER BY position');
    const slugs = rows.map((r) => r.slug);
    for (const slug of Object.keys(FALLBACK_CATEGORIES)) {
      expect(slugs).toContain(slug);
    }
    // Les libellés aussi, pas seulement les identifiants.
    const byslug = Object.fromEntries(rows.map((r) => [r.slug, r.label]));
    expect(byslug.applications).toBe('Applications');
    expect(byslug.education).toBe('Éducation');
  });

  test('aucune offre existante ne se retrouve sans catégorie connue', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT o.category FROM member_offers o
       WHERE o.category IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM offer_categories c WHERE c.slug = o.category)`
    );
    expect(rows).toEqual([]);
  });

  test('la table est la source de vérité des formulaires', async () => {
    const res = await request(app).get('/api/community/offers').set(auth(memberIdentity));
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT slug FROM offer_categories WHERE is_active ORDER BY slug');
    expect(Object.keys(res.body.data.categories).sort()).toEqual(rows.map((r) => r.slug).sort());
  });
});

// ===========================================================================
describe('Administration des catégories', () => {
  test('un membre n’y accède pas', async () => {
    const res = await request(app).get('/api/admin/community/categories').set(auth(memberIdentity));
    expect(res.status).toBe(403);
  });

  test('création, puis apparition dans les formulaires', async () => {
    const created = await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'voyage', label: 'Voyages', position: 55 });
    expect(created.status).toBe(201);
    expect(created.body.data.category).toMatchObject({ slug: 'voyage', label: 'Voyages', offers: 0 });

    invalidateCategories();
    const list = await request(app).get('/api/community/offers').set(auth(memberIdentity));
    expect(list.body.data.categories.voyage).toBe('Voyages');
  });

  test('un identifiant en double est refusé', async () => {
    const res = await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'applications', label: 'Doublon' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_EXISTS');
  });

  test('un identifiant mal formé est refusé, avec le champ fautif', async () => {
    for (const slug of ['A', 'avec espace', 'é', '', 'trop+de#signes']) {
      const res = await request(app).post('/api/admin/community/categories')
        .set(auth(admin)).send({ slug, label: 'Test' });
      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe('slug');
    }
  });

  test('un identifiant en majuscules est normalisé, pas refusé', async () => {
    const res = await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'MAJUSCULES', label: 'Normalisé' });
    expect(res.status).toBe(201);
    expect(res.body.data.category.slug).toBe('majuscules');
  });

  test('un nom vide ou un ordre invalide sont refusés', async () => {
    const sansNom = await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'test-nom', label: ' ' });
    expect(sansNom.status).toBe(400);
    expect(sansNom.body.error.field).toBe('label');

    const ordre = await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'test-ordre', label: 'Test', position: 5000 });
    expect(ordre.status).toBe(400);
    expect(ordre.body.error.field).toBe('position');
  });

  test('l’identifiant n’est jamais modifiable', async () => {
    await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'immuable', label: 'Avant' }).expect(201);

    // Même en envoyant un slug dans le corps, seul le libellé change.
    const res = await request(app).patch('/api/admin/community/categories/immuable')
      .set(auth(admin)).send({ slug: 'autre-chose', label: 'Après' });
    expect(res.status).toBe(200);
    expect(res.body.data.category.slug).toBe('immuable');
    expect(res.body.data.category.label).toBe('Après');

    const autre = await pool.query('SELECT COUNT(*)::int AS n FROM offer_categories WHERE slug = $1', ['autre-chose']);
    expect(autre.rows[0].n).toBe(0);
  });

  test('une catégorie inexistante renvoie 404', async () => {
    const res = await request(app).patch('/api/admin/community/categories/inexistante')
      .set(auth(admin)).send({ label: 'Test' });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
describe('Désactiver plutôt que supprimer', () => {
  test('une catégorie désactivée disparaît des formulaires mais garde son libellé', async () => {
    await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'temporaire', label: 'Temporaire' }).expect(201);
    invalidateCategories();

    const id = await publish(memberIdentity, offerBody({ category: 'temporaire' }));

    await request(app).patch('/api/admin/community/categories/temporaire')
      .set(auth(admin)).send({ label: 'Temporaire', position: 100, is_active: false }).expect(200);
    invalidateCategories();

    const list = await request(app).get('/api/community/offers').set(auth(memberIdentity));
    // Plus proposée...
    expect(list.body.data.categories.temporaire).toBeUndefined();
    // ...mais l'offre existante affiche toujours son libellé.
    const offer = list.body.data.items.find((item) => item.id === id);
    expect(offer.category_label).toBe('Temporaire');
  });

  test('publier dans une catégorie désactivée est refusé', async () => {
    const res = await request(app).post('/api/community/offers')
      .set(auth(memberIdentity)).send(offerBody({ category: 'temporaire' }));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('category');
  });

  test('une catégorie utilisée ne peut pas être supprimée', async () => {
    const res = await request(app).delete('/api/admin/community/categories/temporaire').set(auth(admin));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_IN_USE');

    const still = await pool.query('SELECT COUNT(*)::int AS n FROM offer_categories WHERE slug = $1', ['temporaire']);
    expect(still.rows[0].n).toBe(1);
  });

  test('une catégorie inutilisée se supprime', async () => {
    await request(app).post('/api/admin/community/categories')
      .set(auth(admin)).send({ slug: 'jamais-servi', label: 'Jamais servi' }).expect(201);
    await request(app).delete('/api/admin/community/categories/jamais-servi').set(auth(admin)).expect(200);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM offer_categories WHERE slug = $1', ['jamais-servi']);
    expect(rows[0].n).toBe(0);
  });

  test('un filtre de recherche sur une catégorie désactivée fonctionne encore', async () => {
    // Un lien de recherche déjà partagé ne doit pas se mettre à ne plus rien renvoyer.
    const res = await request(app).get('/api/community/offers?category=temporaire').set(auth(memberIdentity));
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe('File de modération : les signalements d’abord', () => {
  test('les offres signalées remontent en tête, les plus signalées avant', async () => {
    const calme = await publish(memberIdentity);
    const signaleeUneFois = await publish(memberIdentity);
    const signaleeDeuxFois = await publish(memberIdentity);

    // Les signalements viennent d'autres membres : on ne signale pas sa propre offre.
    const lecteurs = [];
    for (let i = 0; i < 3; i += 1) {
      const u = await createUser({ prefix: `signaleur${i}`, adult: true });
      lecteurs.push(await login(app, u));
    }
    await request(app).post(`/api/community/offers/${signaleeUneFois}/report`)
      .set(auth(lecteurs[0])).send({ reason: 'spam', details: 'Envoyée en masse.' }).expect(200);
    await request(app).post(`/api/community/offers/${signaleeDeuxFois}/report`)
      .set(auth(lecteurs[0])).send({ reason: 'misleading', details: 'Promet des gains.' }).expect(200);
    await request(app).post(`/api/community/offers/${signaleeDeuxFois}/report`)
      .set(auth(lecteurs[1])).send({ reason: 'dangerous' }).expect(200);

    // Les trois offres sont publiées : 1 et 2 signalements ne suffisent pas à
    // masquer (le seuil est de 3), elles restent donc dans la même liste.
    const res = await request(app).get('/api/admin/community/offers?status=published').set(auth(admin));
    expect(res.status).toBe(200);
    const ordre = res.body.data.items.map((item) => item.id);

    const posDeux = ordre.indexOf(signaleeDeuxFois);
    const posUne = ordre.indexOf(signaleeUneFois);
    const posCalme = ordre.indexOf(calme);

    expect(posDeux).toBeLessThan(posUne);
    expect(posUne).toBeLessThan(posCalme);
  }, 30000);

  test('le motif du signalement est transmis à la modération', async () => {
    const res = await request(app).get('/api/admin/community/offers?status=reported').set(auth(admin));
    expect(res.status).toBe(200);
    const signalee = res.body.data.items.find((item) => item.open_reports > 0);
    expect(signalee).toBeDefined();
    expect(Array.isArray(signalee.reports)).toBe(true);

    const motifs = signalee.reports.map((r) => r.reason);
    expect(motifs.length).toBe(signalee.open_reports);
    // Motif et commentaire libre, tels que saisis par le membre.
    expect(signalee.reports.some((r) => typeof r.reason === 'string' && r.reason.length > 0)).toBe(true);
  });
});
