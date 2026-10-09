/*
 * Tests unitaires : aucune base de données requise.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'unit-test-secret-0123456789-abcdefghijklmnopqrstu';
process.env.PROXY_SHARED_SECRET = 'unit-proxy-secret-0123456789-abcdefghijklmnopq';

const {
  isLocalRequest, getClientIp, anonymizeIp, hashIp,
} = require('../src/utils/network');
const {
  generateAffiliateCode, isValidCode, isSafeOfferUrl, buildDestinationUrl,
} = require('../src/services/affiliate.service');
const { validateConversionInput, ConversionError } = require('../src/services/conversion.service');
const { stripTransactionStatements, listMigrationFiles } = require('../src/db/migrator');
const { parseId } = require('../src/utils/http');

function fakeReq(remoteAddress, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { socket: { remoteAddress }, get: (name) => lower[name.toLowerCase()] };
}

describe('network: admin local-only', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('treats %s as local', (ip) => {
    expect(isLocalRequest(fakeReq(ip))).toBe(true);
  });

  it.each(['192.168.1.36', '10.0.0.5', '::ffff:192.168.1.36', undefined])('treats %s as LAN/remote', (ip) => {
    expect(isLocalRequest(fakeReq(ip))).toBe(false);
  });

  it('ignores spoofed forwarding headers from a LAN client', () => {
    const req = fakeReq('192.168.1.36', {
      'X-Forwarded-For': '127.0.0.1',
      'X-Real-IP': '127.0.0.1',
      'X-Haissel-Admin-Gate': '1',
    });
    expect(isLocalRequest(req)).toBe(false);
    expect(getClientIp(req)).toBe('192.168.1.36');
  });

  it('rejects a wrong proxy secret', () => {
    const req = fakeReq('172.18.0.3', {
      'X-Haissel-Proxy-Secret': 'wrong-secret-wrong-secret-wrong-secret-xx',
      'X-Haissel-Admin-Gate': '1',
      'X-Real-IP': '127.0.0.1',
    });
    expect(isLocalRequest(req)).toBe(false);
  });

  it('trusts the admin gate only with the proxy secret', () => {
    const viaAdminGate = fakeReq('172.18.0.3', {
      'X-Haissel-Proxy-Secret': process.env.PROXY_SHARED_SECRET,
      'X-Haissel-Admin-Gate': '1',
      'X-Real-IP': '172.18.0.1',
    });
    const viaPublicPort = fakeReq('172.18.0.3', {
      'X-Haissel-Proxy-Secret': process.env.PROXY_SHARED_SECRET,
      'X-Real-IP': '192.168.1.40',
    });
    expect(isLocalRequest(viaAdminGate)).toBe(true);
    expect(isLocalRequest(viaPublicPort)).toBe(false);
    expect(getClientIp(viaPublicPort)).toBe('192.168.1.40');
  });

  it('anonymizes and hashes IP addresses', () => {
    expect(anonymizeIp('192.168.1.36')).toBe('192.168.1.0');
    expect(anonymizeIp('::ffff:10.1.2.3')).toBe('10.1.2.0');
    expect(hashIp('192.168.1.36')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashIp('192.168.1.36')).not.toBe(hashIp('192.168.1.37'));
  });
});

describe('affiliate codes and URLs', () => {
  it('generates unpredictable codes in the HAI-XXXXXXXX format', () => {
    const codes = new Set(Array.from({ length: 500 }, generateAffiliateCode));
    expect(codes.size).toBe(500);
    for (const code of codes) {
      expect(code).toMatch(/^HAI-[A-HJ-NP-Z2-9]{8}$/);
      expect(isValidCode(code)).toBe(true);
    }
  });

  it('rejects malformed codes', () => {
    expect(isValidCode("HAI-1' OR '1'='1")).toBe(false);
    expect(isValidCode('<script>')).toBe(false);
    expect(isValidCode('abc')).toBe(false);
  });

  it('accepts only absolute http(s) offer URLs', () => {
    expect(isSafeOfferUrl('https://partner.example/offer')).toBe(true);
    expect(isSafeOfferUrl('http://partner.example')).toBe(true);
    expect(isSafeOfferUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeOfferUrl('data:text/html,hi')).toBe(false);
    expect(isSafeOfferUrl('//evil.example')).toBe(false);
    expect(isSafeOfferUrl('ftp://partner.example')).toBe(false);
    expect(isSafeOfferUrl('not a url')).toBe(false);
  });

  it('fills the optional {click_id} and {code} placeholders', () => {
    expect(buildDestinationUrl('https://p.example/?s={click_id}&c={code}', { clickId: 42, code: 'HAI-ABCD2345' }))
      .toBe('https://p.example/?s=42&c=HAI-ABCD2345');
  });
});

describe('conversion input validation', () => {
  const valid = {
    provider: 'partner', external_reference: 'ORDER-1', code: 'HAI-ABCD2345', amount_cents: 1250, currency: 'EUR', status: 'approved',
  };

  it('accepts a valid payload', () => {
    expect(validateConversionInput(valid)).toMatchObject({ amountCents: 1250, status: 'approved', currency: 'EUR' });
  });

  it.each([
    ['negative amount', { amount_cents: -100 }, 'INVALID_AMOUNT'],
    ['huge amount', { amount_cents: 1e12 }, 'INVALID_AMOUNT'],
    ['float amount', { amount_cents: 12.5 }, 'INVALID_AMOUNT'],
    ['string amount', { amount_cents: '1250' }, 'INVALID_AMOUNT'],
    ['invalid currency', { currency: 'BTC' }, 'INVALID_CURRENCY'],
    ['invalid status', { status: 'paid' }, 'INVALID_STATUS'],
    ['missing reference', { external_reference: '' }, 'INVALID_EXTERNAL_REFERENCE'],
    ['SQL in reference', { external_reference: "x'; DROP TABLE users;--" }, 'INVALID_EXTERNAL_REFERENCE'],
    ['invalid code', { code: '<img>' }, 'INVALID_CODE'],
    ['invalid click', { click_id: -3 }, 'INVALID_CLICK'],
  ])('rejects %s', (_label, override, code) => {
    expect(() => validateConversionInput({ ...valid, ...override })).toThrow(ConversionError);
    try {
      validateConversionInput({ ...valid, ...override });
    } catch (error) {
      expect(error.code).toBe(code);
    }
  });
});

describe('helpers', () => {
  it('parses ids strictly', () => {
    expect(parseId('42')).toBe(42);
    expect(parseId('0')).toBeNull();
    expect(parseId('1 OR 1=1')).toBeNull();
    expect(parseId('99999999999')).toBeNull();
  });

  it('migration runner owns the transaction', () => {
    expect(stripTransactionStatements('BEGIN;\nCREATE TABLE x();\nCOMMIT;\n-- COMMIT;')).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
    const names = listMigrationFiles().map((m) => m.name);
    expect(names[0]).toBe('init.sql');
    expect(names).toEqual([...names.slice(0, 1), ...names.slice(1).sort()]);
  });
});
