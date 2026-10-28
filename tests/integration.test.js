/*
 * Tests d'intégration contre PostgreSQL (schéma isolé, voir helpers/setup.js).
 *
 * Le moteur d'affiliation interne est gelé par défaut : cette suite le teste,
 * donc elle l'active. À poser AVANT require('../src/app'), les routes lisant
 * le drapeau à chaque requête mais la configuration devant être stable pour
 * toute la suite. Voir tests/affiliation-disabled.test.js pour l'état par défaut.
 */
process.env.ENABLE_INTERNAL_AFFILIATION = 'true';

const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const {
  createUser, login, lanHeaders, signWebhook, auth,
} = helpers;

let pool;
let admin;
let adminToken;
let alice;
let aliceToken;
let bob;
let bobToken;
let offer;
let inactiveOffer;
let aliceCode;

const asAdmin = (req) => req.set(auth(adminToken));

function webhook(provider, payload, options) {
  const body = JSON.stringify(payload);
  return request(app)
    .post(`/api/webhooks/affiliate/${provider}`)
    .set(signWebhook(body, options))
    .send(body);
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await createUser({ admin: true, prefix: 'admin' });
  alice = await createUser({ prefix: 'alice' });
  bob = await createUser({ prefix: 'bob' });
  [adminToken, aliceToken, bobToken] = await Promise.all([login(app, admin), login(app, alice), login(app, bob)]);
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

// ===========================================================================
describe('ADMIN access control', () => {
  it('serves the admin page on localhost and refuses it on the LAN', async () => {
    const local = await request(app).get('/');
    expect(local.status).toBe(200);
    expect(local.text).toContain('Connexion administrateur');

    const lan = await request(app).get('/').set(lanHeaders());
    expect(lan.status).toBe(200);
    expect(lan.text).not.toContain('Connexion administrateur');

    for (const path of ['/admin', '/admin.html', '/admin.js', '/admin.css', '/ADMIN.HTML', '/%61dmin.js']) {
      const res = await request(app).get(path).set(lanHeaders());
      expect(res.status).toBe(403);
    }
  });

  it('refuses admin API without token', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('refuses admin API to a normal user (403)', async () => {
    for (const path of ['/api/admin/users', '/api/admin/stats', '/api/admin/overview', '/api/admin/affiliates', '/api/admin/conversions']) {
      const res = await request(app).get(path).set(auth(aliceToken));
      expect(res.status).toBe(403);
    }
    const create = await request(app).post('/api/admin/affiliates')
      .set(auth(aliceToken))
      .send({ name: 'Hack', url: 'https://evil.example' });
    expect(create.status).toBe(403);
  });

  it('refuses admin API from the LAN even with an admin token', async () => {
    const res = await request(app).get('/api/admin/users').set(lanHeaders()).set(auth(adminToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_LOCAL_ONLY');
  });

  it('allows an admin on localhost', async () => {
    const res = await asAdmin(request(app).get('/api/admin/overview'));
    expect(res.status).toBe(200);
    expect(res.body.data.total_users).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
describe('ADMIN management', () => {
  it('creates offers with validation', async () => {
    const bad = await asAdmin(request(app).post('/api/admin/affiliates')).send({ name: 'X', url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);

    const created = await asAdmin(request(app).post('/api/admin/affiliates')).send({
      name: 'Offre <b>test</b>', url: 'https://partner.example/offer?sub={click_id}', description: '<img src=x onerror=alert(1)>',
    });
    expect(created.status).toBe(201);
    offer = created.body.data.offer;
    expect(offer.is_active).toBe(true);
    // Stocké tel quel : l'échappement est fait au rendu (textContent).
    expect(offer.name).toBe('Offre <b>test</b>');

    const second = await asAdmin(request(app).post('/api/admin/affiliates')).send({ name: 'Offre inactive', url: 'https://partner.example/b' });
    inactiveOffer = second.body.data.offer;
    const disabled = await asAdmin(request(app).patch(`/api/admin/affiliates/${inactiveOffer.id}`)).send({ is_active: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.offer.is_active).toBe(false);
  });

  it('searches users and changes their status', async () => {
    const target = await createUser({ prefix: 'target' });
    const targetToken = await login(app, target);

    const search = await asAdmin(request(app).get(`/api/admin/users?search=${target.username}`));
    expect(search.body.data.users).toHaveLength(1);

    const injection = await asAdmin(request(app).get(`/api/admin/users?search=${encodeURIComponent("%' OR 1=1 --")}`));
    expect(injection.status).toBe(200);
    expect(injection.body.data.users).toHaveLength(0);

    const suspend = await asAdmin(request(app).patch(`/api/admin/users/${target.id}/status`)).send({ action: 'suspend' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.data.user.is_active).toBe(false);

    // Les sessions existantes sont révoquées immédiatement.
    const me = await request(app).get('/api/auth/me').set(auth(targetToken));
    expect(me.status).toBe(401);

    const ban = await asAdmin(request(app).patch(`/api/admin/users/${target.id}/status`)).send({ action: 'ban' });
    expect(ban.body.data.user.is_banned).toBe(true);
    const unban = await asAdmin(request(app).patch(`/api/admin/users/${target.id}/status`)).send({ action: 'unban' });
    expect(unban.body.data.user.is_banned).toBe(false);
    const activate = await asAdmin(request(app).patch(`/api/admin/users/${target.id}/status`)).send({ action: 'activate' });
    expect(activate.body.data.user.is_active).toBe(true);

    const log = await asAdmin(request(app).get('/api/admin/actions'));
    expect(log.body.data.items.some((a) => a.action === 'user.status' && a.target_id === target.id)).toBe(true);
  });

  it('prevents an admin from suspending themselves', async () => {
    const res = await asAdmin(request(app).patch(`/api/admin/users/${admin.id}/status`)).send({ action: 'suspend' });
    expect(res.status).toBe(409);
  });

  it('rejects invalid user ids and actions', async () => {
    expect((await asAdmin(request(app).patch('/api/admin/users/abc/status')).send({ action: 'ban' })).status).toBe(400);
    expect((await asAdmin(request(app).patch(`/api/admin/users/${alice.id}/status`)).send({ action: 'delete' })).status).toBe(400);
    expect((await asAdmin(request(app).patch('/api/admin/users/999999/status')).send({ action: 'ban' })).status).toBe(404);
  });
});

// ===========================================================================
describe('AFFILIATE', () => {
  it('lists only active offers, without creating codes', async () => {
    const res = await request(app).get('/api/affiliate/offers').set(auth(aliceToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((item) => item.id);
    expect(ids).toContain(offer.id);
    expect(ids).not.toContain(inactiveOffer.id);
    expect(res.body.data.items.find((i) => i.id === offer.id).code).toBeNull();
    expect(res.body.data.items[0]).not.toHaveProperty('url');
  });

  it('generates one stable personal code per user and offer', async () => {
    const first = await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set(auth(aliceToken));
    expect(first.status).toBe(200);
    expect(first.body.data.code).toMatch(/^HAI-[A-Z2-9]{8}$/);
    aliceCode = first.body.data.code;

    const again = await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set(auth(aliceToken));
    expect(again.body.data.code).toBe(aliceCode);

    const bobLink = await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set(auth(bobToken));
    expect(bobLink.body.data.code).not.toBe(aliceCode);
  });

  it('refuses a link for an inactive offer', async () => {
    const res = await request(app).post(`/api/affiliate/offers/${inactiveOffer.id}/link`).set(auth(aliceToken));
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Cette offre n'est plus disponible.");
  });

  it('records a click server-side and redirects to the offer URL', async () => {
    const res = await request(app).get(`/r/${aliceCode}`).set(lanHeaders('192.168.1.80')).set('User-Agent', 'jest');
    expect(res.status).toBe(302);
    const clicks = await pool.query('SELECT id, user_id, ip_address, ip_hash FROM clicks WHERE user_id = $1', [alice.id]);
    expect(clicks.rows).toHaveLength(1);
    expect(clicks.rows[0].ip_address).toBe('192.168.1.0');
    expect(clicks.rows[0].ip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.headers.location).toBe(`https://partner.example/offer?sub=${clicks.rows[0].id}`);
  });

  it('does not double count repeated clicks from the same visitor', async () => {
    await request(app).get(`/r/${aliceCode}`).set(lanHeaders('192.168.1.80'));
    await request(app).get(`/api/affiliate/${aliceCode.toLowerCase()}`).set(lanHeaders('192.168.1.80'));
    await request(app).get(`/r/${aliceCode}`).set(lanHeaders('192.168.1.81'));
    const clicks = await pool.query('SELECT COUNT(*)::int AS n FROM clicks WHERE user_id = $1', [alice.id]);
    expect(clicks.rows[0].n).toBe(2);
  });

  it('returns a clean 404 for invalid or unknown codes', async () => {
    for (const code of ['HAI-ZZZZZZZZ', "x' OR 1=1--", '%3Cscript%3E']) {
      const res = await request(app).get(`/r/${code}`);
      expect(res.status).toBe(404);
      expect(res.text).toContain("Cette offre n'est plus disponible.");
    }
  });

  it('stops redirecting when the offer is deactivated', async () => {
    const temp = await asAdmin(request(app).post('/api/admin/affiliates')).send({ name: 'Temporaire', url: 'https://partner.example/t' });
    const link = await request(app).post(`/api/affiliate/offers/${temp.body.data.offer.id}/link`).set(auth(bobToken));
    expect((await request(app).get(`/r/${link.body.data.code}`)).status).toBe(302);
    await asAdmin(request(app).patch(`/api/admin/affiliates/${temp.body.data.offer.id}`)).send({ is_active: false });
    expect((await request(app).get(`/r/${link.body.data.code}`)).status).toBe(404);
  });
});

// ===========================================================================
describe('CONVERSIONS & WEBHOOK', () => {
  it('a normal user cannot create a conversion', async () => {
    for (const path of ['/api/affiliate/conversion', '/api/affiliates/conversion', '/api/admin/conversions']) {
      const res = await request(app).post(path)
        .set(auth(aliceToken))
        .send({ code: aliceCode, amount_cents: 999999, external_reference: 'self-credit' });
      expect([403, 404]).toContain(res.status);
    }
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM conversions');
    expect(count.rows[0].n).toBe(0);
  });

  it('rejects unsigned, badly signed or stale webhooks', async () => {
    const payload = { external_reference: 'ORD-1', code: aliceCode, amount_cents: 500, currency: 'EUR', status: 'approved' };
    const body = JSON.stringify(payload);

    const unsigned = await request(app).post('/api/webhooks/affiliate/mylead').set('Content-Type', 'application/json').send(body);
    expect(unsigned.status).toBe(401);

    const wrongSecret = await webhook('mylead', payload, { secret: 'wrong-secret-wrong-secret-wrong-secret-xx' });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body.error.code).toBe('INVALID_SIGNATURE');

    const stale = await webhook('mylead', payload, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('INVALID_TIMESTAMP');

    // Corps modifié après signature
    const headers = signWebhook(body);
    const tampered = await request(app).post('/api/webhooks/affiliate/mylead').set(headers)
      .send(body.replace('500', '50000'));
    expect(tampered.status).toBe(401);

    const count = await pool.query('SELECT COUNT(*)::int AS n FROM conversions');
    expect(count.rows[0].n).toBe(0);
  });

  it('rejects invalid payloads even when correctly signed', async () => {
    const base = { external_reference: 'ORD-X', code: aliceCode, amount_cents: 500, currency: 'EUR' };
    expect((await webhook('mylead', { ...base, amount_cents: -5 })).status).toBe(400);
    expect((await webhook('mylead', { ...base, amount_cents: 10 ** 10 })).status).toBe(400);
    expect((await webhook('mylead', { ...base, currency: 'XXX' })).status).toBe(400);
    expect((await webhook('mylead', { ...base, code: 'HAI-NOPE2345' })).status).toBe(422);
  });

  it('refuses a click_id that belongs to another affiliate', async () => {
    const bobCode = (await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set(auth(bobToken))).body.data.code;
    await request(app).get(`/r/${bobCode}`).set(lanHeaders('192.168.1.90'));
    const bobClick = await pool.query('SELECT id FROM clicks WHERE user_id = $1 LIMIT 1', [bob.id]);

    const res = await webhook('mylead', {
      external_reference: 'ORD-CLICK', code: aliceCode, click_id: bobClick.rows[0].id, amount_cents: 500, currency: 'EUR', status: 'approved',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CLICK_MISMATCH');
  });

  it('a valid approved webhook creates exactly one conversion and one earning', async () => {
    const click = await pool.query('SELECT id FROM clicks WHERE user_id = $1 ORDER BY id LIMIT 1', [alice.id]);
    const payload = {
      external_reference: 'ORD-100', code: aliceCode, click_id: click.rows[0].id, amount_cents: 4250, currency: 'EUR', status: 'approved',
    };

    const first = await webhook('mylead', payload);
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('approved');

    // Même événement reçu deux fois (et en parallèle) : aucun double crédit.
    const [again, concurrent] = await Promise.all([webhook('mylead', payload), webhook('mylead', payload)]);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(concurrent.body.data.conversion_id).toBe(first.body.data.conversion_id);

    const conversions = await pool.query("SELECT COUNT(*)::int AS n FROM conversions WHERE external_reference = 'ORD-100'");
    const earnings = await pool.query('SELECT amount_cents, status FROM earnings WHERE conversion_id = $1', [first.body.data.conversion_id]);
    expect(conversions.rows[0].n).toBe(1);
    expect(earnings.rows).toEqual([{ amount_cents: 4250, status: 'pending' }]);
  });

  it('refuses to reuse an external reference with a different amount', async () => {
    const res = await webhook('mylead', {
      external_reference: 'ORD-100', code: aliceCode, amount_cents: 999999, currency: 'EUR', status: 'approved',
    });
    expect(res.status).toBe(409);
  });

  it('a pending then rejected conversion never produces an active earning', async () => {
    const payload = { external_reference: 'ORD-200', code: aliceCode, amount_cents: 1000, currency: 'EUR', status: 'pending' };
    const pending = await webhook('mylead', payload);
    expect(pending.status).toBe(201);
    let earnings = await pool.query('SELECT * FROM earnings WHERE conversion_id = $1', [pending.body.data.conversion_id]);
    expect(earnings.rows).toHaveLength(0);

    const rejected = await webhook('mylead', { ...payload, status: 'rejected' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    earnings = await pool.query('SELECT * FROM earnings WHERE conversion_id = $1', [pending.body.data.conversion_id]);
    expect(earnings.rows).toHaveLength(0);

    // Statut final : impossible de repasser en approved.
    const reapprove = await webhook('mylead', { ...payload, status: 'approved' });
    expect(reapprove.status).toBe(409);
  });

  it('admin can approve a pending conversion, pay it, and cannot cancel it once paid', async () => {
    const pending = await webhook('mylead', {
      external_reference: 'ORD-300', code: aliceCode, amount_cents: 750, currency: 'EUR', status: 'pending',
    });
    const id = pending.body.data.conversion_id;

    const approve = await asAdmin(request(app).patch(`/api/admin/conversions/${id}/status`)).send({ status: 'approved' });
    expect(approve.status).toBe(200);

    const list = await asAdmin(request(app).get('/api/admin/earnings?status=pending'));
    const earning = list.body.data.items.find((e) => e.conversion_id === id);
    expect(earning.amount_cents).toBe(750);

    const paid = await asAdmin(request(app).patch(`/api/admin/earnings/${earning.id}/pay`));
    expect(paid.status).toBe(200);
    expect(paid.body.data.earning.paid_at).toBeTruthy();
    expect((await asAdmin(request(app).patch(`/api/admin/earnings/${earning.id}/pay`))).status).toBe(409);

    const cancel = await asAdmin(request(app).patch(`/api/admin/conversions/${id}/status`)).send({ status: 'cancelled' });
    expect(cancel.status).toBe(409);
  });

  it('admin manual entry is idempotent and filterable', async () => {
    const payload = { code: aliceCode, external_reference: 'MAIL-1', amount_cents: 300, currency: 'EUR', status: 'pending' };
    const first = await asAdmin(request(app).post('/api/admin/conversions')).send(payload);
    const second = await asAdmin(request(app).post('/api/admin/conversions')).send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.created).toBe(false);

    const filtered = await asAdmin(request(app).get(`/api/admin/conversions?status=pending&offer_id=${offer.id}&user=${alice.username}`));
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.items.map((c) => c.external_reference)).toEqual(['MAIL-1']);
  });
});

// ===========================================================================
describe('STATS', () => {
  it('user stats match the source tables', async () => {
    const res = await request(app).get('/api/affiliate/stats').set(auth(aliceToken));
    expect(res.status).toBe(200);
    const stats = res.body.data;

    // 2 clics ; conversions approuvées : ORD-100 (4250) + ORD-300 (750, payée)
    expect(stats.total_clicks).toBe(2);
    expect(stats.total_conversions).toBe(2);
    expect(stats.pending_conversions).toBe(1); // MAIL-1
    expect(stats.total_earnings).toBe(5000);
    expect(stats.paid_earnings).toBe(750);
    expect(stats.conversion_rate).toBe(100);

    const offers = await request(app).get('/api/affiliate/offers').set(auth(aliceToken));
    const item = offers.body.data.items.find((i) => i.id === offer.id);
    expect(item).toMatchObject({ code: aliceCode, total_clicks: 2, total_conversions: 2, total_amount_cents: 5000 });

    const mine = await request(app).get('/api/affiliate/conversions').set(auth(aliceToken));
    expect(mine.body.data.items).toHaveLength(4);
  });

  it('rates are 0 % without conversions or without clicks', async () => {
    const bobStats = await request(app).get('/api/affiliate/stats').set(auth(bobToken));
    expect(bobStats.body.data.total_clicks).toBeGreaterThan(0);
    expect(bobStats.body.data.total_conversions).toBe(0);
    expect(bobStats.body.data.conversion_rate).toBe(0);

    const fresh = await createUser();
    const freshStats = await request(app).get('/api/affiliate/stats').set(auth(await login(app, fresh)));
    expect(freshStats.body.data).toMatchObject({ total_clicks: 0, total_conversions: 0, total_earnings: 0, conversion_rate: 0 });
  });

  it('admin overview reflects real data', async () => {
    const res = await asAdmin(request(app).get('/api/admin/overview'));
    const data = res.body.data;
    const clicks = await pool.query('SELECT COUNT(*)::int AS n FROM clicks');
    expect(data.total_clicks).toBe(clicks.rows[0].n);
    expect(data.total_conversions).toBe(2);
    expect(data.total_earnings_cents).toBe(5000);
    expect(data.pending_earnings_cents).toBe(4250);
    expect(data.paid_earnings_cents).toBe(750);
    expect(data.active_offers).toBe(1);
  });
});

// ===========================================================================
describe('ADMIN ACCOUNT LOCAL-ONLY', () => {
  it('refuses an admin login from the LAN', async () => {
    const res = await request(app).post('/api/auth/login').set(lanHeaders())
      .send({ identifier: admin.email, password: 'Password123!' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_LOCAL_ONLY');
    expect(res.body.data).toBeUndefined();
  });

  it('refuses an admin token used from the LAN on any route', async () => {
    const res = await request(app).get('/api/auth/me').set(lanHeaders()).set(auth(adminToken));
    expect(res.status).toBe(403);
  });

  it('still lets normal users log in from the LAN', async () => {
    const res = await request(app).post('/api/auth/login').set(lanHeaders())
      .send({ identifier: alice.username, password: 'Password123!' });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
describe('LINKS (admin publishes, users click)', () => {
  let link;

  it('lists active links with a /go URL for logged-in users only', async () => {
    const created = await asAdmin(request(app).post('/api/admin/affiliates')).send({ name: 'Lien simple', url: 'https://site.example/page' });
    link = created.body.data.offer;

    expect((await request(app).get('/api/links')).status).toBe(401);

    const res = await request(app).get('/api/links').set(lanHeaders()).set(auth(aliceToken));
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((i) => i.id === link.id);
    expect(item).toMatchObject({ name: 'Lien simple', domain: 'site.example' });
    expect(item.go_url).toBe(`/go/${link.id}`);
    expect(res.body.data.items.map((i) => i.id)).not.toContain(inactiveOffer.id);
  });

  it('counts the click server-side and redirects; a double-click counts once', async () => {
    const res = await request(app).get('/api/links').set(auth(bobToken));
    const { go_url: goUrl } = res.body.data.items.find((i) => i.id === link.id);

    // La navigation envoie le cookie de session (SameSite=Lax).
    const first = await request(app).get(goUrl).set(lanHeaders('192.168.1.120')).set('Cookie', bobToken.cookie);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('https://site.example/page');
    await request(app).get(goUrl).set(lanHeaders('192.168.1.120')).set('Cookie', bobToken.cookie);

    const clicks = await pool.query('SELECT user_id FROM clicks WHERE affiliate_link_id = $1', [link.id]);
    expect(clicks.rows).toEqual([{ user_id: bob.id }]);

    const admins = await asAdmin(request(app).get('/api/admin/affiliates'));
    expect(admins.body.data.items.find((o) => o.id === link.id)).toMatchObject({ total_clicks: 1, unique_clickers: 1 });
  });

  it('does not count clicks without a valid session', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM clicks')).rows[0].n;
    for (const cookie of [null, 'haissel_sid=forged', `haissel_sid=${'A'.repeat(43)}`]) {
      const req = request(app).get(`/go/${link.id}`);
      if (cookie) req.set('Cookie', cookie);
      const out = await req;
      expect(out.status).toBe(302);
      expect(out.headers.location).toBe('/');
    }
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM clicks')).rows[0].n).toBe(before);
  });

  it('stops working when the admin hides the link', async () => {
    const res = await request(app).get('/api/links').set(auth(aliceToken));
    const { go_url: goUrl } = res.body.data.items.find((i) => i.id === link.id);
    await asAdmin(request(app).patch(`/api/admin/affiliates/${link.id}`)).send({ is_active: false });
    expect((await request(app).get(goUrl).set('Cookie', aliceToken.cookie)).status).toBe(404);
  });
});

// ===========================================================================
describe('MISC', () => {
  it('health check reports database and schema', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'connected', schema: 'ok' });
  });

  it('does not leak internals on malformed JSON', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Requête invalide.');
  });

  it('does not send permissive CORS headers', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a CSP without upgrade-insecure-requests (LAN over HTTP)', async () => {
    const res = await request(app).get('/').set(lanHeaders());
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('rate limits repeated failed logins', async () => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
    try {
      // Limite relevée à 30 échecs / 15 min (réseaux partagés, voir README).
      const statuses = [];
      for (let i = 0; i < 40; i += 1) {
        const res = await request(app).post('/api/auth/login').set(lanHeaders('192.168.1.222'))
          .send({ identifier: `nobody${i}`, password: 'wrong-password' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    } finally {
      process.env.RATE_LIMIT_IN_TESTS = 'false';
    }
  });
});

describe('ADMIN network link', () => {
  it('returns the current LAN address(es) to the local admin only', async () => {
    const res = await asAdmin(request(app).get('/api/admin/network'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.addresses)).toBe(true);
    for (const a of res.body.data.addresses) {
      expect(a.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?$/);
      expect(a.address).not.toMatch(/^127\./);
    }
    expect((await request(app).get('/api/admin/network').set(auth(aliceToken))).status).toBe(403);
    expect((await request(app).get('/api/admin/network').set(lanHeaders()).set(auth(adminToken))).status).toBe(403);
  });
});
