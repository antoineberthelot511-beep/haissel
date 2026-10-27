/*
 * Notifications Web Push : validation SSRF de l'endpoint, 10 appareils au
 * plus, suppression sur 410, fonctionnalité désactivée sans clés VAPID (le
 * site répond normalement), aucun contenu de message dans la charge utile.
 * PostgreSQL réel (schéma isolé) ; aucun envoi réseau (setSender).
 */
const crypto = require('crypto');
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const push = require('../src/services/push.service');
const { validateSecurityConfig, getVapidConfig } = require('../src/config/security');

const { createUser, login, auth } = helpers;

// Valeurs factices : l'envoi est remplacé, aucune vraie clé n'est utilisée.
const FAKE_VAPID = { VAPID_PUBLIC_KEY: 'cle-publique-factice', VAPID_PRIVATE_KEY: 'cle-privee-factice', VAPID_SUBJECT: 'mailto:equipe@haissel.invalid' };
function setVapid(values) {
  for (const name of Object.keys(FAKE_VAPID)) {
    if (values && values[name] !== undefined) process.env[name] = values[name];
    else delete process.env[name];
  }
}

function keys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}
let n = 0;
const subscription = (host = 'fcm.googleapis.com') => { n += 1; return { endpoint: `https://${host}/fcm/send/appareil-${n}`, keys: keys() }; };

let pool;
let admin;
let adminUser;
let alice;
let aliceUser;
let sent;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  adminUser = await createUser({ admin: true, prefix: 'pushadmin' });
  admin = await login(app, adminUser);
  aliceUser = await createUser({ prefix: 'pushalice' });
  alice = await login(app, aliceUser);
}, 60000);

beforeEach(() => {
  setVapid(FAKE_VAPID);
  sent = [];
  push.setSender(async (sub, payload, options) => { sent.push({ sub, payload, options }); });
});

afterAll(async () => {
  setVapid(null);
  await helpers.teardownDatabase();
});

const countFor = async (userId) => (await pool.query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId])).rows[0].n;

describe('validation de l’abonnement (SSRF)', () => {
  test('liste blanche des services de notification, https uniquement', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QAbc', 'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) expect(push.isAllowedEndpoint(ok)).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com',
      'https://notify.windows.com/x', 'https://evilnotify.windows.com/x', 'https://127.0.0.1/x', 'https://localhost/x',
      'https://169.254.169.254/latest', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x',
      'file:///etc/passwd', 'javascript:alert(1)', '', null, `https://fcm.googleapis.com/${'a'.repeat(2100)}`,
    ]) expect(push.isAllowedEndpoint(bad)).toBe(false);
  });

  test('clés p256dh et auth : longueur et format', () => {
    const good = keys();
    expect(push.isValidKeys(good)).toBe(true);
    expect(push.isValidKeys({ ...good, auth: crypto.randomBytes(8).toString('base64url') })).toBe(false);
    expect(push.isValidKeys({ ...good, p256dh: crypto.randomBytes(65).toString('base64url') })).toBe(false);
    expect(push.isValidKeys({ ...good, p256dh: `${good.p256dh}!` })).toBe(false);
    expect(push.isValidKeys({ ...good, p256dh: 'A'.repeat(500) })).toBe(false);
    expect(push.isValidKeys({})).toBe(false);
  });

  test('POST /api/push/subscribe refuse un hôte hors liste', async () => {
    const res = await request(app).post('/api/push/subscribe').set(auth(alice)).send(subscription('evil.example'));
    expect(res.status).toBe(400);
    expect(await countFor(aliceUser.id)).toBe(0);
  });

  test('sans session ou sans jeton CSRF : refusé', async () => {
    expect((await request(app).post('/api/push/subscribe').send(subscription())).status).toBe(401);
    const res = await request(app).post('/api/push/subscribe').set('Cookie', alice.cookie).send(subscription());
    expect(res.status).toBe(403);
  });
});

describe('abonnements', () => {
  test('10 appareils au plus : le plus ancien est retiré', async () => {
    const user = await createUser({ prefix: 'pushdix' });
    const identity = await login(app, user);
    const subs = [];
    for (let i = 0; i < 11; i += 1) {
      const sub = subscription();
      subs.push(sub);
      const res = await request(app).post('/api/push/subscribe').set(auth(identity)).send(sub);
      expect(res.status).toBe(201);
      await pool.query("UPDATE push_subscriptions SET created_at = NOW() - make_interval(mins => $2) WHERE endpoint = $1", [sub.endpoint, 100 - i]);
    }
    expect(await countFor(user.id)).toBe(10);
    const endpoints = (await pool.query('SELECT endpoint FROM push_subscriptions WHERE user_id = $1', [user.id])).rows.map((r) => r.endpoint);
    expect(endpoints).not.toContain(subs[0].endpoint);
    expect(endpoints).toContain(subs[10].endpoint);
  });

  test('réabonner le même endpoint met à jour, DELETE le retire', async () => {
    const sub = subscription();
    await request(app).post('/api/push/subscribe').set(auth(alice)).set('User-Agent', 'x'.repeat(400)).send(sub).expect(201);
    await request(app).post('/api/push/subscribe').set(auth(alice)).send({ ...sub, keys: keys() }).expect(201);
    const rows = (await pool.query('SELECT user_agent FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])).rows;
    expect(rows).toHaveLength(1);
    const del = await request(app).delete('/api/push/subscribe').set(auth(alice)).send({ endpoint: sub.endpoint });
    expect(del.body.data.removed).toBe(1);
    expect(await countFor(aliceUser.id)).toBe(0);
  });
});

describe('envoi', () => {
  test('404/410 : abonnement supprimé ; autres erreurs : compteur, puis suppression au-delà de 5', async () => {
    const user = await createUser({ prefix: 'pushgone' });
    const identity = await login(app, user);
    const gone = subscription();
    const flaky = subscription();
    await request(app).post('/api/push/subscribe').set(auth(identity)).send(gone).expect(201);
    await request(app).post('/api/push/subscribe').set(auth(identity)).send(flaky).expect(201);
    push.setSender(async (sub) => {
      const error = new Error('refus');
      error.statusCode = sub.endpoint === gone.endpoint ? 410 : 500;
      throw error;
    });
    await push.sendToUser(user.id, { title: 'HAISSEL', body: 'Test' });
    const rows = (await pool.query('SELECT endpoint, failure_count FROM push_subscriptions WHERE user_id = $1', [user.id])).rows;
    expect(rows).toEqual([{ endpoint: flaky.endpoint, failure_count: 1 }]);
    for (let i = 0; i < 5; i += 1) await push.sendToUser(user.id, { title: 'HAISSEL', body: 'Test' });
    expect(await countFor(user.id)).toBe(0);
  });

  test('urgence configurable ; valeur inconnue ramenée à « normal »', async () => {
    const user = await createUser({ prefix: 'pushurg' });
    await push.saveSubscription(user.id, subscription(), 'test');
    await push.sendToUser(user.id, { title: 'HAISSEL', body: 'Test' }, { urgency: 'high' });
    await push.sendToUser(user.id, { title: 'HAISSEL', body: 'Test' }, { urgency: 'immédiate' });
    expect(sent.map((item) => item.options.urgency)).toEqual(['high', 'normal']);
  });

  test('TTL 24 h, urgence normale, plafond de 3 s même si le service ne répond pas', async () => {
    const user = await createUser({ prefix: 'pushlent' });
    await push.saveSubscription(user.id, subscription(), 'test');
    await push.sendToUser(user.id, { title: 'HAISSEL', body: 'Test' });
    expect(sent[0].options).toMatchObject({ TTL: 86400, urgency: 'normal' });
    push.setSender(() => new Promise(() => {}));
    const started = Date.now();
    const outcome = await push.sendToUser(user.id, { title: 'HAISSEL', body: 'Test' });
    expect(outcome.timeout).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test('réponse de l’équipe : charge utile discrète, sans le texte du message', async () => {
    const sub = subscription();
    await request(app).post('/api/push/subscribe').set(auth(alice)).send(sub).expect(201);
    await request(app).post('/api/messages/team').set(auth(alice)).send({ content: 'Bonjour' }).expect(201);
    const conversation = (await pool.query('SELECT id FROM conversations WHERE member_id = $1', [aliceUser.id])).rows[0].id;
    const secret = 'Ton code secret est 4242';
    await request(app).post(`/api/admin/messages/${conversation}`).set(auth(admin)).send({ content: secret }).expect(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].options.urgency).toBe('high');
    expect(sent[0].payload).not.toContain('4242');
    expect(JSON.parse(sent[0].payload)).toEqual({ title: 'HAISSEL', body: 'Nouveau message de l’équipe HAISSEL', url: '/app#messages', tag: 'team-message' });
  });

  test('fiche validée : titre tronqué à 40 caractères, lien interne', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send({
      title: 'Une application très pratique pour réviser ses cours de lycée', url: 'https://www.annonceur.example/push/1',
      campaign_name: 'Campagne push', description: 'Une application pour réviser ses cours, gratuite au téléchargement.',
      category: 'applications', countries: 'FR', expected_action: 'Installer et ouvrir l’application', min_age: null,
      conditions: 'Pas de trafic incité.', rights_confirmed: true,
    });
    expect(res.status).toBe(201);
    sent = [];
    await request(app).post(`/api/admin/community/offers/${res.body.data.offer.id}/moderate`).set(auth(admin)).send({ decision: 'publish' }).expect(200);
    const payload = JSON.parse(sent[0].payload);
    expect(payload.body).toBe('Ta fiche a été validée : Une application très pratique pour révi…');
    expect(payload.url).toBe('/app#profile');
    expect(sent[0].options.urgency).toBe('high');
  });

  test('fiche refusée : urgence haute', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(alice)).send({
      title: 'Une autre application à refuser', url: 'https://www.annonceur.example/push/2',
      campaign_name: 'Campagne refusée', description: 'Une application pour réviser ses cours, gratuite au téléchargement.',
      category: 'applications', countries: 'FR', expected_action: 'Installer et ouvrir l’application', min_age: null,
      conditions: 'Pas de trafic incité.', rights_confirmed: true,
    });
    expect(res.status).toBe(201);
    sent = [];
    await request(app).post(`/api/admin/community/offers/${res.body.data.offer.id}/moderate`).set(auth(admin))
      .send({ decision: 'reject', note: 'Conditions de l’annonceur manquantes.' }).expect(200);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].payload).body).toMatch(/^Ta fiche n’a pas été validée/);
    expect(sent[0].options.urgency).toBe('high');
  });

  test('test de l’admin : urgence haute, résultat lisible avec les codes HTTP, sans endpoint', async () => {
    const ok = subscription();
    const refused = subscription();
    await push.saveSubscription(adminUser.id, ok, 'test');
    await push.saveSubscription(adminUser.id, refused, 'test');
    push.setSender(async (sub, payload, options) => {
      sent.push({ sub, payload, options });
      if (sub.endpoint === refused.endpoint) {
        const error = new Error('refus');
        error.statusCode = 403;
        throw error;
      }
    });
    const res = await request(app).post('/api/admin/push/test').set(auth(admin)).send({}).expect(200);
    expect(sent.every((item) => item.options.urgency === 'high')).toBe(true);
    expect(res.body.data).toMatchObject({ devices: 2, sent: 1, failures: [403] });
    expect(JSON.stringify(res.body)).not.toContain(refused.endpoint);
  });

  test('url externe remplacée par /app', () => {
    for (const url of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      expect(JSON.parse(push.buildPayload({ title: 'x', body: 'y', url })).url).toBe('/app');
    }
  });
});

describe('sans clés VAPID', () => {
  test('aucune erreur bloquante, seulement un avertissement (absentes ou partielles)', () => {
    setVapid(null);
    let check = validateSecurityConfig();
    expect(check.errors).toEqual([]);
    expect(check.warnings.join(' ')).toMatch(/Web Push/);
    expect(getVapidConfig().enabled).toBe(false);
    setVapid({ VAPID_PUBLIC_KEY: 'seule' });
    check = validateSecurityConfig();
    expect(check.errors).toEqual([]);
    expect(check.warnings.join(' ')).toMatch(/ensemble/);
    expect(getVapidConfig().enabled).toBe(false);
  });

  test('le site répond normalement ; push désactivé', async () => {
    setVapid(null);
    expect((await request(app).get('/app')).status).toBe(200);
    expect((await request(app).get('/api/health')).status).toBe(200);
    const config = await request(app).get('/api/push/config').set(auth(alice));
    expect(config.body.data).toEqual({ enabled: false, public_key: null });
    expect((await request(app).post('/api/push/subscribe').set(auth(alice)).send(subscription())).status).toBe(503);
    expect(await push.sendToUser(aliceUser.id, { title: 'x' })).toMatchObject({ skipped: true });
    expect(sent).toHaveLength(0);
  });

  test('avec les clés : clé publique seulement, jamais la privée', async () => {
    const config = await request(app).get('/api/push/config').set(auth(alice));
    expect(config.body.data).toEqual({ enabled: true, public_key: FAKE_VAPID.VAPID_PUBLIC_KEY });
    expect(JSON.stringify(config.body)).not.toContain(FAKE_VAPID.VAPID_PRIVATE_KEY);
  });
});

describe('service worker', () => {
  test('/sw.js : no-cache, Service-Worker-Allowed, aucune mise en cache ni interception', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['service-worker-allowed']).toBe('/');
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toMatch(/addEventListener\('push'/);
    expect(res.text).not.toMatch(/caches\.|addEventListener\('fetch'/);
    expect(res.headers['content-security-policy']).toMatch(/worker-src 'self'/);
  });
});
