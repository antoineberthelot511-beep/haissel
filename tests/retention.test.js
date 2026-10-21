/*
 * Route interne de rétention : POST/GET /api/internal/retention.
 *
 * Sur Vercel il n'y a pas de processus permanent, donc startRetentionJob()
 * (setInterval) ne tourne jamais : la purge est déclenchée par le cron de
 * Vercel, authentifié par le secret partagé CRON_SECRET.
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

const SECRET = 'cron-secret-de-test-0123456789-abcdefghijkl';
let pool;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('Rétention : authentification de la route interne', () => {
  it('répond 404 quand CRON_SECRET n’est pas défini (la route ne se révèle pas)', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).post('/api/internal/retention');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('répond 404 même avec un en-tête valide si CRON_SECRET est absent', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).post('/api/internal/retention')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(404);
  });

  it('répond 401 sans en-tête Authorization', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await request(app).post('/api/internal/retention');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('répond 401 avec un mauvais secret', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await request(app).post('/api/internal/retention')
      .set('Authorization', 'Bearer mauvais-secret');
    expect(res.status).toBe(401);
  });

  it('répond 401 si le préfixe « Bearer » manque', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await request(app).post('/api/internal/retention')
      .set('Authorization', SECRET);
    expect(res.status).toBe(401);
  });

  it('répond 200 avec le bon secret (POST, appel manuel)', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await request(app).post('/api/internal/retention')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.purged).toBe(true);
  });

  it('répond 200 avec le bon secret (GET : les crons Vercel n’émettent que des GET)', async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await request(app).get('/api/internal/retention')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.purged).toBe(true);
  });
});

describe('Rétention : la purge agit réellement', () => {
  it('supprime les événements de sécurité de plus de 12 mois et garde les récents', async () => {
    process.env.CRON_SECRET = SECRET;
    await pool.query(
      `INSERT INTO security_events (event, created_at)
       VALUES ('login_failed', NOW() - INTERVAL '13 months'),
              ('login_failed', NOW() - INTERVAL '1 day')`
    );

    const before = await pool.query('SELECT COUNT(*)::int AS n FROM security_events');
    const res = await request(app).get('/api/internal/retention')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);

    const after = await pool.query('SELECT COUNT(*)::int AS n FROM security_events');
    expect(after.rows[0].n).toBe(before.rows[0].n - 1);

    const old = await pool.query(
      "SELECT COUNT(*)::int AS n FROM security_events WHERE created_at < NOW() - INTERVAL '12 months'"
    );
    expect(old.rows[0].n).toBe(0);
  });

  it('supprime les compteurs de limitation dont la fenêtre est passée', async () => {
    process.env.CRON_SECRET = SECRET;
    await pool.query(
      `INSERT INTO rate_limit_counters (key, hits, expires_at)
       VALUES ('test:expire', 9, NOW() - INTERVAL '2 hours'),
              ('test:actif', 3, NOW() + INTERVAL '10 minutes')`
    );

    await request(app).get('/api/internal/retention').set('Authorization', `Bearer ${SECRET}`);

    const { rows } = await pool.query(
      "SELECT key FROM rate_limit_counters WHERE key LIKE 'test:%' ORDER BY key"
    );
    expect(rows.map((row) => row.key)).toEqual(['test:actif']);
  });
});
