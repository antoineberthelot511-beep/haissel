/*
 * Tests d'intégration contre PostgreSQL (schéma isolé, voir helpers/setup.js).
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');

const {
  createUser, login, lanHeaders, signWebhook,
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

const asAdmin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

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
describe('AUTH', () => {
  it('registers, returns a token and never the password hash', async () => {
    const res = await request(app).post('/api/auth/register').send({
      username: 'new_user', email: 'new_user@exemple.fr', password: 'Password123!', confirm_password: 'Password123!', first_name: 'Nouvel', last_name: 'Utilisateur',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user.role).toBe('USER');
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$2[aby]\$/);

    const stored = await pool.query("SELECT password_hash FROM users WHERE username = 'new_user'");
    expect(stored.rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('refuses duplicates and invalid input', async () => {
    const dup = await request(app).post('/api/auth/register').send({
      username: 'new_user', email: 'other@exemple.fr', password: 'Password123!', confirm_password: 'Password123!',
    });
    expect(dup.status).toBe(409);

    const badUser = await request(app).post('/api/auth/register').send({
      username: "x'; DROP TABLE users;--", email: 'a@exemple.fr', password: 'Password123!', confirm_password: 'Password123!',
    });
    expect(badUser.status).toBe(400);
    expect(badUser.body.error.code).toBe('INVALID_USERNAME');

    const badEmail = await request(app).post('/api/auth/register').send({
      username: 'valid_name', email: 'not-an-email', password: 'Password123!', confirm_password: 'Password123!',
    });
    expect(badEmail.body.error.code).toBe('INVALID_EMAIL');

    const shortPwd = await request(app).post('/api/auth/register').send({
      username: 'valid_name', email: 'valid@exemple.fr', password: 'short', confirm_password: 'short',
    });
    expect(shortPwd.body.error.code).toBe('INVALID_PASSWORD');
  });

  it('logs in and serves /me with the role from the database', async () => {
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${aliceToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.username).toBe(alice.username);
    expect(me.body.data.user.role).toBe('USER');

    const adminMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
    expect(adminMe.body.data.user.role).toBe('ADMIN');
  });

  it('rejects a wrong password with a clean message', async () => {
    const res = await request(app).post('/api/auth/login').send({ identifier: alice.username, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Identifiants incorrects.');
  });

  it('refuses banned and suspended accounts', async () => {
    const banned = await createUser({ banned: true });
    const suspended = await createUser({ active: false });

    const resBanned = await request(app).post('/api/auth/login').send({ identifier: banned.username, password: 'Password123!' });
    expect(resBanned.status).toBe(403);
    expect(resBanned.body.error.code).toBe('ACCOUNT_BANNED');

    const resSuspended = await request(app).post('/api/auth/login').send({ identifier: suspended.email, password: 'Password123!' });
    expect(resSuspended.status).toBe(403);
    expect(resSuspended.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('revokes the session on logout', async () => {
    const user = await createUser();
    const token = await login(app, user);
    const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(out.status).toBe(200);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(401);
  });

  it('rejects invalid, forged and expired JWTs', async () => {
    const garbage = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);

    const forged = jwt.sign({ sub: String(admin.id) }, 'another-secret-another-secret-another-secret');
    const resForged = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(resForged.status).toBe(401);

    // Signé avec le bon secret mais sans session en base : refusé.
    const sessionless = jwt.sign({ sub: String(admin.id), jti: 'x' }, process.env.JWT_SECRET, { expiresIn: 60 });
    const resSessionless = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${sessionless}`);
    expect(resSessionless.status).toBe(401);

    const expired = jwt.sign({ sub: String(admin.id), exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
    const resExpired = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(resExpired.status).toBe(401);

    const none = await request(app).get('/api/auth/me');
    expect(none.status).toBe(401);
  });
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
      const res = await request(app).get(path).set('Authorization', `Bearer ${aliceToken}`);
      expect(res.status).toBe(403);
    }
    const create = await request(app).post('/api/admin/affiliates')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 'Hack', url: 'https://evil.example' });
    expect(create.status).toBe(403);
  });

  it('refuses admin API from the LAN even with an admin token', async () => {
    const res = await request(app).get('/api/admin/users').set(lanHeaders()).set('Authorization', `Bearer ${adminToken}`);
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
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${targetToken}`);
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
    const res = await request(app).get('/api/affiliate/offers').set('Authorization', `Bearer ${aliceToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((item) => item.id);
    expect(ids).toContain(offer.id);
    expect(ids).not.toContain(inactiveOffer.id);
    expect(res.body.data.items.find((i) => i.id === offer.id).code).toBeNull();
    expect(res.body.data.items[0]).not.toHaveProperty('url');
  });

  it('generates one stable personal code per user and offer', async () => {
    const first = await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set('Authorization', `Bearer ${aliceToken}`);
    expect(first.status).toBe(200);
    expect(first.body.data.code).toMatch(/^HAI-[A-Z2-9]{8}$/);
    aliceCode = first.body.data.code;

    const again = await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set('Authorization', `Bearer ${aliceToken}`);
    expect(again.body.data.code).toBe(aliceCode);

    const bobLink = await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set('Authorization', `Bearer ${bobToken}`);
    expect(bobLink.body.data.code).not.toBe(aliceCode);
  });

  it('refuses a link for an inactive offer', async () => {
    const res = await request(app).post(`/api/affiliate/offers/${inactiveOffer.id}/link`).set('Authorization', `Bearer ${aliceToken}`);
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
    const link = await request(app).post(`/api/affiliate/offers/${temp.body.data.offer.id}/link`).set('Authorization', `Bearer ${bobToken}`);
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
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ code: aliceCode, amount_cents: 999999, external_reference: 'self-credit' });
      expect([403, 404]).toContain(res.status);
    }
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM conversions');
    expect(count.rows[0].n).toBe(0);
  });

  it('rejects unsigned, badly signed or stale webhooks', async () => {
    const payload = { external_reference: 'ORD-1', code: aliceCode, amount_cents: 500, currency: 'EUR', status: 'approved' };
    const body = JSON.stringify(payload);

    const unsigned = await request(app).post('/api/webhooks/affiliate/partner').set('Content-Type', 'application/json').send(body);
    expect(unsigned.status).toBe(401);

    const wrongSecret = await webhook('partner', payload, { secret: 'wrong-secret-wrong-secret-wrong-secret-xx' });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body.error.code).toBe('INVALID_SIGNATURE');

    const stale = await webhook('partner', payload, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('INVALID_TIMESTAMP');

    // Corps modifié après signature
    const headers = signWebhook(body);
    const tampered = await request(app).post('/api/webhooks/affiliate/partner').set(headers)
      .send(body.replace('500', '50000'));
    expect(tampered.status).toBe(401);

    const count = await pool.query('SELECT COUNT(*)::int AS n FROM conversions');
    expect(count.rows[0].n).toBe(0);
  });

  it('rejects invalid payloads even when correctly signed', async () => {
    const base = { external_reference: 'ORD-X', code: aliceCode, amount_cents: 500, currency: 'EUR' };
    expect((await webhook('partner', { ...base, amount_cents: -5 })).status).toBe(400);
    expect((await webhook('partner', { ...base, amount_cents: 10 ** 10 })).status).toBe(400);
    expect((await webhook('partner', { ...base, currency: 'XXX' })).status).toBe(400);
    expect((await webhook('partner', { ...base, code: 'HAI-NOPE2345' })).status).toBe(422);
  });

  it('refuses a click_id that belongs to another affiliate', async () => {
    const bobCode = (await request(app).post(`/api/affiliate/offers/${offer.id}/link`).set('Authorization', `Bearer ${bobToken}`)).body.data.code;
    await request(app).get(`/r/${bobCode}`).set(lanHeaders('192.168.1.90'));
    const bobClick = await pool.query('SELECT id FROM clicks WHERE user_id = $1 LIMIT 1', [bob.id]);

    const res = await webhook('partner', {
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

    const first = await webhook('partner', payload);
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('approved');

    // Même événement reçu deux fois (et en parallèle) : aucun double crédit.
    const [again, concurrent] = await Promise.all([webhook('partner', payload), webhook('partner', payload)]);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(concurrent.body.data.conversion_id).toBe(first.body.data.conversion_id);

    const conversions = await pool.query("SELECT COUNT(*)::int AS n FROM conversions WHERE external_reference = 'ORD-100'");
    const earnings = await pool.query('SELECT amount_cents, status FROM earnings WHERE conversion_id = $1', [first.body.data.conversion_id]);
    expect(conversions.rows[0].n).toBe(1);
    expect(earnings.rows).toEqual([{ amount_cents: 4250, status: 'pending' }]);
  });

  it('refuses to reuse an external reference with a different amount', async () => {
    const res = await webhook('partner', {
      external_reference: 'ORD-100', code: aliceCode, amount_cents: 999999, currency: 'EUR', status: 'approved',
    });
    expect(res.status).toBe(409);
  });

  it('a pending then rejected conversion never produces an active earning', async () => {
    const payload = { external_reference: 'ORD-200', code: aliceCode, amount_cents: 1000, currency: 'EUR', status: 'pending' };
    const pending = await webhook('partner', payload);
    expect(pending.status).toBe(201);
    let earnings = await pool.query('SELECT * FROM earnings WHERE conversion_id = $1', [pending.body.data.conversion_id]);
    expect(earnings.rows).toHaveLength(0);

    const rejected = await webhook('partner', { ...payload, status: 'rejected' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    earnings = await pool.query('SELECT * FROM earnings WHERE conversion_id = $1', [pending.body.data.conversion_id]);
    expect(earnings.rows).toHaveLength(0);

    // Statut final : impossible de repasser en approved.
    const reapprove = await webhook('partner', { ...payload, status: 'approved' });
    expect(reapprove.status).toBe(409);
  });

  it('admin can approve a pending conversion, pay it, and cannot cancel it once paid', async () => {
    const pending = await webhook('partner', {
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
    const res = await request(app).get('/api/affiliate/stats').set('Authorization', `Bearer ${aliceToken}`);
    expect(res.status).toBe(200);
    const stats = res.body.data;

    // 2 clics ; conversions approuvées : ORD-100 (4250) + ORD-300 (750, payée)
    expect(stats.total_clicks).toBe(2);
    expect(stats.total_conversions).toBe(2);
    expect(stats.pending_conversions).toBe(1); // MAIL-1
    expect(stats.total_earnings).toBe(5000);
    expect(stats.paid_earnings).toBe(750);
    expect(stats.conversion_rate).toBe(100);

    const offers = await request(app).get('/api/affiliate/offers').set('Authorization', `Bearer ${aliceToken}`);
    const item = offers.body.data.items.find((i) => i.id === offer.id);
    expect(item).toMatchObject({ code: aliceCode, total_clicks: 2, total_conversions: 2, total_amount_cents: 5000 });

    const mine = await request(app).get('/api/affiliate/conversions').set('Authorization', `Bearer ${aliceToken}`);
    expect(mine.body.data.items).toHaveLength(4);
  });

  it('rates are 0 % without conversions or without clicks', async () => {
    const bobStats = await request(app).get('/api/affiliate/stats').set('Authorization', `Bearer ${bobToken}`);
    expect(bobStats.body.data.total_clicks).toBeGreaterThan(0);
    expect(bobStats.body.data.total_conversions).toBe(0);
    expect(bobStats.body.data.conversion_rate).toBe(0);

    const fresh = await createUser();
    const freshStats = await request(app).get('/api/affiliate/stats').set('Authorization', `Bearer ${await login(app, fresh)}`);
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
describe('MISC', () => {
  it('health check reports database and schema', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'connected', schema: 'ok' });
  });

  it('legacy social API is disabled by default', async () => {
    expect((await request(app).get('/api/posts')).status).toBe(404);
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
      const statuses = [];
      for (let i = 0; i < 12; i += 1) {
        const res = await request(app).post('/api/auth/login').set(lanHeaders('192.168.1.222'))
          .send({ identifier: 'nobody', password: 'wrong-password' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    } finally {
      process.env.RATE_LIMIT_IN_TESTS = 'false';
    }
  });
});
