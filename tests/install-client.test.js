/*
 * Installation de l'application (frontend/install.js) : ligne de Réglages,
 * bannière de l'Accueil, offre de notifications, capture de
 * beforeinstallprompt. Manifeste conforme aux critères d'installation.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/install.js'), 'utf8');

function load(withEvents = false) {
  const listeners = {};
  const dispatched = [];
  const sandbox = { Date, Number };
  sandbox.window = sandbox;
  if (withEvents) {
    sandbox.addEventListener = (type, fn) => { listeners[type] = fn; };
    sandbox.dispatchEvent = (event) => dispatched.push(event.type);
    sandbox.Event = function Event(type) { this.type = type; };
  }
  vm.runInNewContext(SOURCE, sandbox);
  return { I: sandbox.HaisselInstall, listeners, dispatched };
}

const { I } = load();
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const DAY = 24 * 3600 * 1000;

describe('ligne « Installer l’application HAISSEL »', () => {
  test('Android installable : invite du navigateur', () => {
    expect(I.installState({ userAgent: ANDROID, hasPrompt: true })).toBe('prompt');
  });

  test('Android sans invite (critères non remplis, navigateur non compatible) : ligne cachée', () => {
    expect(I.installState({ userAgent: ANDROID, hasPrompt: false })).toBe('unavailable');
  });

  test('déjà installée : standalone, iPhone écran d’accueil ou appinstalled', () => {
    expect(I.installState({ userAgent: ANDROID, hasPrompt: true, displayModeStandalone: true })).toBe('installed');
    expect(I.installState({ userAgent: IPHONE_SAFARI, standalone: true })).toBe('installed');
    expect(I.installState({ userAgent: ANDROID, installed: true })).toBe('installed');
  });

  test('iPhone dans Safari : feuille « Comment faire ? »', () => {
    expect(I.installState({ userAgent: IPHONE_SAFARI })).toBe('ios-safari');
    // iPadOS se présente comme un Mac tactile, dans Safari.
    expect(I.installState({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      platform: 'MacIntel', maxTouchPoints: 5,
    })).toBe('ios-safari');
  });

  test('iPhone dans Chrome ou un autre navigateur : « Ouvre HAISSEL dans Safari »', () => {
    expect(I.installState({ userAgent: IPHONE_CHROME })).toBe('ios-other');
    expect(I.installState({ userAgent: IPHONE_SAFARI.replace('Version/17.5', 'FxiOS/126.0') })).toBe('ios-other');
  });
});

describe('feuille d’installation selon l’appareil (5 cas)', () => {
  const kindFor = (env, seen = false) => I.autoTutoKind({ seen, state: I.installState(env) });

  test('iPhone Safari non installé : carrousel du tuto iPhone', () => {
    expect(kindFor({ userAgent: IPHONE_SAFARI })).toBe('ios');
  });
  test('Android avec beforeinstallprompt : « Installe HAISSEL » (invite native)', () => {
    expect(kindFor({ userAgent: ANDROID, hasPrompt: true })).toBe('android');
  });
  test('iPhone dans un autre navigateur : « Ouvre HAISSEL dans Safari »', () => {
    expect(kindFor({ userAgent: IPHONE_CHROME })).toBe('safari');
  });
  test('déjà installée : rien', () => {
    expect(kindFor({ userAgent: IPHONE_SAFARI, standalone: true })).toBeNull();
    expect(kindFor({ userAgent: ANDROID, hasPrompt: true, displayModeStandalone: true })).toBeNull();
  });
  test('ordinateur : rien', () => {
    expect(kindFor({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' })).toBeNull();
  });
  test('déjà vue sur le compte : jamais rouverte automatiquement', () => {
    expect(kindFor({ userAgent: IPHONE_SAFARI }, true)).toBeNull();
    expect(kindFor({ userAgent: ANDROID, hasPrompt: true }, true)).toBeNull();
  });
  test('ligne de Réglages : même feuille, tuto iPhone par défaut (déjà installée, ordinateur)', () => {
    expect(I.tutoKind('installed')).toBeNull();
    expect(I.tutoKind('unavailable')).toBeNull();
    expect(I.tutoKind('ios-safari')).toBe('ios');
  });
});

describe('bannière de l’Accueil', () => {
  const now = Date.UTC(2026, 9, 27);

  test('3 jours après la première visite, si l’app est installable', () => {
    expect(I.bannerVisible({ state: 'prompt', firstSeenAt: now - 3 * DAY, now })).toBe(true);
    expect(I.bannerVisible({ state: 'ios-safari', firstSeenAt: String(now - 4 * DAY), now })).toBe(true);
    expect(I.bannerVisible({ state: 'prompt', firstSeenAt: now - 3 * DAY + 1, now })).toBe(false);
    expect(I.bannerVisible({ state: 'prompt', firstSeenAt: null, now })).toBe(false);
  });

  test('jamais après la croix, jamais si installée ou non installable', () => {
    expect(I.bannerVisible({ state: 'prompt', firstSeenAt: now - 10 * DAY, dismissed: true, now })).toBe(false);
    for (const state of ['installed', 'ios-other', 'unavailable']) {
      expect([state, I.bannerVisible({ state, firstSeenAt: now - 10 * DAY, now })]).toEqual([state, false]);
    }
  });

  test('installée : proposer les notifications, une seule fois', () => {
    const base = { state: 'installed', pushEnabled: true, canPush: true, permission: 'default' };
    expect(I.notifyOfferVisible(base)).toBe(true);
    expect(I.notifyOfferVisible({ ...base, dismissed: true })).toBe(false);
    expect(I.notifyOfferVisible({ ...base, subscribed: true })).toBe(false);
    expect(I.notifyOfferVisible({ ...base, permission: 'denied' })).toBe(false);
    expect(I.notifyOfferVisible({ ...base, state: 'prompt' })).toBe(false);
    expect(I.notifyOfferVisible({ ...base, pushEnabled: false })).toBe(false);
  });
});

describe('événements du navigateur', () => {
  test('beforeinstallprompt : preventDefault et invite gardée ; appinstalled : installée', () => {
    const { I: live, listeners, dispatched } = load(true);
    const event = { preventDefault: jest.fn() };
    listeners.beforeinstallprompt(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(live.deferred).toBe(event);
    listeners.appinstalled();
    expect(live.deferred).toBeNull();
    expect(live.installed).toBe(true);
    expect(dispatched).toEqual(['haissel-install-change', 'haissel-install-change']);
  });
});

describe('page et manifeste', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');

  test('ligne toujours visible dans Réglages, feuille d’installation, bannière en verre', () => {
    const settings = html.slice(html.indexOf('id="ppanel-settings"'), html.indexOf('id="about-title"'));
    expect(settings).toMatch(/<button id="install-row" class="install-row" type="button">/);
    expect(settings).toContain('src="/icons/icon-192.png"');
    expect(settings).toContain("Installer l'app sur ton téléphone");
    expect(settings).toContain('#i-chevron-right');
    expect(html).toMatch(/<dialog id="install-sheet" class="sheet"/);
    const app = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
    expect(app).toContain("'Application installée ✓'");
    expect(app).toContain("'Copier le lien'");
    // Fermeture des feuilles (quelle que soit l'étape) : « vu » sur le compte.
    expect(app).toContain('bindSheet(ui.installSheet, { onClose: markInstallTutoSeen });');
    expect(app).toMatch(/bindSheet\(ui\.howtoSheet, \{\s*onClose: \(\) => \{\s*markInstallTutoSeen\(\);/);
    // Jamais par-dessus l'écran de chargement ni la question de majorité.
    expect(app).toMatch(/const blocked = document\.getElementById\('boot-screen'\) \|\| \(gate && !gate\.hidden\)/);
    expect(html).toMatch(/<div id="install-banner" class="install-banner lg-glass lg-pill"[^>]*hidden>/);
    expect(html.indexOf('src="install.js"')).toBeLessThan(html.indexOf('src="app.js"'));
  });

  test('critères d’installation de Chrome', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../frontend/manifest.webmanifest'), 'utf8'));
    for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'theme_color', 'background_color']) {
      expect([key, Boolean(manifest[key])]).toEqual([key, true]);
    }
    expect(manifest.display).toBe('standalone');
    const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  });
});
