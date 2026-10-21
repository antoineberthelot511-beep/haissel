/*
 * Mode Vercel (VERCEL=1) : aucune base de données requise.
 */
process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.APP_SECRET = 'vercel-test-secret-0123456789-abcdefghijklmnopq';
process.env.MAIL_TRANSPORT = 'memory';
process.env.ADMIN_REQUIRE_MFA = 'false';
process.env.ADMIN_IP_ALLOWLIST = '';

const request = require('supertest');
const app = require('../src/app');
const { isLocalRequest, isAdminAccessAllowed, getClientIp } = require('../src/utils/network');
const { isAdminMfaRequired } = require('../src/config/security');

function fakeReq(remoteAddress, ip) {
  return { socket: { remoteAddress }, ip, get: () => undefined };
}

afterAll(() => app.pool.end());

describe('Vercel : point d\'entrée', () => {
  it('exporte l\'application Express (et garde { app, pool })', () => {
    expect(typeof app).toBe('function');
    expect(app.app).toBe(app);
    expect(app.pool).toBeDefined();
  });

  it('accepte un POST same-origin arrivé en HTTPS via le proxy', async () => {
    const res = await request(app)
      .post('/api/route-inexistante')
      .set('Host', 'haissel.vercel.app')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://haissel.vercel.app')
      .send({});
    expect(res.status).toBe(404);
  });

  it('refuse toujours une origine étrangère', async () => {
    const res = await request(app)
      .post('/api/route-inexistante')
      .set('Host', 'haissel.vercel.app')
      .set('X-Forwarded-Proto', 'https')
      .set('Origin', 'https://evil.example')
      .send({});
    expect(res.status).toBe(403);
  });

  it('sert l\'espace membre (et non l\'admin) sur /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Espace membre');
    expect(res.text).not.toContain('Console d\'administration');
  });

  it('contient la balise de vérification MyLead dans le <head> de /', async () => {
    const res = await request(app).get('/');
    const head = res.text.slice(0, res.text.indexOf('</head>'));
    expect(head).toContain('<!-- mylead-verification: 03fcb98f110f796f0081ef088a5a07c2 -->');
  });
});

describe('Vercel : accès administrateur', () => {
  afterEach(() => { process.env.ADMIN_IP_ALLOWLIST = ''; });

  it('ne considère jamais une requête comme locale', () => {
    expect(isLocalRequest(fakeReq('127.0.0.1', '127.0.0.1'))).toBe(false);
  });

  it('utilise l\'IP transmise par le proxy', () => {
    expect(getClientIp(fakeReq('127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
  });

  it('impose la double authentification même si ADMIN_REQUIRE_MFA=false', () => {
    expect(isAdminMfaRequired()).toBe(true);
  });

  it('autorise l\'admin en ligne sans liste d\'IP', () => {
    expect(isAdminAccessAllowed(fakeReq('10.0.0.1', '203.0.113.9'))).toBe(true);
  });

  it('applique ADMIN_IP_ALLOWLIST si elle est définie', () => {
    process.env.ADMIN_IP_ALLOWLIST = '198.51.100.7, 203.0.113.9';
    expect(isAdminAccessAllowed(fakeReq('10.0.0.1', '203.0.113.9'))).toBe(true);
    expect(isAdminAccessAllowed(fakeReq('10.0.0.1', '192.0.2.1'))).toBe(false);
  });

  it('bloque /admin.html hors liste d\'IP', async () => {
    process.env.ADMIN_IP_ALLOWLIST = '198.51.100.7';
    const res = await request(app).get('/admin.html').set('X-Forwarded-For', '192.0.2.1');
    expect(res.status).toBe(403);
  });
});

describe('Vercel : tâche de rétention planifiée', () => {
  const config = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../vercel.json'), 'utf8'));

  it('déclare un cron quotidien sur la route interne', () => {
    // startRetentionJob() n'existe que dans un processus permanent : sans ce
    // cron, la purge RGPD ne tournerait jamais en ligne.
    expect(config.crons).toEqual([
      { path: '/api/internal/retention', schedule: '0 3 * * *' },
    ]);
  });

  it('répond 404 sur la route interne sans CRON_SECRET', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/retention');
    expect(res.status).toBe(404);
  });

  it('répond 401 avec un mauvais secret', async () => {
    process.env.CRON_SECRET = 'secret-vercel-de-test-0123456789-abcdef';
    try {
      const res = await request(app).get('/api/internal/retention')
        .set('Authorization', 'Bearer mauvais');
      expect(res.status).toBe(401);
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

describe('Vercel : présence des utilisateurs', () => {
  const { getPresence } = require('../src/controllers/broadcast.controller');

  function captureJson() {
    const res = {
      statusCode: null,
      payload: null,
      status(code) { res.statusCode = code; return res; },
      json(body) { res.payload = body; return res; },
    };
    return res;
  }

  it('annonce le comptage comme indisponible, sans aucun chiffre de connexions', () => {
    const res = captureJson();
    getPresence({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.data).toMatchObject({ available: false, mode: 'poll' });
    // Un compte partiel (celui d'une seule instance) serait faux : il ne doit
    // pas apparaître du tout.
    expect(res.payload.data.connected_users).toBeUndefined();
    expect(res.payload.data.connections).toBeUndefined();
  });
});
