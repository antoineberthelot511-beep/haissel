/*
 * Monétisation des liens de l'équipe (règles MyLead) : filtrage par âge,
 * sous-identifiant opaque, clic suivi (1 par 24 h, jamais pour un ADMIN),
 * webhook « mylead » seul accepté, conversions et « à vérifier », tableau
 * Revenus, aucun montant côté membre.
 */
const request = require('supertest');
const helpers = require('./helpers/setup');

const { app } = require('../src/app');
const tracking = require('../src/services/offer-tracking.service');

const { createUser, login, auth, signWebhook } = helpers;
let pool;
let admin;
let adult;
let minor;
let adultUser;
const offers = {};

/** Offre de l'équipe publiée (champs de monétisation compris). */
async function teamOffer(adminId, minAge, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action,
                                rights_confirmed_at, status, published_at, kind, min_age,
                                incentive_allowed, member_benefit, payout_note, campaign_rules_url, subid_param)
     VALUES ($1, $2, 'https://partner.example/offre?x=1', 'Une description assez longue pour passer.', 'applications', 'FR',
             'Installer l’application', NOW(), 'published', NOW(), 'affiliate', $3, true, $4, '2,50 € par inscription',
             'https://partner.example/regles', 'ml_sub1')
     RETURNING id`,
    [adminId, `Offre équipe ${minAge}+`, minAge, extra.benefit === undefined ? '5 € offerts à l’inscription par l’appli' : extra.benefit]
  );
  return rows[0].id;
}

function webhook(provider, payload, options) {
  const body = JSON.stringify(payload);
  return request(app).post(`/api/webhooks/affiliate/${provider}`).set(signWebhook(body, options)).send(body);
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  const adminUser = await createUser({ admin: true, prefix: 'monadmin' });
  adultUser = await createUser({ prefix: 'monadult', adult: true });
  const minorUser = await createUser({ prefix: 'monminor', adult: false });
  [admin, adult, minor] = await Promise.all([login(app, adminUser), login(app, adultUser), login(app, minorUser)]);
  for (const age of [13, 15, 16, 18]) offers[age] = await teamOffer(adminUser.id, age);
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

describe('filtrage par âge', () => {
  const visible = async (identity) => (await request(app).get('/api/community/offers?kind=affiliate').set(auth(identity)))
    .body.data.items.map((o) => o.id);

  test('majeur : toutes les offres de l’équipe', async () => {
    expect(await visible(adult)).toEqual(expect.arrayContaining([offers[13], offers[15], offers[16], offers[18]]));
  });

  test('mineur : 13+ et 15+ seulement (16+ non certifiable, 18+ réservées aux majeurs)', async () => {
    const ids = await visible(minor);
    expect(ids).toEqual(expect.arrayContaining([offers[13], offers[15]]));
    expect(ids).not.toContain(offers[16]);
    expect(ids).not.toContain(offers[18]);
    expect((await request(app).get(`/api/community/offers/${offers[18]}/open`).set(auth(minor))).status).toBe(403);
    expect((await request(app).get(`/api/community/offers/${offers[16]}/open`).set(auth(minor))).status).toBe(403);
  });

  test('une offre de l’équipe exige un âge minimum de 13, 15, 16 ou 18 ans', async () => {
    const base = {
      title: 'Nouvelle offre équipe', url: 'https://partner.example/n', description: 'Une description assez longue pour passer.',
      category: 'applications', countries: 'FR', expected_action: 'Installer l’application', rights_confirmed: true,
    };
    const bad = await request(app).post('/api/community/offers').set(auth(admin)).send({ ...base, min_age: 17 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.field).toBe('min_age');
    const ok = await request(app).post('/api/community/offers').set(auth(admin))
      .send({ ...base, url: 'https://partner.example/n2', min_age: 16, incentive_allowed: true, subid_param: 'ml_sub1', member_benefit: '5 € offerts', payout_note: '3 €' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.offer).toMatchObject({ min_age: 16, incentive_allowed: true, subid_param: 'ml_sub1', payout_note: '3 €' });
    expect((await request(app).post('/api/community/offers').set(auth(admin)).send({ ...base, url: 'https://partner.example/n3', min_age: 18, subid_param: 'a b' })).status).toBe(400);
  });
});

describe('ouverture et suivi des clics', () => {
  test('sous-identifiant opaque dans le paramètre choisi : ni identifiant ni e-mail du membre', async () => {
    const res = await request(app).get(`/api/community/offers/${offers[13]}/open`).set(auth(adult));
    expect(res.status).toBe(200);
    const url = new URL(res.body.data.url);
    const subid = url.searchParams.get('ml_sub1');
    expect(subid).toMatch(/^[0-9a-f]{32}$/);
    expect(url.searchParams.get('x')).toBe('1');
    expect(subid).toBe(tracking.trackingId(adultUser.id, offers[13]));
    expect(res.body.data.url).not.toContain(adultUser.email);
    expect(res.body.data.url).not.toMatch(new RegExp(`[=&]${adultUser.id}(&|$)`));
    const clicks = await pool.query('SELECT * FROM offer_clicks WHERE offer_id = $1', [offers[13]]);
    expect(clicks.rows).toHaveLength(1);
    expect(clicks.rows[0].subid).toBe(subid);
    expect(clicks.rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(clicks.rows[0]).sort()).toEqual(['created_at', 'id', 'ip_hash', 'offer_id', 'subid']);
  });

  test('1 clic suivi par membre, par offre et par 24 h', async () => {
    await request(app).get(`/api/community/offers/${offers[15]}/open`).set(auth(adult));
    await request(app).get(`/api/community/offers/${offers[15]}/open`).set(auth(adult));
    await request(app).get(`/api/community/offers/${offers[15]}/open`).set(auth(adult));
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM offer_clicks WHERE offer_id = $1', [offers[15]])).rows[0].n).toBe(1);
    // 24 h plus tard : un nouveau clic compte.
    await pool.query("UPDATE offer_clicks SET created_at = NOW() - INTERVAL '25 hours' WHERE offer_id = $1", [offers[15]]);
    await request(app).get(`/api/community/offers/${offers[15]}/open`).set(auth(adult));
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM offer_clicks WHERE offer_id = $1', [offers[15]])).rows[0].n).toBe(2);
  });

  test('un ADMIN qui teste un lien n’est jamais suivi', async () => {
    const res = await request(app).get(`/api/community/offers/${offers[16]}/open`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe('https://partner.example/offre?x=1');
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM offer_clicks WHERE offer_id = $1', [offers[16]])).rows[0].n).toBe(0);
  });
});

describe('conversions (webhook)', () => {
  const subidOf = (offerId) => tracking.trackingId(adultUser.id, offerId);

  test('seul le fournisseur « mylead » est accepté', async () => {
    const payload = { external_reference: 'X-0', subid: subidOf(offers[13]), status: 'pending', amount_cents: 250 };
    expect((await webhook('autre', payload)).status).toBe(404);
    expect((await webhook('mylead', payload, { secret: 'mauvais-secret-mauvais-secret-mauvais-secret' })).status).toBe(401);
  });

  test('conversion reliée au clic par le sous-identifiant ; statut mis à jour ; inconnue refusée', async () => {
    const created = await webhook('mylead', { external_reference: 'ML-1', subid: subidOf(offers[13]), status: 'pending', amount_cents: 250 });
    expect(created.status).toBe(201);
    const row = (await pool.query('SELECT * FROM offer_conversions WHERE external_reference = $1', ['ML-1'])).rows[0];
    expect(row).toMatchObject({ offer_id: offers[13], status: 'pending', amount_cents: 250 });
    expect(row.click_id).toBeTruthy();
    const updated = await webhook('mylead', { external_reference: 'ML-1', subid: subidOf(offers[13]), status: 'approved', amount_cents: 250 });
    expect(updated.status).toBe(200);
    expect((await pool.query('SELECT status FROM offer_conversions WHERE external_reference = $1', ['ML-1'])).rows[0].status).toBe('approved');
    expect((await webhook('mylead', { external_reference: 'ML-2', subid: 'f'.repeat(32), status: 'pending' })).status).toBe(422);
    expect((await webhook('mylead', { external_reference: 'ML-3', subid: subidOf(offers[13]), status: 'paye' })).status).toBe(400);
  });

  test('plusieurs conversions de la même offre, même membre : « à vérifier »', async () => {
    const second = await webhook('mylead', { external_reference: 'ML-4', subid: subidOf(offers[13]), status: 'pending', amount_cents: 250 });
    expect(second.body.data.needs_review).toBe(true);
    const { rows } = await pool.query('SELECT needs_review FROM offer_conversions WHERE offer_id = $1', [offers[13]]);
    expect(rows.every((r) => r.needs_review)).toBe(true);
  });

  test('rien n’est versé aux membres : aucune table de gains alimentée', async () => {
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM earnings')).rows[0].n).toBe(0);
  });
});

describe('Revenus (admin) et côté membre', () => {
  test('tableau par offre et par mois, export CSV', async () => {
    const res = await request(app).get('/api/admin/revenue').set(auth(admin));
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((r) => r.offer_id === offers[13]);
    expect(row).toMatchObject({ clicks: 1, approved: 1, pending: 1, rejected: 0, conversions: 2, to_review: 2, estimated_cents: 500 });
    expect(row.month).toMatch(/^\d{4}-\d{2}$/);
    expect(row.conversion_rate).toBe(200);
    const csv = await request(app).get('/api/admin/revenue?format=csv').set(auth(admin));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Mois;Offre (id);Offre;Clics;En attente;Validées;Refusées;À vérifier;Taux de conversion (%);Gains estimés (EUR)');
    expect(csv.text).toContain('5.00');
    expect((await request(app).get('/api/admin/revenue').set(auth(adult))).status).toBe(403);
    expect((await request(app).get('/api/admin/revenue?month=2026-13').set(auth(admin))).status).toBe(400);
  });

  test('aucun montant ni réglage de monétisation côté membre ; « Ce que tu y gagnes » affiché', async () => {
    const list = await request(app).get('/api/community/offers?kind=affiliate').set(auth(adult));
    const text = JSON.stringify(list.body);
    expect(text).not.toMatch(/payout_note|subid_param|campaign_rules_url|incentive_allowed|amount_cents|estimated|2,50 €/);
    const offer = list.body.data.items.find((o) => o.id === offers[13]);
    expect(offer.member_benefit).toBe('5 € offerts à l’inscription par l’appli');
    expect(offer.payout_text).toBeNull();
    const tried = await request(app).get('/api/community/offers/tried').set(auth(adult));
    expect(tried.status).toBe(200);
    expect(tried.body.data.items.map((o) => o.id)).toEqual(expect.arrayContaining([offers[13], offers[15]]));
    expect(JSON.stringify(tried.body)).not.toMatch(/payout_note|amount|estimated|conversion/);
    // Un autre membre ne voit pas les offres essayées de ce membre.
    const other = await request(app).get('/api/community/offers/tried').set(auth(minor));
    expect(other.body.data.items).toEqual([]);
  });
});

describe('interface et textes', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (name) => fs.readFileSync(path.join(__dirname, '../frontend', name), 'utf8');

  test('« Ce que tu y gagnes » sur la carte et la page de l’offre ; jamais de montant HAISSEL côté membre', () => {
    const app = read('app.js');
    expect(app).toContain("h('strong', null, 'Ce que tu y gagnes : '), offer.member_benefit");
    expect(app).toContain("fact('Ce que tu y gagnes', offer.member_benefit, 'donné par l’annonceur, selon ses conditions')");
    expect(app.match(/benefitLine\(offer\)/g).length).toBeGreaterThanOrEqual(2);
    expect(app).not.toMatch(/payout_note[^']*\)\s*\)/);
  });

  test('formulaire ADMIN : champs de campagne et de suivi, âge 13 / 15 / 16 / 18', () => {
    const html = read('index.html');
    for (const id of ['pub-incentive', 'pub-member-benefit', 'pub-payout-note', 'pub-rules-url', 'pub-subid-param']) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<section class="pub-team" data-team-only hidden/);
    expect(read('app.js')).toContain('const TEAM_OFFER_AGES = [13, 15, 16, 18];');
  });

  test('console : section Revenus avec export CSV', () => {
    const html = read('admin.html');
    expect(html).toContain('<a href="#revenue" data-section="revenue">Revenus</a>');
    expect(html).toContain('href="/api/admin/revenue?format=csv" download');
  });

  test('CGU et Transparence : commission possible pour HAISSEL, membres non rémunérés, gains venant de l’annonceur', () => {
    const cgu = read('cgu.html');
    expect(cgu).toContain('<strong>HAISSEL peut toucher une commission</strong>');
    expect(cgu).toContain('<strong>Les membres ne sont pas rémunérés par HAISSEL.</strong>');
    expect(cgu).toContain('accordé directement par l\'annonceur, selon ses propres conditions');
    const transparence = read('transparence.html');
    expect(transparence).toContain('peut verser une commission à HAISSEL');
    expect(transparence).toContain('c\'est l\'<strong>annonceur</strong> qui l\'accorde');
    expect(read('confidentialite.html')).toContain('identifiant de suivi anonyme');
  });
});
