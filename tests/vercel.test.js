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
