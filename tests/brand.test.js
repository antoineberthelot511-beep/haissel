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
    // Pages légales : autonomes (sans styles.css, qui redéfinissait --brand en vert), brand.css puis legal.css.
    for (const page of ['cgu.html', 'confidentialite.html', 'mentions-legales.html', 'transparence.html']) {
      const html = read(page);
      expect([page, at(html, 'styles.css')]).toEqual([page, -1]);
      expect([page, at(html, '/brand.css') > -1 && at(html, '/brand.css') < at(html, 'legal.css')]).toEqual([page, true]);
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
  const sandbox = { requestAnimationFrame: (fn) => fn(), matchMedia: () => ({ matches: false }), Math, Number };
  sandbox.window = sandbox;
  vm.runInNewContext(read('tuto-ios.js'), sandbox);
  const T = sandbox.HaisselTuto;

  // DOM minimal : ce que tuto-ios.js utilise.
  function fakeDoc() {
    const el = (tag) => {
      const classes = new Set();
      const node = {
        tag, children: [], attributes: {}, listeners: {}, textContent: '', innerHTML: '', style: {},
        offsetLeft: 0, clientWidth: 300, scrollLeft: 0,
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); String(value).split(' ').filter(Boolean).forEach((c) => classes.add(c)); },
        classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
        get firstChild() { return node.children[0]; },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        scrollTo() {},
      };
      return node;
    };
    return { createElement: el, createTextNode: (text) => ({ text }) };
  }
  const walk = (node, out = []) => {
    out.push(node);
    (node.children || []).forEach((child) => walk(child, out));
    return out;
  };

  test('5 étapes, légendes dans un seul tableau', () => {
    expect(T.CAPTIONS).toEqual([
      'Touche le bouton ≡ à gauche de l’adresse', 'Choisis « Partager »', 'Touche « En voir plus »',
      'Choisis « Sur l’écran d’accueil »', 'Active « Ouvrir comme app web », puis touche « Ajouter »',
    ]);
    expect(T.STEPS).toBe(5);
  });

  test('5 images 519×998 à place réservée, légende, Précédent / Suivant, « C’est parti »', () => {
    const doc = fakeDoc();
    const track = doc.createElement('div');
    track.ownerDocument = doc;
    const [dots, next, prev, caption] = ['div', 'button', 'button', 'p'].map((tag) => doc.createElement(tag));
    const onDone = jest.fn();
    T.mount({ track, dots, next, prev, caption, onDone });
    expect(track.children).toHaveLength(5);
    track.children.forEach((slide, index) => {
      const img = slide.children[0];
      expect(img).toMatchObject({
        className: 'tuto-image', src: `/images/tuto-ios/etape-${index + 1}.webp`, width: 519, height: 998,
        alt: `Étape ${index + 1} : ${T.CAPTIONS[index]}`, loading: index === 0 ? 'eager' : 'lazy', decoding: 'async',
      });
    });
    expect(caption.textContent).toBe(T.CAPTIONS[0]);
    expect(prev.classList.contains('is-hidden')).toBe(true);
    for (let i = 0; i < 4; i += 1) next.listeners.click();
    expect(next.textContent).toBe('C’est parti');
    expect(caption.textContent).toBe(T.CAPTIONS[4]);
    prev.listeners.click();
    expect(next.textContent).toBe('Suivant');
    next.listeners.click();
    next.listeners.click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('images présentes, même taille (canevas transparent commun), préparées par npm run tuto:build', async () => {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    const size = JSON.parse(read('images/tuto-ios/size.json'));
    expect(size).toEqual({ width: T.IMAGE_WIDTH, height: T.IMAGE_HEIGHT });
    for (let n = 1; n <= 5; n += 1) {
      const meta = await sharp(path.join(FRONTEND, `images/tuto-ios/etape-${n}.webp`)).metadata();
      expect([n, meta.width, meta.height, meta.hasAlpha]).toEqual([n, size.width, size.height, true]);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts['tuto:build']).toBe('node scripts/tuto-build.js');
    expect(fs.readFileSync(path.join(__dirname, '../scripts/tuto-build.js'), 'utf8')).toContain("path.join(ROOT, 'design/tuto-ios-v2')");
  });

  test('glissement : l’image qui arrive grandit de 0,92 à 1', () => {
    expect(T.MIN_SCALE).toBe(0.92);
    expect(T.scaleFor(0)).toBe(1);
    expect(T.scaleFor(1)).toBeCloseTo(0.92);
    expect(T.scaleFor(-0.5)).toBeCloseTo(0.96);
    expect(T.scaleFor(3)).toBeCloseTo(0.92);
  });

  test('feuille : titre sans ours, téléphone détouré 300 px max sans cadre, ratio réservé, légende 2 lignes, boutons', () => {
    const html = read('index.html');
    const sheet = html.slice(html.indexOf('id="howto-sheet"'), html.indexOf('</dialog>', html.indexOf('id="howto-sheet"')));
    expect(sheet).not.toContain('data-mascot');
    expect(sheet).toContain('Installe HAISSEL en 30 secondes');
    expect(sheet.indexOf('id="tuto-track"')).toBeLessThan(sheet.indexOf('id="tuto-caption"'));
    expect(sheet.indexOf('id="tuto-caption"')).toBeLessThan(sheet.indexOf('id="tuto-dots"'));
    expect(sheet.indexOf('id="tuto-prev"')).toBeLessThan(sheet.indexOf('id="tuto-next"'));
    const css = read('app-v2.css');
    expect(css).toContain('--tuto-w: min(100%, 300px, calc((92dvh - 280px) * 519 / 998));');
    expect(css).toMatch(/\.tuto-image \{[^}]*width: var\(--tuto-w\); max-width: 300px; height: auto; aspect-ratio: 519 \/ 998;[^}]*padding: 0; border: 0; border-radius: 0; background: none; box-shadow: none;/);
    expect(css).toContain('.tuto-prev.is-hidden { display: none; }');
    expect(css).toMatch(/\.tuto-caption \{[^}]*min-height: calc\(2 \* 1\.3em\); max-height: calc\(2 \* 1\.3em\);[^}]*font-size: 17px;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.tuto-image \{ transition: none; transform: none !important; \}/);
  });
});
