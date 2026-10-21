/*
 * Moteur d'affiliation interne GELÉ (état par défaut : ENABLE_INTERNAL_AFFILIATION
 * absent). Deux garanties à tenir :
 *
 *  1. les routes qui créent des codes, le webhook et les écrans conversions /
 *     gains répondent 404 FEATURE_DISABLED ;
 *  2. les redirections des liens DÉJÀ PARTAGÉS continuent de fonctionner —
 *     geler la fonctionnalité ne doit casser aucun lien en circulation.
 *
 * Ce fichier ne pose pas le drapeau, contrairement à integration.test.js :
 * chaque fichier de test a son propre registre de modules, donc son propre
 * src/app.js chargé avec la configuration de ce fichier.
 */
delete process.env.ENABLE_INTERNAL_AFFILIATION;

const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const {
  createUser, login, auth, lanHeaders, signWebhook,
} = helpers;

let pool;
let user;
let userToken;
let admin;
let adminToken;
let offerId;
const SHARED_CODE = 'HAI-GEL23456';

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  user = await createUser({ prefix: 'gel' });
  admin = await createUser({ admin: true, prefix: 'geladmin' });
  [userToken, adminToken] = await Promise.all([login(app, user), login(app, admin)]);

  /*
   * Un lien partagé AVANT le gel : inséré directement en base, puisque la
   * route qui crée les codes est justement celle qu'on désactive.
   */
  const offer = await pool.query(
    `INSERT INTO affiliate_links (name, url, description, is_active)
     VALUES ('Offre historique', 'https://partenaire.example/landing', 'Creee avant le gel', true)
     RETURNING id`
  );
  offerId = offer.rows[0].id;
  await pool.query(
    'INSERT INTO user_affiliate_codes (user_id, affiliate_link_id, code) VALUES ($1, $2, $3)',
    [user.id, offerId, SHARED_CODE]
  );
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

function expectDisabled(res) {
  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe('FEATURE_DISABLED');
}

// ---------------------------------------------------------------------------
// 1. Les routes du moteur interne sont fermées
// ---------------------------------------------------------------------------

describe('Affiliation gelée : routes membre', () => {
  it('refuse la liste des offres affiliées', async () => {
    expectDisabled(await request(app).get('/api/affiliate/offers').set(auth(userToken)));
  });

  it('refuse la création d un code personnel', async () => {
    expectDisabled(await request(app).post(`/api/affiliate/offers/${offerId}/link`).set(auth(userToken)));
  });

  it('refuse les statistiques personnelles', async () => {
    expectDisabled(await request(app).get('/api/affiliate/stats').set(auth(userToken)));
  });

  it('refuse la liste des conversions personnelles', async () => {
    expectDisabled(await request(app).get('/api/affiliate/conversions').set(auth(userToken)));
  });

  it('répond 404 même sans session : la fonctionnalité ne se révèle pas', async () => {
    expectDisabled(await request(app).get('/api/affiliate/stats'));
  });

  it('ne crée aucun code en base malgré les tentatives', async () => {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM user_affiliate_codes WHERE user_id = $1',
      [user.id]
    );
    // Seul le code inséré à la main pour le test de redirection.
    expect(rows[0].n).toBe(1);
  });
});

describe('Affiliation gelée : webhook', () => {
  it('refuse un postback, même correctement signé', async () => {
    const body = JSON.stringify({
      event: 'conversion', code: SHARED_CODE, external_id: 'x1', amount_cents: 500,
    });
    const res = await request(app)
      .post('/api/webhooks/affiliate/mylead')
      .set(signWebhook(body))
      .send(body);
    expectDisabled(res);
  });

  it('n enregistre aucune conversion', async () => {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM conversions');
    expect(rows[0].n).toBe(0);
  });
});

describe('Affiliation gelée : routes admin', () => {
  const asAdmin = (req) => req.set(auth(adminToken));

  it('refuse l écran des conversions', async () => {
    expectDisabled(await asAdmin(request(app).get('/api/admin/conversions')));
  });

  it('refuse la création manuelle d une conversion', async () => {
    expectDisabled(await asAdmin(request(app).post('/api/admin/conversions')).send({ code: SHARED_CODE }));
  });

  it('refuse le changement de statut d une conversion', async () => {
    expectDisabled(await asAdmin(request(app).patch('/api/admin/conversions/1/status')).send({ status: 'approved' }));
  });

  it('refuse l écran des gains', async () => {
    expectDisabled(await asAdmin(request(app).get('/api/admin/earnings')));
  });

  it('refuse « marquer comme payé »', async () => {
    expectDisabled(await asAdmin(request(app).patch('/api/admin/earnings/1/pay')).send({}));
  });

  it('laisse intactes les fonctionnalités actives (liens publiés, clics, vue d ensemble)', async () => {
    // Le catalogue de liens et ses clics ne font pas partie du moteur gelé.
    expect((await asAdmin(request(app).get('/api/admin/affiliates'))).status).toBe(200);
    expect((await asAdmin(request(app).get('/api/admin/clicks'))).status).toBe(200);
    expect((await asAdmin(request(app).get('/api/admin/overview'))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. Les liens déjà partagés continuent de fonctionner
// ---------------------------------------------------------------------------

describe('Affiliation gelée : les liens déjà partagés redirigent toujours', () => {
  it('/r/:code redirige vers la destination de l offre', async () => {
    const res = await request(app).get(`/r/${SHARED_CODE}`)
      .set(lanHeaders('192.168.1.91')).set('User-Agent', 'jest');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('partenaire.example');
  });

  it('enregistre toujours le clic côté serveur', async () => {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM clicks WHERE affiliate_link_id = $1',
      [offerId]
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('l alias historique /api/affiliate/HAI-... redirige aussi', async () => {
    const res = await request(app).get(`/api/affiliate/${SHARED_CODE}`)
      .set(lanHeaders('192.168.1.92')).set('User-Agent', 'jest');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('partenaire.example');
  });

  it('un code inconnu rend la page « offre indisponible », pas FEATURE_DISABLED', async () => {
    const res = await request(app).get('/r/HAI-ZZZZ2345');
    expect(res.status).toBe(404);
    expect(res.text).toContain('plus disponible');
  });

  it('un code d une offre désactivée ne redirige plus', async () => {
    await pool.query('UPDATE affiliate_links SET is_active = false WHERE id = $1', [offerId]);
    const res = await request(app).get(`/r/${SHARED_CODE}`);
    expect(res.status).toBe(404);
    await pool.query('UPDATE affiliate_links SET is_active = true WHERE id = $1', [offerId]);
  });
});
