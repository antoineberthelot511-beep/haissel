/*
 * Les fichiers statiques ne doivent déclencher aucune écriture en base.
 *
 * Sur Vercel, les compteurs de limitation vivent dans rate_limit_counters.
 * Tant que `app.use(generalRateLimiter)` était posé AVANT express.static,
 * chaque feuille de style, script, police ou image servie produisait une
 * écriture PostgreSQL — une vingtaine par ouverture de page, sans rien
 * protéger.
 *
 * VERCEL=1 est posé AVANT de charger src/app : les limiteurs choisissent leur
 * magasin (mémoire ou PostgreSQL) au chargement du module. Le poser plus tard
 * laisserait le magasin mémoire en place et ce test ne prouverait rien.
 */
process.env.VERCEL = '1';

const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');

let pool;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  // Les limiteurs sont inactifs en test par défaut : ici on veut les mesurer.
  process.env.RATE_LIMIT_IN_TESTS = 'true';
}, 30000);

afterAll(async () => {
  process.env.RATE_LIMIT_IN_TESTS = 'false';
  await helpers.teardownDatabase();
});

beforeEach(async () => {
  await pool.query('DELETE FROM rate_limit_counters');
});

async function counterRows() {
  const { rows } = await pool.query('SELECT key FROM rate_limit_counters ORDER BY key');
  return rows.map((r) => r.key);
}

describe('Fichiers statiques', () => {
  test.each([
    ['/styles.css'],
    ['/app.js'],
    ['/redesign.css'],
    ['/community-mobile.css'],
    ['/notifications.js'],
    ['/sw.js'],
  ])('GET %s ne crée aucune ligne dans rate_limit_counters', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(await counterRows()).toEqual([]);
  });

  test('une page entière (20 fichiers) n’écrit toujours rien', async () => {
    const files = ['/styles.css', '/redesign.css', '/community-mobile.css', '/mobile-splash.css',
      '/app.js', '/notifications.js', '/turnstile.js', '/inert.js', '/mylead-guide.js', '/sw.js'];
    for (const file of files) {
      await request(app).get(file).expect(200);
    }
    expect(await counterRows()).toEqual([]);
  });

  test('une police du dossier /vendor/fonts n’écrit rien non plus', async () => {
    const res = await request(app).get('/vendor/fonts/ibm-plex-sans/package.json');
    // Le fichier existe ou non selon l'installation ; dans les deux cas,
    // aucune ecriture ne doit avoir lieu.
    expect([200, 404]).toContain(res.status);
    expect(await counterRows()).toEqual([]);
  });
});

describe('Ce qui vient après reste compté', () => {
  test('une route d’API crée bien une ligne', async () => {
    await request(app).get('/api/auth/config').expect(200);
    const keys = await counterRows();
    expect(keys.length).toBeGreaterThan(0);
    // La clé porte le préfixe du limiteur général.
    expect(keys.some((k) => k.startsWith('general:'))).toBe(true);
  });

  test('les pages HTML publiques ne sont pas comptées non plus', async () => {
    /*
     * /app, / et les pages légales sont servies par des routes déclarées avant
     * le limiteur, au même titre que les fichiers statiques : ce sont des
     * pages publiques, identiques pour tous. Les compter coûterait une
     * écriture par visite sans rien protéger.
     */
    await request(app).get('/app').expect(200);
    expect(await counterRows()).toEqual([]);
  });

  test('la frontière est bien posée : /api/health est comptée', async () => {
    await request(app).get('/api/health');
    expect((await counterRows()).length).toBeGreaterThan(0);
  });
});
