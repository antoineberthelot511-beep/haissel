/*
 * Conformité mineurs : badge « Lien affilié » sur toutes les offres de
 * l'équipe, profils privés par défaut, réglage « Profil visible par les
 * membres », aucun profilage.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const helpers = require('./helpers/setup');

const { app } = require('../src/app');

const { createUser, login, auth } = helpers;
const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const appJs = read('app.js');
let pool;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

async function publishedOffer(userId, kind = 'campaign') {
  const { rows } = await pool.query(
    `INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action,
                                rights_confirmed_at, status, published_at, kind)
     VALUES ($1, 'Fiche visible', 'https://exemple.fr/offre', 'Une description assez longue pour passer.',
             'applications', 'FR', 'Installer l’application', NOW(), 'published', NOW(), $2)
     RETURNING id`,
    [userId, kind]
  );
  return rows[0].id;
}

describe('profils privés par défaut', () => {
  let owner;
  let other;
  let ownerId;

  beforeAll(async () => {
    const created = await createUser({ prefix: 'privowner', adult: true });
    ownerId = created.id;
    await publishedOffer(created.id);
    owner = { user: created, session: await login(app, created) };
    const visitor = await createUser({ prefix: 'privother' });
    other = await login(app, visitor);
  });

  test('migration : profile_public faux par défaut', async () => {
    const { rows } = await pool.query('SELECT profile_public FROM users WHERE id = $1', [ownerId]);
    expect(rows[0].profile_public).toBe(false);
    const me = await request(app).get('/api/auth/me').set(auth(owner.session));
    expect(me.body.data.user.profile_public).toBe(false);
  });

  test('un autre membre : 403 sur le profil et sur la grille', async () => {
    const profile = await request(app).get(`/api/community/members/${owner.user.username}`).set(auth(other));
    expect(profile.status).toBe(403);
    expect(profile.body.error.code).toBe('PROFILE_PRIVATE');
    const grid = await request(app).get(`/api/community/offers?author=${owner.user.username}`).set(auth(other));
    expect(grid.status).toBe(403);
  });

  test('les fiches publiées restent dans le fil, avec seulement le pseudo', async () => {
    const feed = await request(app).get('/api/community/offers').set(auth(other));
    expect(feed.status).toBe(200);
    const mine = feed.body.data.items.filter((o) => o.author.username === owner.user.username);
    expect(mine.length).toBeGreaterThan(0);
    expect(Object.keys(mine[0].author)).toEqual(['username']);
  });

  test('le membre lui-même et l’équipe le voient', async () => {
    expect((await request(app).get(`/api/community/members/${owner.user.username}`).set(auth(owner.session))).status).toBe(200);
    const admin = await login(app, await createUser({ admin: true, prefix: 'privadmin' }));
    expect((await request(app).get(`/api/community/members/${owner.user.username}`).set(auth(admin))).status).toBe(200);
    expect((await request(app).get(`/api/community/offers?author=${owner.user.username}`).set(auth(admin))).status).toBe(200);
  });

  test('option « Profil visible par les membres » : activation puis désactivation', async () => {
    const bad = await request(app).post('/api/auth/me/profile-visibility').set(auth(owner.session)).send({ public: 'oui' });
    expect(bad.status).toBe(400);
    const on = await request(app).post('/api/auth/me/profile-visibility').set(auth(owner.session)).send({ public: true });
    expect(on.status).toBe(200);
    expect(on.body.data.profile_public).toBe(true);
    const visible = await request(app).get(`/api/community/members/${owner.user.username}`).set(auth(other));
    expect(visible.status).toBe(200);
    expect(Object.keys(visible.body.data.profile).sort()).toEqual(['member_since', 'published_offers', 'username']);
    expect((await request(app).get(`/api/community/offers?author=${owner.user.username}`).set(auth(other))).status).toBe(200);

    await request(app).post('/api/auth/me/profile-visibility').set(auth(owner.session)).send({ public: false });
    expect((await request(app).get(`/api/community/members/${owner.user.username}`).set(auth(other))).status).toBe(403);
  });

  test('sans session : refusé', async () => {
    expect((await request(app).post('/api/auth/me/profile-visibility').send({ public: true })).status).toBe(401);
  });

  test('Réglages : interrupteur désactivé par défaut, message de profil privé', () => {
    const html = read('index.html');
    expect(html).toMatch(/<label class="setting-label" for="profile-public-switch">Profil visible par les membres<\/label>/);
    expect(html).toMatch(/<input id="profile-public-switch" class="ios-switch" type="checkbox" role="switch"[^>]*\/>/);
    expect(html).not.toMatch(/id="profile-public-switch"[^>]*checked/);
    expect(appJs).toContain("toggle.checked = Boolean(state.user.profile_public);");
    expect(appJs).toContain("if (error.status === 403) {");
  });
});

describe('badge des offres', () => {
  test('« Lien affilié » + « En savoir plus » (transparence.html) ; fiches membres : « Fiche membre · lien officiel »', () => {
    const badge = appJs.slice(appJs.indexOf('function kindBadge('), appJs.indexOf('function communityCard('));
    expect(badge).toContain("'Lien affilié'");
    expect(badge).toContain("h('a', { className: 'kind-more', href: 'transparence.html' }, 'En savoir plus')");
    expect(badge).toContain("'Fiche membre · lien officiel'");
    // Le badge affilié est le cas par défaut : toute offre qui n'est pas une fiche membre l'affiche.
    expect(badge).toMatch(/if \(offer\.kind === 'campaign'\) \{[\s\S]*?return[\s\S]*?\}\s*return h\('span', \{ className: 'kind-badge' \},\s*h\('span', \{ className: 'pill ad'/);
  });

  test('présent sur la carte du fil, Découvrir, le lecteur de stories et la page de l’offre', () => {
    for (const fn of ['function postCard(', 'function discoverSlide(', 'function communityCard(', 'function offerDetail(', 'function storyFace(']) {
      const start = appJs.indexOf(fn);
      const body = appJs.slice(start, appJs.indexOf('\n}\n', start));
      expect([fn, body.includes('kindBadge(offer)')]).toEqual([fn, true]);
    }
  });

  test('chaque offre affiliate reçue porte kind = affiliate (le badge en dépend)', async () => {
    const admin = await createUser({ admin: true, prefix: 'badgeadmin' });
    await publishedOffer(admin.id, 'affiliate');
    const member = await login(app, await createUser({ prefix: 'badgeviewer', adult: true }));
    const feed = await request(app).get('/api/community/offers?kind=affiliate').set(auth(member));
    expect(feed.body.data.items.length).toBeGreaterThan(0);
    for (const offer of feed.body.data.items) expect(offer.kind).toBe('affiliate');
  });
});

describe('aucun profilage', () => {
  test('le classement du fil n’utilise aucune donnée du membre', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/controllers/community.controller.js'), 'utf8');
    const list = source.slice(source.indexOf('async function listOffers('), source.indexOf('async function listMyOffers(') > 0 ? source.indexOf('async function listMyOffers(') : undefined);
    const order = list.slice(list.indexOf('ORDER BY'), list.indexOf('LIMIT $7'));
    expect(order).not.toMatch(/\$1|user_id|is_adult|created_at\s*-|u\.\w+/);
    expect(appJs).not.toMatch(/pour toi|for_you|forYou/i);
  });

  test('page Confidentialité', () => {
    expect(read('confidentialite.html')).toContain('HAISSEL ne fait aucun profilage publicitaire');
    expect(read('confidentialite.html')).toContain('privé par défaut');
  });
});
