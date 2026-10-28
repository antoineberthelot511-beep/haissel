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

  test('mini-écrans dessinés : aucune capture, un seul élément mis en évidence par écran, logo HAISSEL', () => {
    const doc = fakeDoc();
    const track = doc.createElement('div');
    track.ownerDocument = doc;
    const parts = ['div', 'button', 'button', 'p'].map((tag) => doc.createElement(tag));
    const [dots, next, prev, caption] = parts;
    const onDone = jest.fn();
    T.mount({ track, dots, next, prev, caption, onDone });
    expect(track.children).toHaveLength(5);
    const expected = ['ts-addr-btn', 'ts-row', 'ts-more', 'ts-row', 'ts-link'];
    track.children.forEach((slide, index) => {
      const nodes = walk(slide);
      const phone = slide.children[0];
      expect(phone.className).toBe('ts-phone');
      expect(phone.attributes['aria-hidden']).toBe('true');
      expect(slide.attributes['aria-label']).toBe(`Étape ${index + 1} sur 5 : ${T.CAPTIONS[index]}`);
      const highlighted = nodes.filter((n) => n.classList && n.classList.contains('ts-hl'));
      expect(highlighted).toHaveLength(1);
      expect(highlighted[0].classList.contains(expected[index])).toBe(true);
      // Doigt stylisé dans l'élément mis en évidence.
      expect(highlighted[0].children.some((c) => c.className === 'ts-finger')).toBe(true);
      // Aucune image sauf le logo HAISSEL.
      const imgs = nodes.filter((n) => n.tag === 'img');
      expect(imgs.every((img) => img.src === '/logo.svg')).toBe(true);
    });
    const texts = (index) => walk(track.children[index]).filter((n) => n.text).map((n) => n.text);
    expect(texts(1)).toContain('Partager');
    expect(texts(2)).toContain('En voir plus');
    expect(texts(3)).toContain('Sur l’écran d’accueil');
    expect(texts(4)).toEqual(expect.arrayContaining(['Ajouter', 'Ouvrir comme app web', 'HAISSEL']));
    expect(walk(track.children[4]).some((n) => n.className === 'ts-switch is-on')).toBe(true);
    expect(JSON.stringify(T.ICONS)).not.toMatch(/apple/i);

    // Navigation : légende, Précédent caché à l'étape 1, « C'est parti » à la dernière.
    expect(caption.textContent).toBe(T.CAPTIONS[0]);
    expect(prev.classList.contains('is-hidden')).toBe(true);
    expect(dots.children[0].attributes['aria-current']).toBe('step');
    for (let i = 0; i < 4; i += 1) next.listeners.click();
    expect(next.textContent).toBe('C’est parti');
    expect(caption.textContent).toBe(T.CAPTIONS[4]);
    expect(prev.classList.contains('is-hidden')).toBe(false);
    prev.listeners.click();
    expect(next.textContent).toBe('Suivant');
    next.listeners.click();
    next.listeners.click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('glissement : l’écran qui arrive grandit de 0,92 à 1', () => {
    expect(T.MIN_SCALE).toBe(0.92);
    expect(T.scaleFor(0)).toBe(1);
    expect(T.scaleFor(1)).toBeCloseTo(0.92);
    expect(T.scaleFor(-0.5)).toBeCloseTo(0.96);
    expect(T.scaleFor(3)).toBeCloseTo(0.92);
  });

  test('feuille : ours 96 px, titre, légende 17 px sur 2 lignes, Précédent + Suivant, taille 9:19 bornée à 220 px', () => {
    const html = read('index.html');
    const sheet = html.slice(html.indexOf('id="howto-sheet"'), html.indexOf('</dialog>', html.indexOf('id="howto-sheet"')));
    expect(sheet).toContain('data-mascot="tuto-telephone" data-mascot-size="96"');
    expect(sheet).toContain('Installe HAISSEL en 30 secondes');
    expect(sheet.indexOf('id="tuto-track"')).toBeLessThan(sheet.indexOf('id="tuto-caption"'));
    expect(sheet.indexOf('id="tuto-caption"')).toBeLessThan(sheet.indexOf('id="tuto-dots"'));
    expect(sheet.indexOf('id="tuto-prev"')).toBeLessThan(sheet.indexOf('id="tuto-next"'));
    const css = read('app-v2.css');
    expect(css).toMatch(/--ts-h: clamp\(236px, calc\(100dvh - 360px\), 464px\);\s*--ts-w: calc\(var\(--ts-h\) \* 9 \/ 19\);/);
    expect(css).toMatch(/\.tuto-caption \{[^}]*min-height: calc\(2 \* 1\.3em\); max-height: calc\(2 \* 1\.3em\);[^}]*font-size: 17px;[^}]*text-align: center;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ts-screen \.ts-hl \{ animation: none;/);
  });

  test('anciennes captures et script de génération supprimés (archive dans design/)', () => {
    expect(fs.existsSync(path.join(FRONTEND, 'images/tuto-ios'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../scripts/tuto-build.js'))).toBe(false);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts['tuto:build']).toBeUndefined();
    expect(read('index.html')).not.toContain('tuto-ios/steps.js');
    expect(fs.existsSync(path.join(__dirname, '../design/tuto-ios'))).toBe(true);
  });
});
