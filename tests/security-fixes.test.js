/*
 * Correctifs de sécurité : énumération des comptes, rétention (notifications,
 * signalements), IP client sur Vercel, URL https seulement, liste blanche des
 * fournisseurs du webhook, TLS de PostgreSQL sans sslmode dans l'adresse.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const helpers = require('./helpers/setup');

const { app } = require('../src/app');
const { purgeExpiredData } = require('../src/services/retention.service');
const { getClientIp } = require('../src/utils/network');
const { isSafeOfferUrl } = require('../src/services/affiliate.service');
const { stripSslParams, poolSslConfig } = require('../src/config/database');
const auth = require('../src/controllers/auth.controller');

const { createUser, PASSWORD } = helpers;
let pool;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

describe('énumération des comptes', () => {
  const id = () => Math.random().toString(36).slice(2, 8);
  const register = (overrides) => request(app).post('/api/auth/register').send({
    first_name: 'Camille', last_name: 'Martin',
    username: `enum_${id()}`, email: `enum.${id()}@exemple.fr`,
    password: 'Un-mot-de-passe-tres-solide-42!', confirm_password: 'Un-mot-de-passe-tres-solide-42!',
    is_adult: true, age_terms_accepted: true,
    ...overrides,
  });
  // Cas visé : vérification de l'adresse désactivée (sinon la réponse est déjà celle d'un succès).
  const verification = process.env.EMAIL_VERIFICATION;
  beforeEach(() => { process.env.EMAIL_VERIFICATION = 'off'; });
  afterEach(() => { process.env.EMAIL_VERIFICATION = verification; });

  test('e-mail déjà utilisé : 409 générique, sans dire que l’adresse existe', async () => {
    const existing = await createUser({ prefix: 'enummail' });
    const res = await register({ email: existing.email });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(auth.GENERIC_REGISTER_CONFLICT);
    expect(res.body.error.message).toBe('Impossible de créer ce compte avec ces informations. Si tu as déjà un compte, connecte-toi ou réinitialise ton mot de passe.');
    expect(JSON.stringify(res.body)).not.toMatch(/e-mail est déjà|adresse.*utilisée/i);
  });

  test('pseudo déjà pris : message explicite (les pseudos sont publics)', async () => {
    const existing = await createUser({ prefix: 'enumpseudo' });
    const res = await register({ username: existing.username });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Ce pseudo est déjà pris.');
  });

  test('mot de passe oublié : même réponse et même durée minimale, compte connu ou non', async () => {
    const user = await createUser({ prefix: 'enumforgot' });
    const timed = async (email) => {
      const start = Date.now();
      const res = await request(app).post('/api/auth/password/forgot').send({ email });
      return { res, ms: Date.now() - start };
    };
    const known = await timed(user.email);
    const unknown = await timed('personne-inconnue@exemple.fr');
    expect(known.res.status).toBe(unknown.res.status);
    expect(known.res.body).toEqual(unknown.res.body);
    if (known.res.status === 202) {
      expect(known.ms).toBeGreaterThanOrEqual(auth.NEUTRAL_REPLY_MIN_MS - 20);
      expect(unknown.ms).toBeGreaterThanOrEqual(auth.NEUTRAL_REPLY_MIN_MS - 20);
    }
  });

  test('connexion : même réponse pour un e-mail inconnu et un mauvais mot de passe', async () => {
    const user = await createUser({ prefix: 'enumlogin' });
    const wrong = await request(app).post('/api/auth/login').send({ identifier: user.email, password: `${PASSWORD}x` });
    const unknown = await request(app).post('/api/auth/login').send({ identifier: 'inconnu-total@exemple.fr', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    // Compte absent : le mot de passe est quand même vérifié (faux hachage), même durée.
    const source = fs.readFileSync(path.join(__dirname, '../src/controllers/auth.controller.js'), 'utf8');
    expect(source).toContain('verifyPassword(user ? user.password_hash : await getDummyHash(), password)');
  });
});

describe('rétention', () => {
  async function subscription(userId, { createdMonths, successMonths }) {
    const { rows } = await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at, last_success_at)
       VALUES ($1, $2, 'k', 'a', NOW() - make_interval(months => $3::int),
               CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - make_interval(months => $4::int) END)
       RETURNING id`,
      [userId, `https://push.example/${Math.random()}`, createdMonths, successMonths]
    );
    return rows[0].id;
  }

  test('notifications : supprimées sans envoi réussi depuis 6 mois', async () => {
    const user = await createUser({ prefix: 'retpush' });
    const neverOld = await subscription(user.id, { createdMonths: 7, successMonths: null });
    const neverRecent = await subscription(user.id, { createdMonths: 2, successMonths: null });
    const successOld = await subscription(user.id, { createdMonths: 12, successMonths: 7 });
    const successRecent = await subscription(user.id, { createdMonths: 12, successMonths: 1 });
    await purgeExpiredData();
    const { rows } = await pool.query('SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY id', [user.id]);
    expect(rows.map((r) => r.id)).toEqual([neverRecent, successRecent]);
    expect([neverOld, successOld].every((id) => !rows.some((r) => r.id === id))).toBe(true);
  });

  test('signalements : traités supprimés après 6 mois, ouverts après 12 mois', async () => {
    const author = await createUser({ prefix: 'retrepauthor', adult: true });
    const offer = (await pool.query(
      `INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action, rights_confirmed_at)
       VALUES ($1, 'Fiche test rétention', 'https://exemple.fr/offre', 'Une description assez longue pour passer.',
               'applications', 'FR', 'Installer l’application', NOW())
       RETURNING id`, [author.id]
    )).rows[0].id;
    const report = async (status, months) => {
      const reporter = await createUser({ prefix: 'retreporter' });
      const { rows } = await pool.query(
        `INSERT INTO member_offer_reports (offer_id, user_id, reason, status, created_at)
         VALUES ($1, $2, 'spam', $3, NOW() - make_interval(months => $4::int)) RETURNING id`,
        [offer, reporter.id, status, months]
      );
      return rows[0].id;
    };
    const closedOld = await report('closed', 7);
    const closedRecent = await report('closed', 2);
    const openMid = await report('open', 8);
    const openOld = await report('open', 13);
    await purgeExpiredData();
    const { rows } = await pool.query('SELECT id FROM member_offer_reports WHERE offer_id = $1 ORDER BY id', [offer]);
    expect(rows.map((r) => r.id)).toEqual([closedRecent, openMid]);
    expect(rows.some((r) => r.id === closedOld || r.id === openOld)).toBe(false);
  });

  test('page Confidentialité alignée', () => {
    const html = fs.readFileSync(path.join(__dirname, '../frontend/confidentialite.html'), 'utf8');
    expect(html).toContain('supprimé automatiquement après 6 mois sans notification reçue');
    expect(html).toContain('6 mois après l’envoi une fois traités, 12 mois au plus sinon');
  });
});

describe('IP client sur Vercel', () => {
  const env = process.env.VERCEL;
  afterEach(() => { process.env.VERCEL = env; });
  const req = (headers, ip = '10.0.0.1') => ({
    ip, socket: { remoteAddress: '127.0.0.1' }, get: (name) => headers[name.toLowerCase()],
  });

  test('x-vercel-forwarded-for (premier élément) passe avant tout ; un X-Forwarded-For forgé ne change rien', () => {
    process.env.VERCEL = '1';
    const headers = { 'x-vercel-forwarded-for': '203.0.113.7, 10.1.1.1', 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '198.51.100.2' };
    expect(getClientIp(req(headers, '6.6.6.6'))).toBe('203.0.113.7');
  });

  test('puis x-real-ip, puis req.ip', () => {
    process.env.VERCEL = '1';
    expect(getClientIp(req({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(getClientIp(req({}, '192.0.2.4'))).toBe('192.0.2.4');
  });

  test('hors Vercel : en-têtes ignorés (adresse du socket)', () => {
    process.env.VERCEL = '';
    expect(getClientIp(req({ 'x-vercel-forwarded-for': '203.0.113.7' }))).toBe('127.0.0.1');
  });
});

describe('URL des offres', () => {
  test('https seulement', () => {
    expect(isSafeOfferUrl('https://exemple.fr/offre')).toBe(true);
    expect(isSafeOfferUrl('http://exemple.fr/offre')).toBe(false);
    expect(isSafeOfferUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('webhook d’affiliation', () => {
  test('fournisseur hors liste blanche : 404', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/controllers/webhook.controller.js'), 'utf8');
    expect(source).toContain("const ALLOWED_PROVIDERS = new Set(['mylead']);");
    const previous = process.env.ENABLE_INTERNAL_AFFILIATION;
    process.env.ENABLE_INTERNAL_AFFILIATION = 'true';
    try {
      const res = await request(app).post('/api/webhooks/affiliate/autre-reseau').set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_INTERNAL_AFFILIATION = previous;
    }
  });
});

describe('TLS PostgreSQL', () => {
  test('sslmode retiré de l’adresse donnée à pg, le reste intact', () => {
    const url = 'postgresql://u:p@db.example:5432/base?sslmode=require&channel_binding=require&application_name=x';
    const clean = stripSslParams(url);
    expect(clean).not.toMatch(/sslmode/);
    expect(clean).toContain('channel_binding=require');
    expect(clean).toContain('application_name=x');
    expect(clean.startsWith('postgresql://u:p@db.example:5432/base')).toBe(true);
    expect(stripSslParams('')).toBe('');
  });

  test('DATABASE_SSL actif : vérification explicite du certificat', () => {
    expect(poolSslConfig({ DATABASE_SSL: 'true' })).toEqual({ rejectUnauthorized: true });
    expect(poolSslConfig({})).toBe(false);
    const source = fs.readFileSync(path.join(__dirname, '../src/config/database.js'), 'utf8');
    expect(source).not.toMatch(/rejectUnauthorized: false/);
    expect(source).not.toMatch(/(console|logger)\.\w+\([^)]*(resolveDatabaseUrl|connectionString)/);
  });
});
