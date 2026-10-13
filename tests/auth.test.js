/*
 * Tests de sécurité de l'authentification (PostgreSQL réel, schéma isolé).
 * Les e-mails sont capturés en mémoire (MAIL_TRANSPORT=memory).
 */
const helpers = require('./helpers/setup');

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../src/app');
const { outbox } = require('../src/services/mail.service');
const mfa = require('../src/services/mfa.service');
const throttle = require('../src/utils/login-throttle');

const {
  createUser, login, auth, lanHeaders, extractCookie, totpFor, PASSWORD,
} = helpers;

let pool;

const NEW_PASSWORD = 'une phrase de passe tres longue';

function lastMailTo(email) {
  return [...outbox].reverse().find((message) => message.to === email);
}

function tokenFrom(message, kind) {
  const match = new RegExp(`#${kind}=([A-Za-z0-9_-]{43})`).exec(message.text);
  return match ? match[1] : null;
}

function registration(overrides = {}) {
  const id = Math.random().toString(36).slice(2, 8);
  return {
    first_name: 'Camille',
    last_name: 'Martin',
    username: `camille_${id}`,
    email: `camille.${id}@exemple.fr`,
    password: NEW_PASSWORD,
    confirm_password: NEW_PASSWORD,
    ...overrides,
  };
}

async function registerAndVerify(body = registration()) {
  const res = await request(app).post('/api/auth/register').send(body);
  expect(res.status).toBe(202);
  const token = tokenFrom(lastMailTo(body.email), 'verify');
  const verified = await request(app).post('/api/auth/email/verify').send({ token });
  expect(verified.status).toBe(200);
  return body;
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

beforeEach(() => throttle.reset());

// ===========================================================================
describe('Inscription', () => {
  it('1. inscription valide : Argon2id, aucun hash renvoyé, e-mail de vérification', async () => {
    const body = registration();
    const res = await request(app).post('/api/auth/register').send(body);
    expect(res.status).toBe(202);
    expect(res.body.data.verification_required).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/password|\$argon2|\$2[aby]\$/);
    expect(res.headers['set-cookie']).toBeUndefined();

    const stored = await pool.query('SELECT password_hash, first_name, last_name, email_verified_at FROM users WHERE email = $1', [body.email]);
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stored.rows[0]).toMatchObject({ first_name: 'Camille', last_name: 'Martin', email_verified_at: null });
    expect(tokenFrom(lastMailTo(body.email), 'verify')).toBeTruthy();
  });

  it('2. e-mail déjà utilisé : aucun second compte, réponse neutre', async () => {
    const first = registration();
    await request(app).post('/api/auth/register').send(first);
    const dup = await request(app).post('/api/auth/register').send(registration({ email: first.email.toUpperCase() }));
    expect(dup.status).toBe(202); // identique à un succès : l'adresse n'est pas révélée
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = LOWER($1)', [first.email]);
    expect(count.rows[0].n).toBe(1);
  });

  it('3. pseudo déjà utilisé : refus', async () => {
    const first = registration();
    await request(app).post('/api/auth/register').send(first);
    const dup = await request(app).post('/api/auth/register').send(registration({ username: first.username }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('Ce pseudo est déjà pris.');
  });

  it('pas de doublon en cas de requêtes simultanées', async () => {
    const body = registration();
    const results = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/auth/register').send(body)));
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE username = $1', [body.username]);
    expect(count.rows[0].n).toBe(1);
  });

  it.each([
    ['pseudo avec @', { username: 'camille@x' }, 'INVALID_USERNAME'],
    ['injection SQL dans le pseudo', { username: "x'; DROP TABLE users;--" }, 'INVALID_USERNAME'],
    ['e-mail malformé', { email: 'pas-un-email' }, 'INVALID_EMAIL'],
    ['prénom vide', { first_name: '' }, 'INVALID_NAME'],
    ['mot de passe trop court', { password: 'court', confirm_password: 'court' }, 'WEAK_PASSWORD'],
    ['mot de passe courant', { password: 'motdepasse123', confirm_password: 'motdepasse123' }, 'WEAK_PASSWORD'],
    ['mot de passe énorme', { password: 'a'.repeat(5000), confirm_password: 'a'.repeat(5000) }, 'WEAK_PASSWORD'],
    ['confirmation différente', { confirm_password: 'autre chose encore' }, 'PASSWORD_MISMATCH'],
  ])('refuse : %s', async (_label, override, code) => {
    const res = await request(app).post('/api/auth/register').send(registration(override));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  it('refuse un mot de passe contenant le pseudo', async () => {
    const res = await request(app).post('/api/auth/register')
      .send(registration({ username: 'dominique', password: 'dominique-2026!', confirm_password: 'dominique-2026!' }));
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });
});

// ===========================================================================
describe('Vérification d’e-mail', () => {
  it('7. compte non vérifié : connexion refusée après mot de passe correct', async () => {
    const body = registration();
    await request(app).post('/api/auth/register').send(body);
    const res = await request(app).post('/api/auth/login').send({ identifier: body.email, password: body.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('13. le jeton de vérification est à usage unique', async () => {
    const body = registration();
    await request(app).post('/api/auth/register').send(body);
    const token = tokenFrom(lastMailTo(body.email), 'verify');
    expect((await request(app).post('/api/auth/email/verify').send({ token })).status).toBe(200);
    const reuse = await request(app).post('/api/auth/email/verify').send({ token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');
    // Le jeton n'est stocké que sous forme de hash.
    const stored = await pool.query('SELECT token_hash FROM auth_tokens WHERE token_hash = $1', [token]);
    expect(stored.rows).toHaveLength(0);
  });

  it('renvoi du lien : réponse neutre que le compte existe ou non', async () => {
    const unknown = await request(app).post('/api/auth/email/resend').send({ email: 'personne@exemple.fr' });
    const body = registration();
    await request(app).post('/api/auth/register').send(body);
    const known = await request(app).post('/api/auth/email/resend').send({ email: body.email });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });
});

// ===========================================================================
describe('Connexion', () => {
  let user;
  beforeAll(async () => { user = await registerAndVerify(); });

  it('4. connexion par e-mail : cookie HttpOnly SameSite, aucun jeton dans la réponse', async () => {
    const res = await request(app).post('/api/auth/login').send({ identifier: user.email.toUpperCase(), password: user.password });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('haissel_sid='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    const sid = cookie.split(';')[0].split('=')[1];
    // 22. le jeton de session n'est jamais exposé au JavaScript
    expect(JSON.stringify(res.body)).not.toContain(sid);
    expect(res.body.data).not.toHaveProperty('token');
    // seul le hash est stocké en base
    expect((await pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [sid])).rows).toHaveLength(0);
  });

  it('5. connexion par pseudo', async () => {
    const res = await request(app).post('/api/auth/login').send({ identifier: user.username, password: user.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe(user.username);
  });

  it('6. mot de passe incorrect et compte inconnu : même réponse', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ identifier: user.email, password: 'mauvais mot de passe' });
    const unknown = await request(app).post('/api/auth/login').send({ identifier: 'inconnu@exemple.fr', password: 'mauvais mot de passe' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.message).toBe('Identifiants incorrects.');
  });

  it('8-9. comptes désactivé et banni', async () => {
    const disabled = await createUser({ active: false });
    const banned = await createUser({ banned: true });
    const resDisabled = await request(app).post('/api/auth/login').send({ identifier: disabled.username, password: PASSWORD });
    const resBanned = await request(app).post('/api/auth/login').send({ identifier: banned.email, password: PASSWORD });
    expect(resDisabled.body.error.code).toBe('ACCOUNT_DISABLED');
    expect(resBanned.body.error.code).toBe('ACCOUNT_BANNED');
    // Mauvais mot de passe sur un compte banni : réponse générique (aucune fuite).
    const wrong = await request(app).post('/api/auth/login').send({ identifier: banned.email, password: 'mauvais mot de passe' });
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('17. injection SQL dans les champs d’identification', async () => {
    for (const identifier of ["' OR '1'='1", "admin'--", "x@x.fr' OR 1=1 --", '"; DROP TABLE users; --']) {
      const res = await request(app).post('/api/auth/login').send({ identifier, password: "' OR '1'='1" });
      expect(res.status).toBe(401);
    }
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(0);
  });

  it('migration progressive : un hash bcrypt existant est accepté puis converti en Argon2id', async () => {
    const legacy = await createUser();
    const bcrypt = require('bcryptjs');
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [legacy.id, await bcrypt.hash(PASSWORD, 4)]);
    expect((await request(app).post('/api/auth/login').send({ identifier: legacy.username, password: PASSWORD })).status).toBe(200);
    const stored = await pool.query('SELECT password_hash FROM users WHERE id = $1', [legacy.id]);
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('16. bruteforce : ralentissement progressif sur le compte visé', async () => {
    const target = await createUser();
    const durations = [];
    for (let i = 0; i < 6; i += 1) {
      const start = Date.now();
      await request(app).post('/api/auth/login').send({ identifier: target.username, password: `essai-${i}-xxxxxx` });
      durations.push(Date.now() - start);
    }
    expect(durations[5]).toBeGreaterThan(durations[0] + 1500);
    // Pas de verrouillage : le bon mot de passe reste accepté.
    throttle.reset();
    expect((await request(app).post('/api/auth/login').send({ identifier: target.username, password: PASSWORD })).status).toBe(200);
  }, 30000);

  it('16b. bruteforce : limite par IP (HTTP 429)', async () => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
    try {
      const statuses = [];
      for (let i = 0; i < 12; i += 1) {
        throttle.reset();
        const res = await request(app).post('/api/auth/login').set(lanHeaders('192.168.7.7'))
          .send({ identifier: `inconnu${i}@exemple.fr`, password: 'mauvais mot de passe' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    } finally {
      process.env.RATE_LIMIT_IN_TESTS = 'false';
    }
  });
});

// ===========================================================================
describe('Sessions', () => {
  let user;
  beforeAll(async () => { user = await createUser(); });

  it('12. déconnexion : la session est révoquée côté serveur', async () => {
    const identity = await login(app, user);
    expect((await request(app).get('/api/auth/me').set(auth(identity))).status).toBe(200);
    const out = await request(app).post('/api/auth/logout').set(auth(identity));
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie'].join(';')).toMatch(/haissel_sid=;/);
    expect((await request(app).get('/api/auth/me').set(auth(identity))).status).toBe(401);
  });

  it('10. session expirée (absolue et inactivité)', async () => {
    const a = await login(app, user);
    await pool.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE revoked_at IS NULL AND user_id = $1", [user.id]);
    expect((await request(app).get('/api/auth/me').set(auth(a))).status).toBe(401);

    const b = await login(app, user);
    await pool.query("UPDATE sessions SET last_seen_at = NOW() - INTERVAL '2 days' WHERE revoked_at IS NULL AND user_id = $1", [user.id]);
    expect((await request(app).get('/api/auth/me').set(auth(b))).status).toBe(401);
  });

  it('11. session révoquée (déconnexion de tous les appareils)', async () => {
    const phone = await login(app, user);
    const laptop = await login(app, user);
    expect((await request(app).post('/api/auth/logout-all').set(auth(laptop))).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(phone))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(laptop))).status).toBe(401);
  });

  it('cookie forgé ou inconnu refusé', async () => {
    for (const cookie of ['haissel_sid=abc', `haissel_sid=${'A'.repeat(43)}`, 'haissel_sid=']) {
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    }
  });

  it('rotation : une nouvelle connexion invalide la session déjà présente dans le navigateur (anti-fixation)', async () => {
    const first = await login(app, user);
    const res = await request(app).post('/api/auth/login').set('Cookie', first.cookie)
      .send({ identifier: user.username, password: PASSWORD });
    const second = extractCookie(res);
    expect(second).not.toBe(first.cookie);
    expect((await request(app).get('/api/auth/me').set(auth(first))).status).toBe(401);
  });

  it('un compte banni perd immédiatement ses sessions', async () => {
    const victim = await createUser();
    const identity = await login(app, victim);
    await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [victim.id]);
    expect((await request(app).get('/api/links').set(auth(identity))).status).toBe(401);
  });

  it('l’en-tête Authorization Bearer n’est plus accepté', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer quelque-chose');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe('CSRF', () => {
  let identity;
  beforeAll(async () => { identity = await login(app, await createUser()); });

  it('20. requête modifiante sans jeton CSRF : refusée', async () => {
    const res = await request(app).post('/api/auth/logout').set('Cookie', identity.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect((await request(app).get('/api/auth/me').set(auth(identity))).status).toBe(200);
  });

  it('20b. jeton CSRF d’une autre session : refusé', async () => {
    const other = await login(app, await createUser());
    const res = await request(app).post('/api/auth/logout').set({ Cookie: identity.cookie, 'X-CSRF-Token': other.csrf });
    expect(res.status).toBe(403);
  });

  it('20c. requête venant d’un autre site : refusée, même sur les routes publiques', async () => {
    const crossSite = await request(app).post('/api/auth/login')
      .set({ Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' })
      .send({ identifier: 'x', password: 'y' });
    expect(crossSite.status).toBe(403);
    const foreignOrigin = await request(app).post('/api/auth/register').set('Origin', 'http://evil.example').send(registration());
    expect(foreignOrigin.status).toBe(403);
  });
});

// ===========================================================================
describe('Mot de passe', () => {
  it('23. changement de mot de passe : toutes les autres sessions sont révoquées', async () => {
    const user = await createUser();
    const other = await login(app, user);
    const current = await login(app, user);
    const res = await request(app).post('/api/auth/password/change').set(auth(current))
      .send({ current_password: PASSWORD, new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(other))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(current))).status).toBe(401);
    const renewed = { cookie: extractCookie(res), csrf: res.body.data.csrf_token };
    expect((await request(app).get('/api/auth/me').set(auth(renewed))).status).toBe(200);
    expect(lastMailTo(user.email).subject).toMatch(/modifié/);
  });

  it('changement refusé avec un mauvais mot de passe actuel', async () => {
    const identity = await login(app, await createUser());
    const res = await request(app).post('/api/auth/password/change').set(auth(identity))
      .send({ current_password: 'mauvais mot de passe', new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('réinitialisation : réponse identique que le compte existe ou non', async () => {
    const user = await createUser();
    const known = await request(app).post('/api/auth/password/forgot').send({ email: user.email });
    const unknown = await request(app).post('/api/auth/password/forgot').send({ email: 'personne@exemple.fr' });
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });

  it('15. réinitialisation : jeton à usage unique, sessions révoquées, ancien mot de passe refusé', async () => {
    const user = await createUser();
    const session = await login(app, user);
    await request(app).post('/api/auth/password/forgot').send({ email: user.email });
    const token = tokenFrom(lastMailTo(user.email), 'reset');

    // Mot de passe invalide : le jeton n'est PAS consommé.
    const weak = await request(app).post('/api/auth/password/reset').send({ token, password: 'court', confirm_password: 'court' });
    expect(weak.status).toBe(400);

    const ok = await request(app).post('/api/auth/password/reset').send({ token, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    const reuse = await request(app).post('/api/auth/password/reset').send({ token, password: 'encore une autre phrase', confirm_password: 'encore une autre phrase' });
    expect(reuse.status).toBe(400);

    expect((await request(app).get('/api/auth/me').set(auth(session))).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ identifier: user.email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ identifier: user.email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('14. jeton de réinitialisation expiré', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/password/forgot').send({ email: user.email });
    const token = tokenFrom(lastMailTo(user.email), 'reset');
    await pool.query("UPDATE auth_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1", [user.id]);
    const res = await request(app).post('/api/auth/password/reset').send({ token, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ identifier: user.email, password: PASSWORD })).status).toBe(200);
  });

  it('une nouvelle demande invalide l’ancien lien', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/password/forgot').send({ email: user.email });
    const first = tokenFrom(lastMailTo(user.email), 'reset');
    await request(app).post('/api/auth/password/forgot').send({ email: user.email });
    const res = await request(app).post('/api/auth/password/reset').send({ token: first, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
describe('Double authentification', () => {
  it('activation, connexion en deux étapes, anti-rejeu, codes de récupération', async () => {
    const user = await createUser();
    let identity = await login(app, user);

    const setup = await request(app).post('/api/auth/mfa/setup').set(auth(identity)).send({ password: PASSWORD });
    expect(setup.status).toBe(200);
    const { secret } = setup.body.data;
    const stored = await pool.query('SELECT mfa_pending_secret_enc FROM users WHERE id = $1', [user.id]);
    expect(stored.rows[0].mfa_pending_secret_enc).not.toContain(secret); // chiffré au repos

    const bad = await request(app).post('/api/auth/mfa/enable').set(auth(identity)).send({ code: '000000' });
    expect(bad.status).toBe(400);
    const enabled = await request(app).post('/api/auth/mfa/enable').set(auth(identity))
      .send({ code: mfa.hotp(secret, mfa.currentStep()) });
    expect(enabled.status).toBe(200);
    const codes = enabled.body.data.recovery_codes;
    expect(codes).toHaveLength(10);
    expect((await pool.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [user.id])).rows.map((r) => r.code_hash))
      .not.toContain(codes[0]);

    // Étape 1 : le mot de passe seul ne donne accès à rien.
    const step1 = await request(app).post('/api/auth/login').send({ identifier: user.username, password: PASSWORD });
    expect(step1.body.data.mfa_required).toBe(true);
    const pending = { cookie: extractCookie(step1), csrf: step1.body.data.csrf_token };
    expect((await request(app).get('/api/links').set(auth(pending))).status).toBe(401);

    // Un code déjà utilisé (même pas de 30 s que l'activation) est refusé.
    const replay = await request(app).post('/api/auth/mfa/verify').set(auth(pending)).send({ code: mfa.hotp(secret, mfa.currentStep()) });
    expect(replay.status).toBe(401);

    // Code de récupération : accepté une fois.
    const recovered = await request(app).post('/api/auth/mfa/verify').set(auth(pending)).send({ recovery_code: codes[0].toLowerCase() });
    expect(recovered.status).toBe(200);
    identity = { cookie: extractCookie(recovered), csrf: recovered.body.data.csrf_token };
    expect((await request(app).get('/api/links').set(auth(identity))).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(pending))).status).toBe(401); // rotation

    const again = await request(app).post('/api/auth/login').send({ identifier: user.username, password: PASSWORD });
    const pending2 = { cookie: extractCookie(again), csrf: again.body.data.csrf_token };
    const reused = await request(app).post('/api/auth/mfa/verify').set(auth(pending2)).send({ recovery_code: codes[0] });
    expect(reused.status).toBe(401);
  });

  it('5 codes faux : la connexion en attente est annulée', async () => {
    const user = await createUser({ mfaSecret: mfa.generateSecret() });
    const step1 = await request(app).post('/api/auth/login').send({ identifier: user.username, password: PASSWORD });
    const pending = { cookie: extractCookie(step1), csrf: step1.body.data.csrf_token };
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await request(app).post('/api/auth/mfa/verify').set(auth(pending)).send({ code: '123456' });
    }
    expect(last.body.error.code).toBe('MFA_LOCKED');
    const late = await request(app).post('/api/auth/mfa/verify').set(auth(pending)).send({ code: await totpFor(user) });
    expect(late.status).toBe(401);
  });
});

// ===========================================================================
describe('Privilèges', () => {
  it('19. un utilisateur ne peut pas s’attribuer un rôle', async () => {
    const identity = await login(app, await createUser());
    const attempts = [
      request(app).post('/api/admin/affiliates').set(auth(identity)).send({ name: 'x', url: 'https://x.example' }),
      request(app).patch('/api/admin/users/1/status').set(auth(identity)).send({ action: 'ban' }),
      request(app).post('/api/auth/register').set(auth(identity)).send(registration({ role: 'ADMIN' })),
    ];
    const [create, ban, register] = await Promise.all(attempts);
    expect(create.status).toBe(403);
    expect(ban.status).toBe(403);
    expect(register.status).toBe(202);
    const created = await pool.query("SELECT COUNT(*)::int AS n FROM admins a JOIN users u ON u.id = a.user_id WHERE u.email LIKE 'camille.%'");
    expect(created.rows[0].n).toBe(0);
  });

  it('18. route privée sans session', async () => {
    for (const url of ['/api/links', '/api/affiliate/stats', '/api/admin/overview']) {
      expect((await request(app).get(url)).status).toBe(401);
    }
  });

  it('administrateur sans double authentification : accès admin refusé', async () => {
    const admin = await createUser();
    await pool.query("INSERT INTO admins (user_id, role) VALUES ($1, 'ADMIN')", [admin.id]);
    const identity = await login(app, admin);
    const res = await request(app).get('/api/admin/overview').set(auth(identity));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('administrateur : session courte (8 h absolue, 30 min d’inactivité) et connexion depuis le LAN refusée', async () => {
    const admin = await createUser({ admin: true });
    await login(app, admin);
    const row = await pool.query(
      `SELECT idle_timeout_seconds, EXTRACT(EPOCH FROM expires_at - created_at)::int AS lifetime
       FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND NOT mfa_pending`,
      [admin.id]
    );
    expect(row.rows[0].idle_timeout_seconds).toBe(1800);
    expect(row.rows[0].lifetime).toBeLessThanOrEqual(8 * 3600 + 1);
    const lan = await request(app).post('/api/auth/login').set(lanHeaders()).send({ identifier: admin.username, password: PASSWORD });
    expect(lan.status).toBe(403);
  });

  it('changement de rôle : sessions fermées ; le dernier administrateur ne peut pas être retiré sans --force', async () => {
    const { execFileSync } = require('child_process');
    const run = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ['scripts/promote-admin.js', ...args], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', stdio: 'pipe' }) };
      } catch (error) {
        return { code: error.status, out: String(error.stderr) + String(error.stdout) };
      }
    };

    await pool.query('DELETE FROM admins');
    const solo = await createUser();
    const before = await login(app, solo);

    expect(run('--username', solo.username).out).toMatch(/Promu ADMIN/);
    expect(run('--username', solo.username).out).toMatch(/Déjà administrateur/); // idempotent
    // Rotation : la session ouverte avant la promotion est fermée.
    expect((await request(app).get('/api/auth/me').set(auth(before))).status).toBe(401);

    const refused = run('--username', solo.username, '--demote');
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/dernier administrateur/);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM admins')).rows[0].n).toBe(1);
  }, 30000);
});

// ===========================================================================
describe('Fuites et stockage navigateur', () => {
  it('21. aucune réponse ne contient de hash ou de secret', async () => {
    const user = await createUser({ mfaSecret: mfa.generateSecret() });
    const step1 = await request(app).post('/api/auth/login').send({ identifier: user.username, password: PASSWORD });
    const pending = { cookie: extractCookie(step1), csrf: step1.body.data.csrf_token };
    const step2 = await request(app).post('/api/auth/mfa/verify').set(auth(pending)).send({ code: await totpFor(user) });
    const identity = { cookie: extractCookie(step2), csrf: step2.body.data.csrf_token };
    const me = await request(app).get('/api/auth/me').set(auth(identity));
    for (const body of [step1.body, step2.body, me.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/password_hash|\$argon2|mfa_secret|token_hash/);
      expect(text).not.toContain(user.mfaSecret);
    }
  });

  it('22. le frontend ne stocke aucun jeton dans localStorage / sessionStorage', () => {
    for (const file of ['app.js', 'admin.js']) {
      const source = fs.readFileSync(path.join(__dirname, '../frontend', file), 'utf8');
      expect(source).not.toMatch(/localStorage\.setItem|sessionStorage\.setItem/);
      expect(source).not.toMatch(/Authorization/);
    }
  });

  it('les journaux de sécurité ne contiennent ni mot de passe ni jeton', async () => {
    const events = await pool.query('SELECT details::text AS d FROM security_events');
    const all = events.rows.map((r) => r.d).join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(NEW_PASSWORD);
    expect(all).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(events.rows.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe('24. Migration', () => {
  it('le schéma contient les objets de l’authentification renforcée', async () => {
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1)",
      [['auth_tokens', 'mfa_recovery_codes', 'security_events']]
    );
    expect(tables.rows).toHaveLength(3);
    const migrations = await pool.query('SELECT name FROM schema_migrations');
    expect(migrations.rows.map((r) => r.name)).toContain('20261010_0003_secure_authentication.sql');
  });

  it('les migrations sont réexécutables sans erreur', async () => {
    const { runMigrations } = require('../src/db/migrator');
    expect(await runMigrations(pool, { log: () => {} })).toEqual([]);
  });
});

// ===========================================================================
describe('RGPD : export et suppression du compte', () => {
  it('export : JSON complet, sans secret', async () => {
    const user = await createUser();
    const identity = await login(app, user);
    const res = await request(app).get('/api/auth/me/export').set(auth(identity));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.account.email).toBe(user.email);
    expect(res.body.sessions.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|\$argon2|mfa_secret|token_hash/);
    expect((await request(app).get('/api/auth/me/export')).status).toBe(401);
  });

  it('suppression : confirmation + mot de passe exigés, puis compte et sessions effacés', async () => {
    const user = await createUser();
    const identity = await login(app, user);
    const url = '/api/auth/me/delete';
    expect((await request(app).post(url).set(auth(identity)).send({ password: PASSWORD })).status).toBe(400);
    expect((await request(app).post(url).set(auth(identity)).send({ password: 'mauvais', confirm: 'SUPPRIMER' })).status).toBe(401);
    expect((await request(app).post(url).set('Cookie', identity.cookie).send({ password: PASSWORD, confirm: 'SUPPRIMER' })).status).toBe(403);

    const res = await request(app).post(url).set(auth(identity)).send({ password: PASSWORD, confirm: 'SUPPRIMER' });
    expect(res.status).toBe(200);
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [user.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id])).rowCount).toBe(0);
    expect((await request(app).get('/api/auth/me').set(auth(identity))).status).toBe(401);
  });

  it('un administrateur ne peut pas se supprimer depuis le site', async () => {
    const admin = await createUser({ admin: true });
    const identity = await login(app, admin);
    const res = await request(app).post('/api/auth/me/delete').set(auth(identity)).send({ password: PASSWORD, confirm: 'SUPPRIMER' });
    expect(res.status).toBe(403);
  });
});

describe('Conservation des données', () => {
  it('purge : IP des vieux clics effacées, vieux journaux supprimés', async () => {
    const { purgeExpiredData } = require('../src/services/retention.service');
    const link = (await pool.query("INSERT INTO affiliate_links (name, url) VALUES ('Old', 'https://exemple.fr') RETURNING id")).rows[0];
    const click = (await pool.query(
      "INSERT INTO clicks (affiliate_link_id, ip_address, user_agent, created_at) VALUES ($1, '10.0.0.1', 'UA', NOW() - INTERVAL '7 months') RETURNING id",
      [link.id]
    )).rows[0];
    const event = (await pool.query(
      "INSERT INTO security_events (event, created_at) VALUES ('old', NOW() - INTERVAL '13 months') RETURNING id"
    )).rows[0];
    await purgeExpiredData();
    expect((await pool.query('SELECT ip_address, user_agent FROM clicks WHERE id = $1', [click.id])).rows[0]).toEqual({ ip_address: null, user_agent: null });
    expect((await pool.query('SELECT 1 FROM security_events WHERE id = $1', [event.id])).rowCount).toBe(0);
  });
});