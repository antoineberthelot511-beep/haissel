/*
 * Mascotte (frontend/mascot.js) et corrections de Messages : images
 * présentes, <img> conforme, un seul ours à l'écran, emplacements et tailles,
 * jamais dans les listes, prefers-reduced-motion ; épinglée absente de la
 * liste ; focus des menus au clavier seulement.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const SOURCE = read('mascot.js');
const app = read('app.js');
const admin = read('admin.js');
const index = read('index.html');
const adminHtml = read('admin.html');

function loadPure() {
  const sandbox = { Math, Number, String };
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.HaisselMascot;
}

/** DOM minimal : createElement, querySelectorAll vide, MutationObserver inerte. */
function loadDom() {
  const el = (tag) => {
    const attributes = {};
    return {
      tag, dataset: {}, className: '',
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] ?? null; },
      attributes,
    };
  };
  const doc = {
    readyState: 'complete', body: {}, createElement: el, querySelectorAll: () => [], addEventListener() {},
  };
  const sandbox = { Math, Number, String, document: doc, requestAnimationFrame: () => 1, MutationObserver: function MO() { this.observe = () => {}; } };
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.HaisselMascot;
}

const M = loadPure();

describe('images', () => {
  test('22 poses, .webp (et .png) dans design/mascotte, .webp copiés dans frontend/images/mascotte', () => {
    expect(M.POSES).toHaveLength(22);
    for (const [i, name] of M.POSES.entries()) {
      const base = `ours-${String(i + 1).padStart(2, '0')}-${name}`;
      for (const file of [`design/mascotte/${base}.webp`, `design/mascotte/${base}.png`, `frontend/images/mascotte/${base}.webp`]) {
        expect([file, fs.existsSync(path.join(ROOT, file))]).toEqual([file, true]);
      }
      expect(M.src(name)).toBe(`/images/mascotte/${base}.webp`);
    }
    expect(() => M.src('inconnu')).toThrow();
  });

  test('512×512, fond transparent', async () => {
    for (const [i, name] of M.POSES.entries()) {
      const file = path.join(FRONTEND, 'images/mascotte', `ours-${String(i + 1).padStart(2, '0')}-${name}.webp`);
      const meta = await sharp(file).metadata();
      expect([name, meta.width, meta.height, meta.hasAlpha]).toEqual([name, 512, 512, true]);
    }
  });

  test('chaque pose est utilisée quelque part (application ou console)', () => {
    const all = [index, adminHtml, app, admin, read('boot.js')].join('\n');
    // 09 et 10 : remplacées par 21 « aucun-message » (liste vide, conversation sans réponse).
    for (const name of M.POSES.filter((pose) => !['messages', 'message-recu'].includes(pose))) {
      expect([name, new RegExp(`(data-mascot="${name}"|bear\\('${name}'|mascot: '${name}'|mascot\\('${name}'|'${name}' :|: '${name}')`).test(all)])
        .toEqual([name, true]);
    }
  });
});

describe('mascot()', () => {
  test('<img> différé, taille fixe, décoratif par défaut', () => {
    const D = loadDom();
    const img = D.mascot('bravo', { size: 160 });
    expect(img.tag).toBe('img');
    expect(img.className).toBe('mascot');
    expect(img.src).toBe('/images/mascotte/ours-02-bravo.webp');
    expect([img.loading, img.decoding, img.width, img.height, img.alt]).toEqual(['lazy', 'async', 160, 160, '']);
    expect(img.getAttribute('aria-hidden')).toBe('true');
    const described = D.mascot('securite', { size: 88, alt: 'Ours avec un cadenas' });
    expect(described.alt).toBe('Ours avec un cadenas');
    expect(described.getAttribute('aria-hidden')).toBeNull();
  });

  test('tailles bornées entre 72 et 160 px', () => {
    expect(M.clampSize(20)).toBe(72);
    expect(M.clampSize(400)).toBe(160);
    expect(M.clampSize(96)).toBe(96);
  });
});

describe('un seul ours à l’écran', () => {
  test('parmi les ours visibles, le plus récent reste', () => {
    expect(M.pickVisible([])).toBe(-1);
    expect(M.pickVisible([{ visible: false, order: 1 }])).toBe(-1);
    expect(M.pickVisible([{ visible: true, order: 1 }, { visible: true, order: 3 }, { visible: false, order: 9 }])).toBe(1);
    expect(M.pickVisible([{ visible: true, order: 5 }, { visible: true, order: 2 }])).toBe(0);
  });

  test('les autres ours visibles sont masqués, réaffichés quand ils redeviennent seuls', () => {
    const enforce = SOURCE.slice(SOURCE.indexOf('function enforce()'), SOURCE.indexOf('let frame = 0;'));
    expect(enforce).toContain("const hide = i !== winner && shown(img);");
    expect(enforce).toContain('img.hidden = hide;');
    expect(SOURCE).toMatch(/attributeFilter: \['class', 'hidden', 'open'\]/);
  });

  test('une seule place par écran dans le HTML', () => {
    // Chaque vue / panneau / feuille de l'application contient au plus un emplacement.
    for (const [html, container] of [[index, /<(section|div|dialog) id="([a-z-]+)"[^>]*>/g], [adminHtml, /<section id="([a-z-]+)"/g]]) {
      const ids = [...html.matchAll(container)].map((m) => ({ id: m[m.length - 1], at: m.index }));
      const slots = [...html.matchAll(/data-mascot="([a-z-]+)"/g)].map((m) => m.index);
      const owners = slots.map((at) => ids.filter((c) => c.at < at).pop().id);
      expect(new Set(owners).size).toBe(owners.length);
    }
  });

  test('jamais dans les listes ni dans le fil', () => {
    for (const fn of ['function postCard', 'function gridTile', 'function communityCard', 'function chatRow', 'function activityRow', 'function myOfferCard', 'function storyFace']) {
      const start = app.indexOf(fn);
      const body = app.slice(start, app.indexOf('\n}\n', start));
      expect([fn, /bear\(|mascot/.test(body)]).toEqual([fn, false]);
    }
  });
});

describe('emplacements', () => {
  test('en-têtes et feuilles : 72 à 96 px', () => {
    for (const [, name, size] of [...index.matchAll(/data-mascot="([a-z-]+)" data-mascot-size="(\d+)"/g), ...adminHtml.matchAll(/data-mascot="([a-z-]+)" data-mascot-size="(\d+)"/g)]) {
      expect([name, Number(size) >= 72 && Number(size) <= 96]).toEqual([name, true]);
    }
    expect(index).toMatch(/<div class="auth-card-head">\s*<span class="mascot-head" data-mascot="bienvenue"/);
    expect(index).toMatch(/id="ppanel-security"[^>]*>\s*<span class="mascot-head" data-mascot="securite"/);
    expect(index).toMatch(/id="ppanel-settings"[^>]*>\s*<span class="mascot-head" data-mascot="reglages"/);
    expect(index).toMatch(/id="learn-view"[^>]*>\s*<span class="mascot-head" data-mascot="guides"/);
    expect(index).toMatch(/id="install-banner"[^>]*>\s*<span class="install-banner-mascot" data-mascot="tuto-telephone"/);
    expect(adminHtml).toContain('data-mascot="admin-support" data-mascot-size="88"');
  });

  test('états vides : 120 à 160 px', () => {
    for (const [, name, size] of [...app.matchAll(/bear\('([a-z-]+)', (\d+)\)/g), ...admin.matchAll(/bear\('([a-z-]+)', (\d+)\)/g)]) {
      const header = ['fiche-validee', 'fiche-refusee'].includes(name);
      const ok = header ? size >= 72 && size <= 96 : size >= 120 && size <= 160;
      expect([name, size, ok]).toEqual([name, size, true]);
    }
    expect(app).toMatch(/search-empty mascot-state' \}, bear\('aucun-resultat', 140\)/);
    expect(app).toMatch(/activity-empty mascot-state' \}, bear\('vide-dodo', 140\)/);
    expect(app).toMatch(/chat-empty mascot-state' \}, bear\('aucun-message', 120\)/);
    expect(app).toMatch(/chat-hint mascot-state' \}, bear\('aucun-message', 120\)/);
    expect(app).toContain("const NO_MESSAGE_TEXT = 'Pas encore de message. Pose ta question, l’équipe te répond ici.';");
    expect(admin).toContain("bear('admin-moderation', 140), h('p', null, 'Tout est traité.')");
  });

  test('toasts, hors ligne, déconnexion, chargement lent', () => {
    expect(app).toContain("{ mascot: 'bravo' }");
    expect(app).toContain("{ mascot: 'story-selfie' }");
    expect(app).toContain("{ mascot: 'notifications' }");
    expect(app).toMatch(/mascot: 'bienvenue', duration: 4000/);
    expect(app).toMatch(/window\.addEventListener\('online', paint\);\s*window\.addEventListener\('offline', paint\);/);
    expect(index).toMatch(/<div id="offline-banner"[^>]*hidden>\s*<span data-mascot="hors-ligne"/);
    expect(app).toContain('const GOODBYE_MS = 1500;');
    expect(app).toMatch(/showLoggedOut\(\);\s*showAuthForm\('login-form'\);\s*await sayGoodbye\(\);/);
    const boot = read('boot.js');
    expect(boot).toContain('const PATIENCE_MS = 3000;');
    expect(boot).toContain("button.textContent = 'Réessayer';");
    expect(boot).toContain("mascots.mascot('patience', { size: 120 })");
  });

  test('chargé par les deux pages, avant leur script', () => {
    expect(index.indexOf('src="mascot.js"')).toBeLessThan(index.indexOf('src="app.js"'));
    expect(adminHtml.indexOf('src="/mascot.js"')).toBeLessThan(adminHtml.indexOf('src="/admin.js"'));
    expect(index).toContain('<link rel="stylesheet" href="mascot.css" />');
    expect(adminHtml).toContain('<link rel="stylesheet" href="/mascot.css" />');
  });
});

describe('prefers-reduced-motion', () => {
  test('entrée douce (fondu + rebond) coupée', () => {
    const css = read('mascot.css');
    expect(css).toMatch(/@keyframes mascot-in \{[^@]*opacity: 0;[^@]*scale\(\.92\)/);
    expect(css).toMatch(/img\.mascot \{[^}]*animation: mascot-in 420ms/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*img\.mascot \{ animation: none !important; \}/);
  });
});

describe('focus des menus, feuilles et fenêtres', () => {
  const css = read('app-v2.css');

  test('anneau --brand de 2 px au clavier seulement, jamais orange', () => {
    expect(css).toMatch(/:is\(\.bubble-menu, \.sv-menu, \[role="menu"\], \.sheet, \.app-dialog\) :focus:not\(:focus-visible\),[^{]*\{ outline: none; box-shadow: none; \}/);
    expect(css).toMatch(/:is\(\.bubble-menu, \.sv-menu, \[role="menu"\], \.sheet, \.app-dialog\) :focus-visible \{\s*outline: 2px solid var\(--brand\);/);
    expect(css).toContain('--v2-focus: var(--brand);');
    expect(read('styles.css')).toContain('--focus: var(--brand);');
    // L'ambre reste pour les statuts « en attente », plus pour le focus.
    expect(css).not.toMatch(/focus[^;{}]*#f59e0b/i);
  });
});

describe('avatar de l’équipe', () => {
  test('ours rond, 128 px jusqu’à 64 px affichés, 256 px au-delà, alt « Équipe Haissel »', async () => {
    for (const size of [128, 256]) {
      const meta = await sharp(path.join(FRONTEND, `images/mascotte/avatar-equipe-${size}.webp`)).metadata();
      expect([meta.width, meta.height]).toEqual([size, size]);
    }
    expect(app).toMatch(/const file = size <= 64 \? 'avatar-equipe-128\.webp' : 'avatar-equipe-256\.webp';/);
    expect(app).toContain("alt: 'Équipe Haissel'");
    expect(read('app-v2.css')).toMatch(/img\.team-avatar \{ border-radius: 50%;/);
    // Activité : même avatar ; le logo H reste celui de l'app.
    expect(app).toContain("h('span', { className: 'activity-icon is-team' }, teamAvatar(40))");
    expect(admin).toContain("src: '/images/mascotte/avatar-equipe-128.webp', alt: 'Équipe Haissel'");
    expect(index).toContain('<img class="wordmark-logo" src="/logo.svg"');
  });
});

describe('Découvrir vide', () => {
  test('ours 22 (160 px), titre, sous-titre, « Actualiser » ; roue sur fond sombre avant chargement', () => {
    expect(M.POSES).toContain('rien-a-decouvrir');
    expect(M.src('rien-a-decouvrir')).toBe('/images/mascotte/ours-22-rien-a-decouvrir.webp');
    expect(fs.existsSync(path.join(FRONTEND, 'images/mascotte/ours-22-rien-a-decouvrir.webp'))).toBe(true);
    const empty = app.slice(app.indexOf('function discoverEmpty('), app.indexOf('function showDiscoverLoading('));
    expect(empty).toContain("bear('rien-a-decouvrir', 160)");
    expect(empty).toContain("'Rien à découvrir pour le moment'");
    expect(empty).toContain("'Les nouvelles offres arrivent ici dès qu’elles sont validées.'");
    expect(empty).toContain("'Actualiser'");
    expect(app).toContain('ui.discoverFeed.replaceChildren(...(list.length ? list.map(discoverSlide) : [discoverEmpty()]));');
    expect(index).toMatch(/<div id="discover-feed"[^>]*>\s*<!--[^>]*-->\s*<section class="discover-slide is-empty" aria-busy="true">\s*<span class="spinner is-lg" role="status"/);
    const css = read('app-v2.css');
    expect(css).toMatch(/\.discover-empty-title \{[^}]*font-size: 20px; font-weight: 800;/);
    expect(css).toMatch(/\.discover-empty-text \{[^}]*font-size: 15px;/);
    expect(css).toMatch(/animation: mascot-in 420ms[^;]*, bear-search 4s ease-in-out 600ms infinite;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*img\.mascot\.discover-bear \{ animation: none !important; \}/);
  });
});
