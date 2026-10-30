/*
 * « Liquid Glass » (frontend/liquid-glass.css) : composant .lg-glass posé sur
 * les éléments flottants seulement, jamais sur le contenu.
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const html = read('index.html');
const app = read('app.js');
const css = read('liquid-glass.css');
const appCss = read('app-v2.css');

/** Balise ouvrante qui contient `marker` (id, classe…). */
function tagWith(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`introuvable : ${marker}`);
  return source.slice(source.lastIndexOf('<', at), source.indexOf('>', at) + 1);
}
const classesOf = (tag) => (tag.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/);

describe('éléments flottants en verre', () => {
  test.each([
    ['class="topbar-glass', ['lg-glass', 'lg-bar', 'is-flat']],
    ['data-view="publish" data-publish-only', ['lg-glass', 'lg-pill', 'lg-press']],
    ['id="bell-button"', ['lg-glass', 'lg-pill', 'lg-press']],
    ['class="topbar-nav-inner', ['lg-glass', 'lg-pill']],
    ['id="community-filters"', ['lg-glass', 'lg-bar', 'is-flat']],
    ['id="filters-open"', ['lg-glass', 'lg-pill', 'lg-press']],
    ['class="chat-head', ['lg-glass', 'lg-bar']],
    ['id="chat-form"', ['lg-glass', 'lg-bar']],
  ])('%s', (marker, expected) => {
    const classes = classesOf(tagWith(html, marker));
    for (const name of expected) expect(classes).toContain(name);
  });

  test('toutes les feuilles du bas', () => {
    const panels = html.match(/<div class="sheet-panel[^"]*">/g);
    expect(panels.length).toBeGreaterThanOrEqual(2);
    for (const panel of panels) expect(panel).toContain('lg-glass lg-sheet');
    expect(css).toMatch(/\.sheet::backdrop \{[^}]*backdrop-filter/);
  });

  test('toasts et lecteur de stories (créés par le JavaScript)', () => {
    expect(read('notifications.js')).toContain("card.className = 'notif-card lg-glass lg-pill';");
    expect(app).toContain("className: 'sv-bars lg-glass lg-pill'");
    expect(app).toContain("className: 'sv-round lg-glass lg-pill lg-press', type: 'button', 'aria-label': 'Fermer'");
    expect(app).toContain("className: 'sv-menu lg-glass hidden'");
  });

  test('la pastille de non-lus reste pleine', () => {
    expect(classesOf(tagWith(html, 'id="bell-badge"'))).not.toContain('lg-glass');
  });
});

describe('pas de verre sur le contenu', () => {
  test('cartes, grilles, bulles, listes, formulaires', () => {
    for (const fn of ['function postCard', 'function gridTile', 'function communityCard', 'function chatRow', 'function activityRow', 'function linkCard']) {
      const start = app.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      // Seule exception : la pastille posée sur le visuel coloré de la carte.
      const body = app.slice(start, app.indexOf('\n}\n', start)).replace("'post-visual-icon lg-glass'", '');
      expect([fn, body.includes('lg-glass')]).toEqual([fn, false]);
    }
    for (const marker of ['id="home-offers"', 'id="community-list"', 'id="activity-list"', 'id="chat-messages"', 'class="about-list"', 'id="login-form"', 'id="leave-dialog"']) {
      expect([marker, classesOf(tagWith(html, marker)).includes('lg-glass')]).toEqual([marker, false]);
    }
    expect(html).not.toMatch(/class="[^"]*(panel-card|profile-card-box|offer-card)[^"]*lg-glass/);
  });

  test('pages légales et console admin', () => {
    for (const page of ['cgu.html', 'confidentialite.html', 'mentions-legales.html', 'transparence.html', 'admin.html', 'admin.js']) {
      expect([page, read(page).includes('lg-glass')]).toEqual([page, false]);
    }
  });
});

describe('composant CSS', () => {
  test('formes, enfoncement et ressort communs', () => {
    expect(css).toMatch(/\.lg-glass \{[^}]*backdrop-filter: blur\(16px\) saturate\(220%\) brightness\(1\.08\)/);
    for (const shape of ['.lg-pill', '.lg-bar', '.lg-sheet']) expect(css).toContain(`${shape} {`);
    expect(css).toMatch(/\.lg-press \{[^}]*var\(--lg-spring\)/);
    expect(css).toMatch(/\.lg-press:active \{[^}]*scale\(1\.03\)/);
  });

  test('réfraction SVG réservée à la barre du bas', () => {
    const uses = css.match(/url\(#lg-refract\)/g);
    expect(uses).toHaveLength(1);
    expect(css).toMatch(/\.lg-refract \.topbar-nav \.topbar-nav-inner \{\s*backdrop-filter: url\(#lg-refract\)/);
  });

  test('replis : transparence réduite, sans backdrop-filter, mouvement réduit', () => {
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*\.lg-glass:not\(\.is-flat\) \{ background: var\(--lg-solid\)/);
    expect(css).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.lg-press:active \{ transform: none; \}/);
  });

  test('aucune ressource externe', () => {
    expect(css).not.toMatch(/url\((?!#)/);
    expect(css).not.toMatch(/@import/);
  });

  test('verre prononcé : teintes, reflet spéculaire, liseré 1,5 px, ombres', () => {
    expect(css).toContain('--lg-tint: rgba(255, 255, 255, .18);');
    expect(css).toContain('--lg-tint: rgba(20, 22, 30, .28);');
    expect(css).toContain('-webkit-backdrop-filter: blur(16px) saturate(220%) brightness(1.08);');
    expect(css).toMatch(/\.lg-glass::before \{[^}]*linear-gradient\(150deg, rgba\(255, 255, 255, \.55\) 0%, rgba\(255, 255, 255, 0\) 33%\)[^}]*mix-blend-mode: soft-light/);
    expect(css).toMatch(/\.lg-glass::after,\s*\.lg-drop::before \{[^}]*padding: 1\.5px[^}]*rgba\(255, 255, 255, \.9\), rgba\(255, 255, 255, \.1\)/);
    expect(css).toMatch(/\.lg-glass \{[^}]*inset 0 1px 0 rgba\(255, 255, 255, \.8\), inset 0 -1px 1px rgba\(0, 0, 0, \.12\)/);
    expect(css).toMatch(/radial-gradient\(circle at var\(--lg-x\) var\(--lg-y\)/);
  });

  test('nouvelles surfaces en verre sur les visuels, jamais sur Réglages ni formulaires', () => {
    expect(app).toContain("className: 'post-visual-icon lg-glass'");
    expect(app).toContain("className: 'discover-text lg-glass'");
    expect(app).toContain("className: 'discover-side lg-glass lg-pill'");
    expect(html).toContain('class="profile-tabs lg-glass lg-bar is-flat"');
    expect(html).not.toMatch(/class="[^"]*(about-row|about-box|auth-form|bubble)[^"]*lg-glass/);
    expect(css).toMatch(/\.sheet::backdrop \{[^}]*blur\(14px\)/);
  });

  test('la barre du bas n’a plus de fond propre dans app-v2.css (rendu inchangé)', () => {
    const rule = appCss.match(/\.topbar-nav \.topbar-nav-inner \{[^}]*\}/)[0];
    expect(rule).not.toMatch(/background|backdrop-filter|box-shadow/);
  });

  test('en-tête : hystérésis (verre au-delà de 12 px, transparent sous 4 px), hauteur fixe', () => {
    const vm = require('vm');
    const sandbox = { document: { readyState: 'loading', addEventListener() {} }, navigator: {}, Math };
    sandbox.window = sandbox;
    vm.runInNewContext(read('liquid-glass.js'), sandbox);
    const { nextGlass } = sandbox.HaisselGlass;
    let glass = false;
    const seen = [0, 5, 10, 12, 13, 10, 5, 4, 3, -40, 13].map((y) => { glass = nextGlass(glass, y); return glass; });
    expect(seen).toEqual([false, false, false, false, true, true, true, true, false, false, true]);
    expect(read('liquid-glass.js')).toMatch(/addEventListener\('scroll', schedule, \{ passive: true \}\)/);
    expect(read('liquid-glass.js')).toContain('window.requestAnimationFrame(update)');
    expect(appCss).toMatch(/\.topbar \.topbar-inner \{[^}]*height: 64px/);
    expect(appCss).toMatch(/\.topbar \{[^}]*padding-top: env\(safe-area-inset-top, 0px\)/);
  });

  test('en-tête : pas de backdrop-filter sur .topbar (repère de la barre du bas)', () => {
    const rules = (css + appCss).match(/(^|\n)\.topbar \{[^}]*\}/g) || [];
    const withoutComments = (rule) => rule.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of rules) expect(withoutComments(rule)).not.toMatch(/backdrop-filter/);
  });
});
