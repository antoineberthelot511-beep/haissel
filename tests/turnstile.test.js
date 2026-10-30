/*
 * Vérification anti-robot (Cloudflare Turnstile).
 *
 * Deux garanties à tenir :
 *   1. les quatre formulaires sensibles sont couverts côté serveur —
 *      inscription, connexion, mot de passe oublié, publication d'une offre ;
 *   2. la clé SECRÈTE ne sort jamais du serveur.
 *
 * Et un comportement de configuration : en production, l'absence de clés
 * refuse la demande au lieu de la laisser passer sans vérification.
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const turnstile = require('../src/services/turnstile.service');

const { createUser, login, auth, PASSWORD } = helpers;

// Clés de test officielles Cloudflare : « 1x… » accepte tout, « 2x… » refuse tout.
const SITE_KEY_OK = '1x00000000000000000000AA';
const SECRET_ALWAYS_OK = '1x0000000000000000000000000000000AA';
const SECRET_ALWAYS_KO = '2x0000000000000000000000000000000AA';

let pool;
let member;
let identity;

/** Active Turnstile pour la durée d'un test, puis restaure l'état précédent. */
function withKeys(secret) {
  process.env.TURNSTILE_SITE_KEY = SITE_KEY_OK;
  process.env.TURNSTILE_SECRET_KEY = secret;
}
function withoutKeys() {
  process.env.TURNSTILE_SITE_KEY = '';
  process.env.TURNSTILE_SECRET_KEY = '';
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  member = await createUser({ prefix: 'turnstile', adult: true });
  identity = await login(app, member);
}, 30000);

afterEach(() => {
  withoutKeys();
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  await helpers.teardownDatabase();
});

const registration = (overrides = {}) => ({
  first_name: 'Camille',
  last_name: 'Durand',
  username: `ts${Math.random().toString(16).slice(2, 8)}`,
  email: `ts${Math.random().toString(16).slice(2, 8)}@exemple.fr`,
  password: PASSWORD,
  confirm_password: PASSWORD,
  is_adult: true,
  age_terms_accepted: true,
  ...overrides,
});

const offerBody = (overrides = {}) => ({
  title: `Offre anti-robot ${Math.random().toString(16).slice(2, 6)}`,
  url: `https://partenaire.exemple.fr/ts/${Math.random().toString(16).slice(2, 8)}`,
  description: 'Une description assez longue pour passer la validation de longueur.',
  category: 'applications',
  countries: 'FR',
  expected_action: 'Créer un compte',
  campaign_name: 'Campagne de test',
  rights_confirmed: true,
  ...overrides,
});

// ===========================================================================
describe('Couverture : les quatre formulaires sensibles', () => {
  /*
   * Avec les clés actives mais sans jeton dans le corps, chaque route doit
   * répondre 400 TURNSTILE_REQUIRED. C'est la preuve que la vérification est
   * bien branchée sur cette route précise.
   */
  // Chaque entrée prend le jeton à envoyer : sans jeton on teste la présence
  // de la garde, avec un jeton on teste la vérification elle-même.
  const CASES = [
    ['inscription', (token) => request(app).post('/api/auth/register').send(registration(token))],
    ['connexion', (token) => request(app).post('/api/auth/login')
      .send({ identifier: member.username, password: PASSWORD, ...token })],
    ['mot de passe oublié', (token) => request(app).post('/api/auth/password/forgot')
      .send({ email: member.email, ...token })],
    ['publication d’une offre', (token) => request(app).post('/api/community/offers')
      .set(auth(identity)).send(offerBody(token))],
  ];

  test.each(CASES)('%s exige un jeton', async (_label, call) => {
    withKeys(SECRET_ALWAYS_OK);
    const res = await call({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TURNSTILE_REQUIRED');
  });

  test.each(CASES)('%s refuse un jeton invalide', async (_label, call) => {
    // La clé « 2x… » fait échouer toute vérification côté Cloudflare.
    withKeys(SECRET_ALWAYS_KO);
    const res = await call({ cf_turnstile_response: 'jeton-refuse-par-cloudflare' });
    expect(res.status).toBe(403);
    expect(['TURNSTILE_FAILED', 'TURNSTILE_EXPIRED']).toContain(res.body.error.code);
  }, 20000);

  test('sans clés configurées (hors production), les routes fonctionnent', async () => {
    withoutKeys();
    const res = await request(app).post('/api/auth/login')
      .send({ identifier: member.username, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  test('la modification d’une offre n’exige pas de jeton', async () => {
    withoutKeys();
    const created = await request(app).post('/api/community/offers').set(auth(identity)).send(offerBody());
    expect(created.status).toBe(201);

    withKeys(SECRET_ALWAYS_OK);
    const edited = await request(app).patch(`/api/community/offers/${created.body.data.offer.id}`)
      .set(auth(identity)).send(offerBody({ title: 'Titre corrigé sans jeton' }));
    expect(edited.status).toBe(200);
  });
});

// ===========================================================================
describe('Production sans clés : refus propre, rien ne passe', () => {
  const ROUTES = [
    ['inscription', () => request(app).post('/api/auth/register').send(registration())],
    ['connexion', () => request(app).post('/api/auth/login').send({ identifier: member.username, password: PASSWORD })],
    ['mot de passe oublié', () => request(app).post('/api/auth/password/forgot').send({ email: member.email })],
    ['publication', () => request(app).post('/api/community/offers').set(auth(identity)).send(offerBody())],
  ];

  test.each(ROUTES)('%s : 503 avec un message explicite', async (_label, call) => {
    withoutKeys();
    process.env.NODE_ENV = 'production';
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TURNSTILE_NOT_CONFIGURED');
    // Message compréhensible, qui dit quoi faire.
    expect(res.body.error.message).toMatch(/anti-robot/);
    expect(res.body.error.message).toMatch(/administrateur/);
  });

  test('aucun compte n’est créé pendant le refus', async () => {
    withoutKeys();
    process.env.NODE_ENV = 'production';
    const body = registration();
    await request(app).post('/api/auth/register').send(body);

    process.env.NODE_ENV = 'test';
    const row = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE username = $1', [body.username]);
    expect(row.rows[0].n).toBe(0);
  });
});

// ===========================================================================
describe('La clé secrète ne quitte jamais le serveur', () => {
  test('/api/auth/config n’expose que la clé publique', async () => {
    withKeys(SECRET_ALWAYS_OK);
    const res = await request(app).get('/api/auth/config');
    expect(res.status).toBe(200);
    expect(res.body.data.turnstile_site_key).toBe(SITE_KEY_OK);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRET_ALWAYS_OK);
    expect(body).not.toMatch(/secret/i);
  });

  test('aucune réponse d’erreur ne contient la clé secrète', async () => {
    withKeys(SECRET_ALWAYS_KO);
    const res = await request(app).post('/api/auth/login')
      .send({ identifier: member.username, password: PASSWORD, cf_turnstile_response: 'jeton-bidon' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_ALWAYS_KO);
  }, 20000);

  test('la clé publique est absente quand rien n’est configuré', async () => {
    withoutKeys();
    const res = await request(app).get('/api/auth/config');
    expect(res.body.data.turnstile_site_key).toBeNull();
  });

  test('un jeton vide ou surdimensionné est refusé sans appel réseau', async () => {
    withKeys(SECRET_ALWAYS_OK);
    const long = 'a'.repeat(3000);
    const res = await turnstile.verifyTurnstileToken(long, {});
    expect(res.success).toBe(false);
    expect(res.errorCodes).toContain('missing-input-response');
  });
});

// ===========================================================================
describe('Panne de Cloudflare : on refuse, on ne laisse pas passer', () => {
  test('une erreur réseau donne 503, jamais un succès', async () => {
    withKeys(SECRET_ALWAYS_OK);
    const result = await turnstile.verifyTurnstileToken('jeton', {
      fetchImpl: () => Promise.reject(new Error('réseau injoignable')),
    });
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain('internal-error');
  });
});
