/*
 * Bleu du logo (#0B57FF) : palette centrale (frontend/brand.css), contrastes,
 * plus aucun ancien bleu. Tuto d'installation iPhone : carrousel limité aux
 * étapes dont l'image existe.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, readPalette } = require('../scripts/check-contrast');

const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return /\.(css|js|html|webmanifest|svg)$/.test(entry.name) ? [full] : [];
  });
}

describe('palette de marque', () => {
  test('variables centralisées autour de #0B57FF', () => {
    const palette = readPalette();
    expect(palette.brand).toBe('#0B57FF');
    for (const name of ['brand-strong', 'brand-soft', 'brand-on', 'brand-on-dark', 'brand-fixed', 'brand-ink', 'brand-light']) {
      expect([name, /^#[0-9A-F]{6}$/i.test(palette[name] || '')]).toEqual([name, true]);
    }
    expect(read('brand.css')).toContain('--brand-rgb: 11, 87, 255;');
  });

  test('chargée par toutes les pages, sans être écrasée', () => {
    const at = (html, href) => html.indexOf(`<link rel="stylesheet" href="${href}" />`);
    for (const page of ['index.html', 'admin.html']) {
      const html = read(page);
      const first = html.indexOf('<link rel="stylesheet"');
      expect([page, first]).toEqual([page, at(html, '/brand.css')]);
    }
    // Pages légales : après styles.css, qui définit aussi --brand (vert).
    for (const page of ['cgu.html', 'confidentialite.html', 'mentions-legales.html', 'transparence.html']) {
      const html = read(page);
      expect([page, at(html, '/brand.css') > at(html, 'styles.css')]).toEqual([page, true]);
    }
  });

  test('contrastes ≥ 4,5:1 (scripts/check-contrast.js)', () => {
    const failed = check().filter((r) => !r.ok).map((r) => `${r.label} ${r.ratio.toFixed(2)}`);
    expect(failed).toEqual([]);
  });

  test('plus aucune occurrence de l’ancien bleu dans frontend/', () => {
    const old = /#2563eb|#1d4ed8|#1e40af|#3b82f6|#60a5fa|#93c5fd|#9ec1ff|37,\s*99,\s*235/i;
    const hits = listFiles(FRONTEND).filter((file) => old.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(FRONTEND, file));
    expect(hits).toEqual([]);
  });

  test('l’interface utilise les variables', () => {
    const css = read('app-v2.css');
    expect(css).toContain('--v2-primary: var(--brand);');
    expect(css).toContain('--v2-primary-container: var(--brand);');
    expect(css).toContain(':root { --loader-color: var(--brand); }');
    expect(read('liquid-glass.css')).toContain('--lg-drop: rgba(var(--brand-rgb), .12);');
  });

  test('couleurs de statut inchangées', () => {
    const admin = read('admin.css');
    expect(admin).toContain('--ok: #0f7b4b;');
    expect(admin).toContain('--bad: #b42335;');
    expect(admin).toContain('--warn: #9a5b00;');
  });
});

describe('tuto d’installation iPhone', () => {
  const sandbox = { requestAnimationFrame: (fn) => fn() };
  sandbox.window = sandbox;
  vm.runInNewContext(read('tuto-ios.js'), sandbox);
  const T = sandbox.HaisselTuto;

  test('légendes dans un seul tableau, 5 au plus', () => {
    expect(T.CAPTIONS).toEqual([
      'Touche le bouton ≡ à gauche de l’adresse', 'Choisis « Partager »', 'Touche « En voir plus »',
      'Choisis « Sur l’écran d’accueil »', 'Active « Ouvrir comme app web », puis touche « Ajouter »',
    ]);
    expect(T.MAX_STEPS).toBe(5);
  });

  test('seules les étapes dont l’image existe sont affichées', () => {
    expect(T.availableSteps({}).length).toBe(0);
    const steps = T.availableSteps({ 1: { file: 'etape-1.webp', width: 207, height: 433 }, 3: { file: 'etape-3.webp', width: 208, height: 427 }, 5: { file: 'etape-5.webp', width: 205, height: 429 } });
    expect(steps.map((s) => s.number)).toEqual([1, 3, 5]);
    expect(steps[0]).toMatchObject({
      src: '/images/tuto-ios/etape-1.webp', alt: 'Étape 1 : Touche le bouton ≡ à gauche de l’adresse', width: 207, height: 433,
    });
    // Jamais plus de 5 étapes.
    expect(T.availableSteps({ 6: { file: 'etape-6.webp' } })).toEqual([]);
    // Nom inattendu ignoré (pas de chemin arbitraire).
    expect(T.availableSteps({ 2: '../../evil.svg' })).toEqual([]);
  });

  test('carrousel : images paresseuses à hauteur réservée, points, « Suivant » puis « C’est parti »', () => {
    const el = (tag) => {
      const node = {
        tag, children: [], attributes: {}, listeners: {}, textContent: '', hidden: false, ownerDocument: null,
        offsetLeft: 0, clientWidth: 300, scrollLeft: 0,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        scrollTo() {},
      };
      return node;
    };
    const doc = { createElement: el };
    const track = el('div');
    track.ownerDocument = doc;
    const dots = el('div');
    const next = el('button');
    const onDone = jest.fn();
    sandbox.HaisselTutoFiles = { 1: { file: 'etape-1.webp', width: 207, height: 433 }, 2: { file: 'etape-2.webp', width: 216, height: 451 } };
    const tuto = T.mount({ track, dots, next, onDone });

    expect(tuto.count).toBe(2);
    expect(track.children).toHaveLength(2);
    const img = track.children[0].children[0];
    // Taille réelle de l'image : place réservée, jamais agrandie.
    expect(img).toMatchObject({ loading: 'lazy', width: 207, height: 433, alt: 'Étape 1 : Touche le bouton ≡ à gauche de l’adresse' });
    expect(dots.children).toHaveLength(2);
    expect(dots.children[0].attributes['aria-current']).toBe('step');
    expect(next.textContent).toBe('Suivant');
    next.listeners.click();
    expect(next.textContent).toBe('C’est parti');
    expect(dots.children[1].attributes['aria-current']).toBe('step');
    next.listeners.click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('images générées et listées avec leur taille (npm run tuto:build)', () => {
    const steps = { window: {} };
    vm.runInNewContext(read('images/tuto-ios/steps.js'), steps);
    const files = steps.window.HaisselTutoFiles;
    expect(Object.keys(files).length).toBeGreaterThan(0);
    for (const { file, width, height } of Object.values(files)) {
      expect([file, fs.existsSync(path.join(FRONTEND, 'images/tuto-ios', file))]).toEqual([file, true]);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(width);
    }
    // Pas d'agrandissement : largeur maximale = largeur réelle.
    expect(read('app-v2.css')).toMatch(/\.tuto-image \{[^}]*width: auto; height: auto; max-width: 100%/);
    const html = read('index.html');
    expect(html.indexOf('src="images/tuto-ios/steps.js"')).toBeLessThan(html.indexOf('src="tuto-ios.js"'));
    expect(html).not.toContain('class="howto-steps"');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts['tuto:build']).toBe('node scripts/tuto-build.js');
    expect(pkg.devDependencies.sharp).toBeTruthy();
  });
});
