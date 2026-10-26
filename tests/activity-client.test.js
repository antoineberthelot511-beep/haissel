/*
 * Logique navigateur de la page Activité et du réglage des notifications
 * (frontend/activity.js) : détection de l'appareil, sections, durées, phrases.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/activity.js'), 'utf8');

function load() {
  const sandbox = { Date, Number, String };
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.HaisselActivity;
}

const A = load();
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

describe('deviceSupport', () => {
  test('API Notification disponible : interrupteur actif', () => {
    expect(A.deviceSupport({ hasNotification: true, isSecureContext: true, userAgent: ANDROID })).toBe('available');
    // iPhone ouvert depuis l'écran d'accueil (iOS 16.4+) : l'API existe.
    expect(A.deviceSupport({ hasNotification: true, isSecureContext: true, userAgent: IPHONE, standalone: true })).toBe('available');
  });

  test('iPhone ou iPad dans Safari, pas sur l’écran d’accueil : « ajoute HAISSEL »', () => {
    expect(A.deviceSupport({ hasNotification: false, userAgent: IPHONE, standalone: false })).toBe('ios-install');
    // iPadOS se présente comme un Mac tactile.
    expect(A.deviceSupport({ hasNotification: false, userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios-install');
  });

  test('autre navigateur sans support', () => {
    expect(A.deviceSupport({ hasNotification: false, userAgent: ANDROID })).toBe('unsupported');
    expect(A.deviceSupport({ hasNotification: false, userAgent: IPHONE, displayModeStandalone: true })).toBe('unsupported');
    expect(A.deviceSupport({ hasNotification: true, isSecureContext: false, userAgent: ANDROID })).toBe('unsupported');
    expect(A.deviceSupport({ hasNotification: false, userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe('unsupported');
  });
});

describe('sections et durées', () => {
  const now = new Date(2026, 9, 26, 15, 0);
  const at = (days, hours = 0) => new Date(now.getTime() - (days * 24 + hours) * 3600000).toISOString();

  test('Aujourd’hui, Cette semaine, Plus ancien', () => {
    expect(A.sectionOf(at(0, 2), now)).toBe('today');
    expect(A.sectionOf(at(1), now)).toBe('week');
    expect(A.sectionOf(at(6), now)).toBe('week');
    expect(A.sectionOf(at(8), now)).toBe('older');
    const groups = A.groupBySection([{ at: at(0, 1) }, { at: at(3) }, { at: at(20) }], now);
    expect(groups.map((g) => g.label)).toEqual(['Aujourd’hui', 'Cette semaine', 'Plus ancien']);
    expect(A.groupBySection([{ at: at(20) }], now).map((g) => g.key)).toEqual(['older']);
  });

  test('durée relative', () => {
    expect(A.relativeTime(at(0, 0), now)).toBe('à l’instant');
    expect(A.relativeTime(new Date(now.getTime() - 5 * 60000), now)).toBe('il y a 5 min');
    expect(A.relativeTime(at(0, 2), now)).toBe('il y a 2 h');
    expect(A.relativeTime(at(3), now)).toBe('il y a 3 j');
    expect(A.relativeTime(at(15), now)).toBe('il y a 2 sem.');
  });
});

describe('phrases et non-lus', () => {
  const now = new Date(2026, 9, 26, 15, 0);

  test('une phrase courte par type connu, rien pour un type inconnu', () => {
    expect(A.describe({ type: 'offer_published', title: 'Notion' }).text).toBe('Ta fiche « Notion » est validée : elle est visible 24 h.');
    expect(A.describe({ type: 'offer_rejected', title: 'Notion' }).tone).toBe('bad');
    expect(A.describe({ type: 'story_expired', title: 'Notion' }).text).toMatch(/expiré/);
    expect(A.describe({ type: 'team_message', detail: 'Bonjour' }).text).toBe('L’équipe Haissel t’a répondu : « Bonjour »');
    expect(A.describe({ type: 'announcement', title: 'Nouveauté', detail: 'Les stories arrivent.' }).text).toBe('Nouveauté : Les stories arrivent.');
    expect(A.describe({ type: 'inventé' })).toBeNull();
  });

  test('non lu = plus récent que la dernière visite ; première visite : dernières 24 h', () => {
    const items = [
      { type: 'offer_published', at: new Date(now.getTime() - 3600000).toISOString() },
      { type: 'offer_published', at: new Date(now.getTime() - 3 * 86400000).toISOString() },
      { type: 'inventé', at: now.toISOString() },
    ];
    expect(A.unreadCount(items, null, now)).toBe(1);
    expect(A.unreadCount(items, new Date(now.getTime() - 4 * 86400000).toISOString(), now)).toBe(2);
    expect(A.unreadCount(items, now.toISOString(), now)).toBe(0);
  });
});

describe('interface membre sans texte technique', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  test('ni « Windows », ni « ordinateur », ni état du canal', () => {
    expect(html).not.toMatch(/Windows|ordinateur|Canal temps réel|contexte sécurisé|API absente|non prises en charge/i);
  });

  test('manifeste d’écran d’accueil complet', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../frontend/manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'HAISSEL', short_name: 'HAISSEL', display: 'standalone', theme_color: expect.stringMatching(/^#/) });
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons) expect(fs.existsSync(path.join(__dirname, '../frontend', icon.src))).toBe(true);
    expect(html).toMatch(/<link rel="manifest" href="\/manifest.webmanifest"/);
  });
});

describe('dernière visite (stockage local)', () => {
  function memoryStorage() {
    const data = {};
    return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
  }

  test('mémorisée par compte ; sans stockage, rien ne casse', () => {
    const storage = memoryStorage();
    const now = new Date(2026, 9, 26, 15, 0);
    expect(A.readSeen(7, storage)).toBeNull();
    A.markSeen(7, null, storage, now);
    expect(A.readSeen(7, storage)).toBe(now.toISOString());
    expect(A.readSeen(8, storage)).toBeNull();
    const broken = { getItem: () => { throw new Error('bloqué'); }, setItem: () => { throw new Error('bloqué'); } };
    expect(A.readSeen(7, broken)).toBeNull();
    expect(() => A.markSeen(7, null, broken, now)).not.toThrow();
    expect(A.readSeen(7, undefined)).toBeNull();
  });
});
