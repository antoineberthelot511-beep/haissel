/*
 * Trois corrections regroupées :
 *   - limites par IP adaptées aux réseaux partagés (Wi-Fi de lycée) ;
 *   - (les fichiers statiques sont traités dans static-no-db-write.test.js,
 *     qui doit poser VERCEL=1 avant de charger l'application) ;
 *   - délai de 30 jours avant de passer de « mineur » à « majeur ».
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const { ADULT_UPGRADE_DELAY_DAYS, canDeclareAdult } = require('../src/services/adult.service');

const { createUser, login, auth, lanHeaders, PASSWORD } = helpers;

let pool;
let admin;

const registration = (overrides = {}) => ({
  first_name: 'Camille',
  last_name: 'Durand',
  username: `lim${Math.random().toString(16).slice(2, 10)}`,
  email: `lim${Math.random().toString(16).slice(2, 10)}@exemple.fr`,
  password: PASSWORD,
  confirm_password: PASSWORD,
  is_adult: true,
  ...overrides,
});

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'limadmin' }));
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

// ===========================================================================
describe('Réseaux partagés : une classe entière doit pouvoir s’inscrire', () => {
  test('15 inscriptions depuis la même adresse IP passent toutes', async () => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
    try {
      const ip = lanHeaders('192.168.42.10');
      const statuses = [];
      for (let i = 0; i < 15; i += 1) {
        const res = await request(app).post('/api/auth/register').set(ip).send(registration());
        statuses.push(res.status);
      }
      // Aucune n'est refusée pour cause de limite.
      expect(statuses.filter((s) => s === 429)).toHaveLength(0);
      expect(statuses.every((s) => s === 201 || s === 202)).toBe(true);
    } finally {
      process.env.RATE_LIMIT_IN_TESTS = 'false';
    }
  }, 60000);

  test('des connexions réussies en série ne consomment aucun crédit', async () => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
    try {
      const ip = lanHeaders('192.168.42.20');
      const user = await createUser({ prefix: 'partage', adult: true });
      const statuses = [];
      // Bien au-delà de la limite de 30 : seules les ÉCHECS comptent.
      for (let i = 0; i < 35; i += 1) {
        const res = await request(app).post('/api/auth/login').set(ip)
          .send({ identifier: user.username, password: PASSWORD });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    } finally {
      process.env.RATE_LIMIT_IN_TESTS = 'false';
    }
  }, 60000);

  test('un balayage d’identifiants finit quand même par être bloqué', async () => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
    try {
      const ip = lanHeaders('192.168.42.30');
      const statuses = [];
      for (let i = 0; i < 40; i += 1) {
        const res = await request(app).post('/api/auth/login').set(ip)
          .send({ identifier: `inconnu${i}@exemple.fr`, password: 'mauvais mot de passe' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    } finally {
      process.env.RATE_LIMIT_IN_TESTS = 'false';
    }
  }, 90000);
});

// ===========================================================================
describe('Changer sa déclaration d’âge', () => {
  test('« oui » vers « non » est immédiat', async () => {
    const user = await createUser({ prefix: 'versmineur', adult: true });
    const identity = await login(app, user);

    const res = await request(app).post('/api/auth/adult-declaration')
      .set(auth(identity)).send({ is_adult: false });
    expect(res.status).toBe(200);
    expect(res.body.data.user.is_adult).toBe(false);
  });

  test('« non » vers « oui » est refusé pendant 30 jours', async () => {
    const user = await createUser({ prefix: 'troptot', adult: false });
    const identity = await login(app, user);

    const res = await request(app).post('/api/auth/adult-declaration')
      .set(auth(identity)).send({ is_adult: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADULT_CHANGE_TOO_SOON');
    // Le message dit quoi faire.
    expect(res.body.error.message).toMatch(/administrateur/);
    expect(res.body.error.message).toMatch(/jour/);

    const row = await pool.query('SELECT is_adult FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].is_adult).toBe(false);
  });

  test('après le délai, le passage est possible', async () => {
    const user = await createUser({ prefix: 'apresdelai', adult: false });
    const identity = await login(app, user);

    await pool.query(
      `UPDATE users SET adult_declared_at = NOW() - make_interval(days => $2) WHERE id = $1`,
      [user.id, ADULT_UPGRADE_DELAY_DAYS + 1]
    );

    const res = await request(app).post('/api/auth/adult-declaration')
      .set(auth(identity)).send({ is_adult: true });
    expect(res.status).toBe(200);
    expect(res.body.data.user.is_adult).toBe(true);
  });

  test('un compte sans réponse n’est pas concerné par le délai', async () => {
    const user = await createUser({ prefix: 'jamaisrepondu', adult: null });
    const identity = await login(app, user);

    const res = await request(app).post('/api/auth/adult-declaration')
      .set(auth(identity)).send({ is_adult: true });
    expect(res.status).toBe(200);
  });

  test('canDeclareAdult : calcul du délai restant', () => {
    expect(canDeclareAdult({ is_adult: null }).allowed).toBe(true);
    expect(canDeclareAdult({ is_adult: true, adult_declared_at: new Date() }).allowed).toBe(true);

    const hier = new Date(Date.now() - 86400000);
    const bloque = canDeclareAdult({ is_adult: false, adult_declared_at: hier });
    expect(bloque.allowed).toBe(false);
    expect(bloque.daysLeft).toBe(ADULT_UPGRADE_DELAY_DAYS - 1);
  });
});

// ===========================================================================
describe('Réinitialisation par l’administrateur', () => {
  test('un membre ne peut pas réinitialiser sa propre déclaration', async () => {
    const user = await createUser({ prefix: 'pasadmin', adult: false });
    const identity = await login(app, user);
    const res = await request(app).post(`/api/admin/users/${user.id}/adult-declaration/reset`).set(auth(identity));
    expect(res.status).toBe(403);
  });

  test('l’administrateur remet la question à zéro, et c’est journalisé', async () => {
    const user = await createUser({ prefix: 'areinitialiser', adult: false });
    const identity = await login(app, user);

    // Bloqué par le délai avant intervention.
    const avant = await request(app).post('/api/auth/adult-declaration')
      .set(auth(identity)).send({ is_adult: true });
    expect(avant.status).toBe(403);

    const reset = await request(app).post(`/api/admin/users/${user.id}/adult-declaration/reset`).set(auth(admin));
    expect(reset.status).toBe(200);

    const row = await pool.query('SELECT is_adult, adult_declared_at FROM users WHERE id = $1', [user.id]);
    expect(row.rows[0].is_adult).toBeNull();
    // La contrainte impose les deux colonnes nulles ensemble.
    expect(row.rows[0].adult_declared_at).toBeNull();

    const journal = await pool.query(
      "SELECT action FROM admin_actions WHERE action = 'user.adult_declaration_reset' AND target_id = $1",
      [user.id]
    );
    expect(journal.rows.length).toBe(1);

    // Le membre peut de nouveau répondre, sans attendre.
    const apres = await request(app).post('/api/auth/adult-declaration')
      .set(auth(identity)).send({ is_adult: true });
    expect(apres.status).toBe(200);
  });

  test('un utilisateur inexistant renvoie 404', async () => {
    const res = await request(app).post('/api/admin/users/99999999/adult-declaration/reset').set(auth(admin));
    expect(res.status).toBe(404);
  });
});
