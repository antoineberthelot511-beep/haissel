/*
 * Déclaration de majorité.
 *
 * MyLead exige 18 ans pour un compte éditeur. HAISSEL pose la question à
 * l'inscription, la repose aux comptes plus anciens, et refuse aux mineurs
 * ce qui mène à un compte éditeur ou à un lien affilié — côté serveur, pas
 * seulement dans l'interface.
 *
 * Aucune date de naissance n'est enregistrée : seulement un booléen et la
 * date de sa déclaration.
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const { createUser, login, auth, PASSWORD } = helpers;

let pool;
let adminIdentity;
let adult;
let adultIdentity;
let minor;
let minorIdentity;
let undeclared;
let undeclaredIdentity;
// Second majeur : sert à tester l'ouverture d'une offre dont il N'EST PAS
// l'auteur, l'auteur bénéficiant d'une dérogation.
let otherAdultIdentity;

/** Publie une offre (par un majeur) et la fait valider. */
async function publishedOffer({ minAge = null } = {}) {
  const res = await request(app).post('/api/community/offers').set(auth(adultIdentity)).send({
    title: `Offre de test ${Math.random().toString(16).slice(2, 8)}`,
    url: `https://partenaire.exemple.fr/o/${Math.random().toString(16).slice(2, 10)}`,
    description: 'Une offre de démonstration pour les tests de majorité, suffisamment décrite.',
    category: 'applications',
    countries: 'FR',
    expected_action: 'Créer un compte',
    payout_text: null,
    min_age: minAge,
    conditions: null,
    campaign_name: 'Campagne de test',
    rights_confirmed: true,
  });
  expect(res.status).toBe(201);
  const { id } = res.body.data.offer;
  await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [id]);
  await request(app).post(`/api/admin/community/offers/${id}/moderate`)
    .set(auth(adminIdentity)).send({ decision: 'publish' }).expect(200);
  return id;
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  adminIdentity = await login(app, await createUser({ admin: true, prefix: 'adultadmin' }));

  adult = await createUser({ prefix: 'majeur', adult: true });
  adultIdentity = await login(app, adult);

  minor = await createUser({ prefix: 'mineur', adult: false });
  minorIdentity = await login(app, minor);

  // Compte créé avant la mise en place : la question n'a jamais été posée.
  undeclared = await createUser({ prefix: 'ancien', adult: null });
  undeclaredIdentity = await login(app, undeclared);

  otherAdultIdentity = await login(app, await createUser({ prefix: 'majeur2', adult: true }));
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

// ===========================================================================
describe('Inscription : la question est obligatoire', () => {
  const base = (overrides = {}) => ({
    first_name: 'Camille',
    last_name: 'Durand',
    username: `insc${Math.random().toString(16).slice(2, 8)}`,
    email: `insc${Math.random().toString(16).slice(2, 8)}@exemple.fr`,
    password: PASSWORD,
    confirm_password: PASSWORD,
    age_terms_accepted: true,
    ...overrides,
  });

  test('sans réponse : refus', async () => {
    const res = await request(app).post('/api/auth/register').send(base());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ADULT_ANSWER_REQUIRED');
  });

  test('une réponse non booléenne ne vaut pas « oui »', async () => {
    for (const value of ['oui', 'true', 1, 'yes', null, {}]) {
      const res = await request(app).post('/api/auth/register').send(base({ is_adult: value }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ADULT_ANSWER_REQUIRED');
    }
  });

  test('« oui » enregistre la déclaration et sa date, sans date de naissance', async () => {
    const body = base({ is_adult: true });
    const res = await request(app).post('/api/auth/register').send(body);
    expect([201, 202]).toContain(res.status);

    const row = await pool.query(
      'SELECT is_adult, adult_declared_at FROM users WHERE username = $1',
      [body.username]
    );
    expect(row.rows[0].is_adult).toBe(true);
    expect(row.rows[0].adult_declared_at).toBeInstanceOf(Date);
  });

  test('case « 15 ans ou plus, ou accord d’un parent » obligatoire et horodatée', async () => {
    for (const value of [undefined, false, 'true', 1]) {
      const res = await request(app).post('/api/auth/register').send(base({ is_adult: true, age_terms_accepted: value }));
      expect([value, res.status, res.body.error?.code]).toEqual([value, 400, 'AGE_TERMS_REQUIRED']);
    }
    const body = base({ is_adult: false });
    expect([201, 202]).toContain((await request(app).post('/api/auth/register').send(body)).status);
    const row = await pool.query('SELECT age_terms_accepted_at FROM users WHERE username = $1', [body.username]);
    expect(row.rows[0].age_terms_accepted_at).toBeInstanceOf(Date);

    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
    expect(html).toMatch(/<input id="register-age-terms" type="checkbox" required \/>\s*<span>J'ai 15 ans ou plus, ou j'ai l'accord d'un parent pour m'inscrire\.<\/span>/);
    const appJs = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
    expect(appJs).toContain('body.age_terms_accepted = true;');
  });

  test('« non » est accepté : le compte est créé, mineur déclaré', async () => {
    const body = base({ is_adult: false });
    const res = await request(app).post('/api/auth/register').send(body);
    expect([201, 202]).toContain(res.status);

    const row = await pool.query('SELECT is_adult FROM users WHERE username = $1', [body.username]);
    expect(row.rows[0].is_adult).toBe(false);
  });

  test('aucune colonne de date de naissance n’existe dans users', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'users'`
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('is_adult');
    expect(names).toContain('adult_declared_at');
    expect(names.filter((nm) => /birth|naissance|\bage\b/.test(nm))).toEqual([]);
  });
});

// ===========================================================================
describe('Comptes existants : la question est reposée', () => {
  test('/api/auth/me signale que la réponse manque', async () => {
    const res = await request(app).get('/api/auth/me').set(auth(undeclaredIdentity));
    expect(res.status).toBe(200);
    expect(res.body.data.user.is_adult).toBeNull();
    expect(res.body.data.user.adult_declaration_required).toBe(true);
  });

  test('un compte déjà déclaré n’est pas réinterrogé', async () => {
    const res = await request(app).get('/api/auth/me').set(auth(adultIdentity));
    expect(res.body.data.user.is_adult).toBe(true);
    expect(res.body.data.user.adult_declaration_required).toBe(false);
  });

  test('une réponse non booléenne est refusée', async () => {
    const res = await request(app).post('/api/auth/adult-declaration')
      .set(auth(undeclaredIdentity)).send({ is_adult: 'oui' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ADULT_ANSWER_REQUIRED');
  });

  test('sans session, la déclaration est impossible', async () => {
    const res = await request(app).post('/api/auth/adult-declaration').send({ is_adult: true });
    expect(res.status).toBe(401);
  });

  test('répondre débloque le compte et horodate la réponse', async () => {
    const user = await createUser({ prefix: 'repond', adult: null });
    const identity = await login(app, user);

    const res = await request(app).post('/api/auth/adult-declaration')
      .set(auth(identity)).send({ is_adult: true });
    expect(res.status).toBe(200);
    expect(res.body.data.user.is_adult).toBe(true);
    expect(res.body.data.user.adult_declaration_required).toBe(false);

    const row = await pool.query('SELECT is_adult, adult_declared_at FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].is_adult).toBe(true);
    expect(row.rows[0].adult_declared_at).toBeInstanceOf(Date);
  });
});

// ===========================================================================
describe('Mineur : ce qui est refusé côté serveur', () => {
  test('publier une offre : 403', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(minorIdentity)).send({
      title: 'Offre interdite aux mineurs',
      url: 'https://partenaire.exemple.fr/interdit',
      description: 'Une description assez longue pour passer la validation de longueur.',
      category: 'applications',
      countries: 'FR',
      expected_action: 'Créer un compte',
      min_age: null,
      campaign_name: 'Campagne de test',
      rights_confirmed: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_REQUIRED');
    expect(res.body.error.message).toMatch(/18 ans/);
  });

  test('modifier une offre : 403', async () => {
    const id = await publishedOffer();
    const res = await request(app).patch(`/api/community/offers/${id}`).set(auth(minorIdentity)).send({
      title: 'Tentative de modification',
      url: 'https://partenaire.exemple.fr/autre',
      description: 'Une description assez longue pour passer la validation de longueur.',
      category: 'applications',
      countries: 'FR',
      expected_action: 'Créer un compte',
      campaign_name: 'Campagne de test',
      rights_confirmed: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_REQUIRED');
  });

  test('le lien de parrainage : 403', async () => {
    const res = await request(app).get('/api/learn/referral').set(auth(minorIdentity));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_REQUIRED');
  });

  test('ouvrir un lien affilié d’un membre : 403', async () => {
    const id = await publishedOffer();
    const res = await request(app).get(`/api/community/offers/${id}/open`).set(auth(minorIdentity));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_REQUIRED');
  });

  test('ouvrir un lien de l’équipe : 403', async () => {
    const link = await pool.query(
      `INSERT INTO affiliate_links (name, url, is_active)
       VALUES ('Lien équipe', 'https://partenaire.exemple.fr/equipe', true) RETURNING id`
    );
    const res = await request(app).get(`/go/${link.rows[0].id}`).set('Cookie', minorIdentity.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_REQUIRED');
  });

  test('même sa propre offre ne s’ouvre pas : la dérogation d’auteur est réservée aux majeurs', async () => {
    // Offre publiée alors que le compte était déclaré majeur, puis correction.
    const user = await createUser({ prefix: 'devenumineur', adult: true });
    const identity = await login(app, user);
    const created = await request(app).post('/api/community/offers').set(auth(identity)).send({
      title: 'Offre de celui qui se corrige',
      url: 'https://partenaire.exemple.fr/correction',
      description: 'Une description assez longue pour passer la validation de longueur.',
      category: 'applications',
      countries: 'FR',
      expected_action: 'Créer un compte',
      campaign_name: 'Campagne de test',
      rights_confirmed: true,
    });
    const id = created.body.data.offer.id;
    await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [id]);
    await request(app).post(`/api/admin/community/offers/${id}/moderate`)
      .set(auth(adminIdentity)).send({ decision: 'publish' }).expect(200);

    await request(app).post('/api/auth/adult-declaration').set(auth(identity)).send({ is_adult: false }).expect(200);

    const opened = await request(app).get(`/api/community/offers/${id}/open`).set(auth(identity));
    expect(opened.status).toBe(403);
    expect(opened.body.error.code).toBe('ADULT_REQUIRED');

    const mine = await request(app).get('/api/community/offers/mine').set(auth(identity));
    const row = mine.body.data.items.find((item) => item.id === id);
    expect(row.can_open).toBe(false);
    expect(row.url).toBeNull();
  });

  test('l’adresse de destination ne lui est même pas transmise', async () => {
    await publishedOffer();
    const res = await request(app).get('/api/community/offers').set(auth(minorIdentity));
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    for (const item of res.body.data.items) {
      expect(item.url).toBeNull();
      expect(item.can_open).toBe(false);
      // Le domaine reste visible : il sert à juger l'offre, pas à l'ouvrir.
      expect(typeof item.domain).toBe('string');
    }
  });
});

// ===========================================================================
describe('Mineur : ce qui reste accessible', () => {
  test('les guides de l’espace Apprendre', async () => {
    const res = await request(app).get('/api/learn/content').set(auth(minorIdentity));
    expect(res.status).toBe(200);
  });

  test('les opportunités (contenu pédagogique)', async () => {
    const res = await request(app).get('/api/learn/opportunities').set(auth(minorIdentity));
    expect(res.status).toBe(200);
  });

  test('la liste des offres, sans pouvoir les ouvrir', async () => {
    const res = await request(app).get('/api/community/offers').set(auth(minorIdentity));
    expect(res.status).toBe(200);
  });

  test('retirer une offre qu’il avait publiée avant', async () => {
    // Publiée pendant qu'il était déclaré majeur, puis déclaration corrigée.
    const user = await createUser({ prefix: 'exmajeur', adult: true });
    const identity = await login(app, user);
    const created = await request(app).post('/api/community/offers').set(auth(identity)).send({
      title: 'Offre publiée avant correction',
      url: 'https://partenaire.exemple.fr/avant',
      description: 'Une description assez longue pour passer la validation de longueur.',
      category: 'applications',
      countries: 'FR',
      expected_action: 'Créer un compte',
      campaign_name: 'Campagne de test',
      rights_confirmed: true,
    });
    expect(created.status).toBe(201);

    await request(app).post('/api/auth/adult-declaration').set(auth(identity)).send({ is_adult: false }).expect(200);

    // Le retrait reste possible : on ne piège pas un membre avec son propre contenu.
    const removed = await request(app).delete(`/api/community/offers/${created.body.data.offer.id}`).set(auth(identity));
    expect(removed.status).toBe(200);
  });
});

// ===========================================================================
describe('Compte sans réponse : tout est suspendu à la question', () => {
  test('publier : 403 avec un code distinct du refus pour minorité', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(undeclaredIdentity)).send({
      title: 'Offre sans declaration',
      url: 'https://partenaire.exemple.fr/sansdecl',
      description: 'Une description assez longue pour passer la validation de longueur.',
      category: 'applications',
      countries: 'FR',
      expected_action: 'Créer un compte',
      campaign_name: 'Campagne de test',
      rights_confirmed: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_DECLARATION_REQUIRED');
  });

  test('ouvrir un lien affilié : 403 ADULT_DECLARATION_REQUIRED', async () => {
    const id = await publishedOffer();
    const res = await request(app).get(`/api/community/offers/${id}/open`).set(auth(undeclaredIdentity));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_DECLARATION_REQUIRED');
  });

  test('le parrainage : 403 ADULT_DECLARATION_REQUIRED', async () => {
    const res = await request(app).get('/api/learn/referral').set(auth(undeclaredIdentity));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_DECLARATION_REQUIRED');
  });
});

// ===========================================================================
describe('Âge minimum des offres', () => {
  test('un majeur ouvre une offre 16 ans et plus', async () => {
    const id = await publishedOffer({ minAge: 16 });
    const res = await request(app).get(`/api/community/offers/${id}/open`).set(auth(adultIdentity));
    expect(res.status).toBe(200);
    expect(res.body.data.url).toContain('partenaire.exemple.fr');
  });

  test('un majeur ouvre une offre 18 ans et plus', async () => {
    const id = await publishedOffer({ minAge: 18 });
    const res = await request(app).get(`/api/community/offers/${id}/open`).set(auth(adultIdentity));
    expect(res.status).toBe(200);
  });

  test('une offre 21 ans et plus reste fermée : HAISSEL ne certifie que « 18 ou plus »', async () => {
    const id = await publishedOffer({ minAge: 21 });
    // Un autre majeur que l'auteur : la dérogation d'auteur ne s'applique pas.
    const res = await request(app).get(`/api/community/offers/${id}/open`).set(auth(otherAdultIdentity));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AGE_RESTRICTED');
  });

  test('l’auteur peut toujours ouvrir sa propre offre pour la vérifier', async () => {
    const id = await publishedOffer({ minAge: 21 });
    // L'offre a été publiée par « adult » : il la relit malgré la restriction.
    const list = await request(app).get('/api/community/offers/mine').set(auth(adultIdentity));
    const mine = list.body.data.items.find((item) => item.id === id);
    expect(mine.can_open).toBe(true);
    expect(mine.url).toContain('partenaire.exemple.fr');
  });

  test('offre inexistante : 404, pas 403', async () => {
    const res = await request(app).get('/api/community/offers/99999999/open').set(auth(adultIdentity));
    expect(res.status).toBe(404);
  });
});
