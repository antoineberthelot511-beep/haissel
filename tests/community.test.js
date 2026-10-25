/*
 * Offres publiées par les membres : validation, propriété, modération,
 * signalements, anti-spam. PostgreSQL réel (schéma isolé).
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const { normalizeMemberUrl, SENSITIVE_TOPICS } = require('../src/controllers/community.controller');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let alice;
let bob;
let aliceUser;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'modadmin' }));
  aliceUser = await createUser({ prefix: 'alice' });
  alice = await login(app, aliceUser);
  bob = await login(app, await createUser({ prefix: 'bob' }));
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

let counter = 0;
function offer(overrides = {}) {
  counter += 1;
  return {
    title: `Application de test ${counter}`,
    url: `https://exemple.fr/offre/${counter}?sub=haissel`,
    description: 'Une application pour réviser ses cours, gratuite au téléchargement.',
    category: 'applications',
    countries: 'FR, BE',
    expected_action: 'Installer et ouvrir l’application',
    payout_text: null,
    min_age: null,
    conditions: 'Pas de trafic incité.',
    campaign_name: 'Campagne de test',
    rights_confirmed: true,
    ...overrides,
  };
}

async function publish(identity, data = offer()) {
  const res = await request(app).post('/api/community/offers').set(auth(identity)).send(data);
  expect(res.status).toBe(201);
  const { id } = res.body.data.offer;
  // Hors de la fenêtre anti-spam de 24 h (testée séparément).
  await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [id]);
  await request(app).post(`/api/admin/community/offers/${id}/moderate`).set(auth(admin)).send({ decision: 'publish' }).expect(200);
  return id;
}

describe('validation des liens', () => {
  test.each([
    'http://exemple.fr', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'https://127.0.0.1/x',
    'https://localhost/x', 'https://user:pass@exemple.fr', 'https://exemple.fr:8080/x', 'https://[::1]/', 'https://intranet/',
  ])('refuse %s', (url) => expect(() => normalizeMemberUrl(url)).toThrow());

  test('accepte et normalise un lien https', () => {
    expect(normalizeMemberUrl('  https://MyLead.global/ref?a=1  ')).toBe('https://mylead.global/ref?a=1');
  });

  test('thèmes sensibles détectés', () => {
    expect(SENSITIVE_TOPICS.test('Casino en ligne bonus')).toBe(true);
    expect(SENSITIVE_TOPICS.test('Gagne des cryptomonnaies')).toBe(true);
    expect(SENSITIVE_TOPICS.test('Application de révision du bac')).toBe(false);
  });
});

describe('publication', () => {
  test('session obligatoire', async () => {
    expect((await request(app).get('/api/community/offers')).status).toBe(401);
    expect((await request(app).post('/api/community/offers').send(offer())).status).toBe(401);
  });

  test('une offre envoyée attend la modération et reste invisible des autres', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send(offer({ title: 'Offre en attente' }));
    expect(res.status).toBe(201);
    expect(res.body.data.offer.status).toBe('pending');
    expect(res.body.data.message).toMatch(/envoyée/);

    const feed = await request(app).get('/api/community/offers').set(auth(bob));
    expect(feed.body.data.items.map((o) => o.title)).not.toContain('Offre en attente');
    const mine = await request(app).get('/api/community/offers/mine').set(auth(alice));
    expect(mine.body.data.items.map((o) => o.title)).toContain('Offre en attente');
  });

  test.each([
    ['lien http', { url: 'http://exemple.fr' }, 'INVALID_URL'],
    ['sans confirmation des droits', { rights_confirmed: false }, 'RIGHTS_NOT_CONFIRMED'],
    ['catégorie inconnue', { category: 'casino' }, 'INVALID_FIELD'],
    ['thème interdit', { description: 'Les meilleurs paris sportifs avec bonus de bienvenue.' }, 'FORBIDDEN_TOPIC'],
    ['promesse de gain', { description: 'Des gains garantis chaque semaine sans effort.' }, 'MISLEADING_CLAIM'],
    ['âge invalide', { min_age: 5 }, 'INVALID_FIELD'],
  ])('refuse : %s', async (_label, overrides, code) => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send(offer(overrides));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('après validation, offre visible avec son auteur (pseudo seulement)', async () => {
    await publish(alice, offer({ title: 'Offre publiée visible' }));
    const feed = await request(app).get('/api/community/offers?q=publiée visible').set(auth(bob));
    expect(feed.body.data.items).toHaveLength(1);
    const item = feed.body.data.items[0];
    expect(item.author).toEqual({ username: aliceUser.username });
    expect(item.is_mine).toBe(false);
    expect(JSON.stringify(item)).not.toContain('@exemple.fr');
  });

  test('filtres catégorie et pays', async () => {
    await publish(alice, offer({ title: 'Jeu canadien', category: 'jeux', countries: 'CA' }));
    const byCat = await request(app).get('/api/community/offers?category=jeux').set(auth(bob));
    expect(byCat.body.data.items.map((o) => o.title)).toEqual(['Jeu canadien']);
    const byCountry = await request(app).get('/api/community/offers?country=FR').set(auth(bob));
    expect(byCountry.body.data.items.map((o) => o.title)).not.toContain('Jeu canadien');
  });
});

describe('propriété', () => {
  test("un autre membre reçoit 403, pas 404 : l'offre existe, elle n'est pas à lui", async () => {
    const id = await publish(alice);

    const patched = await request(app).patch(`/api/community/offers/${id}`).set(auth(bob)).send(offer());
    expect(patched.status).toBe(403);
    expect(patched.body.error.code).toBe('NOT_OWNER');

    const deleted = await request(app).delete(`/api/community/offers/${id}`).set(auth(bob));
    expect(deleted.status).toBe(403);
    expect(deleted.body.error.code).toBe('NOT_OWNER');

    // L'offre n'a pas bougé.
    const row = await pool.query('SELECT status FROM member_offers WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('published');
  });

  test('une offre inexistante reste un 404', async () => {
    const res = await request(app).patch('/api/community/offers/99999999').set(auth(bob)).send(offer());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test("un ADMIN peut corriger l'offre d'un membre, sans en devenir l'auteur", async () => {
    const id = await publish(alice);

    const edited = await request(app).patch(`/api/community/offers/${id}`)
      .set(auth(admin)).send(offer({ title: 'Titre corrigé par la modération' }));
    expect(edited.status).toBe(200);
    // Toute modification repasse en vérification, même venant d'un ADMIN.
    expect(edited.body.data.offer.status).toBe('pending');
    // L'auteur affiché reste le membre, pas l'administrateur.
    expect(edited.body.data.offer.author.username).toBe(aliceUser.username);

    const row = await pool.query('SELECT user_id FROM member_offers WHERE id = $1', [id]);
    expect(row.rows[0].user_id).toBe(aliceUser.id);
  });

  test("un ADMIN peut retirer l'offre d'un membre", async () => {
    const id = await publish(alice);
    await request(app).delete(`/api/community/offers/${id}`).set(auth(admin)).expect(200);
    const row = await pool.query('SELECT status FROM member_offers WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('removed');
  });

  test("le propriétaire vient de la session : un user_id dans le corps est ignoré", async () => {
    const res = await request(app).post('/api/community/offers')
      .set(auth(alice))
      .send({ ...offer(), user_id: 999999, id: 123456, status: 'published' });
    expect(res.status).toBe(201);

    const row = await pool.query(
      'SELECT user_id, status FROM member_offers WHERE id = $1',
      [res.body.data.offer.id]
    );
    expect(row.rows[0].user_id).toBe(aliceUser.id);
    // Le statut est imposé par le serveur, pas par le corps de la requête.
    expect(row.rows[0].status).toBe('pending');
  });

  test("modifier sa propre offre la renvoie en vérification ; la retirer la masque", async () => {
    const id = await publish(alice);
    const edited = await request(app).patch(`/api/community/offers/${id}`).set(auth(alice)).send(offer({ title: 'Titre corrigé' }));
    expect(edited.status).toBe(200);
    expect(edited.body.data.offer.status).toBe('pending');
    await request(app).delete(`/api/community/offers/${id}`).set(auth(alice)).expect(200);
    const row = await pool.query('SELECT status FROM member_offers WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('removed');
  });

  test('sans jeton CSRF, la publication est refusée', async () => {
    const res = await request(app).post('/api/community/offers').set('Cookie', alice.cookie).send(offer());
    expect(res.status).toBe(403);
  });
});

describe('liens refusés', () => {
  /*
   * Un lien d'offre est fourni par un membre : donnée non fiable. Chaque cas
   * est testé séparément pour qu'un échec désigne la règle qui a cédé.
   */
  const REFUSES = [
    ['http simple', 'http://exemple.fr/offre'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['adresse IP privée', 'https://192.168.1.10/offre'],
    ['adresse IP publique littérale', 'https://93.184.216.34/offre'],
    ['bouclage', 'https://127.0.0.1/offre'],
    ['localhost', 'https://localhost/offre'],
    ['nom interne', 'https://serveur.internal/offre'],
    ['identifiants dans le lien', 'https://user:motdepasse@exemple.fr/offre'],
    ['port particulier', 'https://exemple.fr:8443/offre'],
    ['raccourcisseur bit.ly', 'https://bit.ly/3abcdef'],
    ['raccourcisseur tinyurl', 'https://tinyurl.com/abcdef'],
    ['raccourcisseur t.co', 'https://t.co/abcdef'],
    ['raccourcisseur avec www', 'https://www.bit.ly/3abcdef'],
  ];

  test.each(REFUSES)('refuse : %s', async (_label, url) => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send(offer({ url }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_URL');
    // Le message est rattaché au champ, pour l'afficher sous « Lien ».
    expect(res.body.error.field).toBe('url');
  });

  test('accepte un vrai lien https', async () => {
    const res = await request(app).post('/api/community/offers')
      .set(auth(alice)).send(offer({ url: 'https://partenaire.exemple.fr/landing?sub=haissel' }));
    expect(res.status).toBe(201);
  });

  test('les erreurs de champ désignent le champ fautif', async () => {
    const titre = await request(app).post('/api/community/offers').set(auth(alice)).send(offer({ title: 'abc' }));
    expect(titre.status).toBe(400);
    expect(titre.body.error.field).toBe('title');

    const categorie = await request(app).post('/api/community/offers').set(auth(alice)).send(offer({ category: 'inexistante' }));
    expect(categorie.status).toBe(400);
    expect(categorie.body.error.field).toBe('category');

    const age = await request(app).post('/api/community/offers').set(auth(alice)).send(offer({ min_age: 5 }));
    expect(age.status).toBe(400);
    expect(age.body.error.field).toBe('min_age');

    const droits = await request(app).post('/api/community/offers').set(auth(alice)).send(offer({ rights_confirmed: false }));
    expect(droits.status).toBe(400);
    expect(droits.body.error.code).toBe('RIGHTS_NOT_CONFIRMED');
    expect(droits.body.error.field).toBe('rights_confirmed');
  });
});

describe('enregistrer et signaler', () => {
  test('enregistrer puis filtrer ses offres enregistrées', async () => {
    const id = await publish(alice, offer({ title: 'Offre à garder' }));
    await request(app).post(`/api/community/offers/${id}/save`).set(auth(bob)).expect(200);
    const saved = await request(app).get('/api/community/offers?saved=1').set(auth(bob));
    expect(saved.body.data.items.map((o) => o.id)).toEqual([id]);
    expect(saved.body.data.items[0].saved).toBe(true);
    await request(app).delete(`/api/community/offers/${id}/save`).set(auth(bob)).expect(200);
    expect((await request(app).get('/api/community/offers?saved=1').set(auth(bob))).body.data.items).toEqual([]);
  });

  test('3 signalements masquent une offre ; un seul signalement par membre', async () => {
    const id = await publish(alice);
    const reporters = [bob, await login(app, await createUser()), await login(app, await createUser())];
    await request(app).post(`/api/community/offers/${id}/report`).set(auth(reporters[0])).send({ reason: 'spam' }).expect(200);
    const again = await request(app).post(`/api/community/offers/${id}/report`).set(auth(reporters[0])).send({ reason: 'spam' });
    expect(again.body.data.message).toMatch(/déjà/);
    await request(app).post(`/api/community/offers/${id}/report`).set(auth(reporters[1])).send({ reason: 'misleading' }).expect(200);
    let row = await pool.query('SELECT status FROM member_offers WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('published');
    await request(app).post(`/api/community/offers/${id}/report`).set(auth(reporters[2])).send({ reason: 'minors' }).expect(200);
    row = await pool.query('SELECT status FROM member_offers WHERE id = $1', [id]);
    expect(row.rows[0].status).toBe('pending');

    const queue = await request(app).get('/api/admin/community/offers?status=reported').set(auth(admin));
    const item = queue.body.data.items.find((o) => o.id === id);
    expect(item.open_reports).toBe(3);
  });

  test('on ne signale pas sa propre offre ; motif obligatoire', async () => {
    const id = await publish(alice);
    expect((await request(app).post(`/api/community/offers/${id}/report`).set(auth(alice)).send({ reason: 'spam' })).status).toBe(400);
    expect((await request(app).post(`/api/community/offers/${id}/report`).set(auth(bob)).send({ reason: 'nope' })).status).toBe(400);
  });
});

describe('modération et anti-spam', () => {
  test('un membre ne peut pas modérer', async () => {
    const res = await request(app).post('/api/admin/community/offers/1/moderate').set(auth(bob)).send({ decision: 'publish' });
    expect(res.status).toBe(403);
  });

  test('refus avec motif obligatoire, motif visible par l’auteur, action journalisée', async () => {
    await pool.query("UPDATE member_offers SET created_at = NOW() - INTERVAL '2 days' WHERE user_id = $1", [aliceUser.id]);
    const created = await request(app).post('/api/community/offers').set(auth(alice)).send(offer());
    const { id } = created.body.data.offer;
    expect((await request(app).post(`/api/admin/community/offers/${id}/moderate`).set(auth(admin)).send({ decision: 'reject' })).status).toBe(400);
    await request(app).post(`/api/admin/community/offers/${id}/moderate`).set(auth(admin))
      .send({ decision: 'reject', note: 'Conditions de l’annonceur manquantes.' }).expect(200);
    const mine = await request(app).get('/api/community/offers/mine').set(auth(alice));
    expect(mine.body.data.items.find((o) => o.id === id).moderation_note).toMatch(/manquantes/);
    const log = await pool.query("SELECT 1 FROM admin_actions WHERE action = 'member_offer.reject' AND target_id = $1", [id]);
    expect(log.rows).toHaveLength(1);
  });

  test('doublon refusé et limite de 5 offres par 24 h', async () => {
    const carol = await login(app, await createUser({ prefix: 'carol' }));
    const first = offer();
    await request(app).post('/api/community/offers').set(auth(carol)).send(first).expect(201);
    expect((await request(app).post('/api/community/offers').set(auth(carol)).send(first)).status).toBe(409);
    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/api/community/offers').set(auth(carol)).send(offer()).expect(201);
    }
    const sixth = await request(app).post('/api/community/offers').set(auth(carol)).send(offer());
    expect(sixth.status).toBe(429);
  });

  test('profil public : pseudo et ancienneté, sans nom ni e-mail', async () => {
    const res = await request(app).get(`/api/community/members/${aliceUser.username}`).set(auth(bob));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.profile).sort()).toEqual(['member_since', 'published_offers', 'username']);
  });
});
