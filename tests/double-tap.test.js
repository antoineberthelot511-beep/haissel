/*
 * Double tap (frontend/double-tap.js) : deux pointerup < 300 ms et < 30 px,
 * sans mouvement ; un défilement annule. Branchement dans app.js (Découvrir).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const APP_JS = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(FRONTEND, 'app-v2.css'), 'utf8');
const sandbox = {};
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'double-tap.js'), 'utf8'), sandbox);
const { createDetector } = sandbox.HaisselDoubleTap;

const tap = (d, x, y, t) => { d.down(x, y, t); return d.up(x, y, t + 40); };

describe('détecteur', () => {
  test('deux taps rapprochés : double tap', () => {
    const d = createDetector();
    expect(tap(d, 100, 100, 0)).toBe(false);
    expect(tap(d, 110, 105, 200)).toBe(true);
    // Le suivant repart de zéro.
    expect(tap(d, 110, 105, 300)).toBe(false);
  });

  test('trop lent, trop loin, ou un seul tap : rien', () => {
    const slow = createDetector();
    tap(slow, 100, 100, 0);
    expect(tap(slow, 100, 100, 400)).toBe(false);
    const far = createDetector();
    tap(far, 100, 100, 0);
    expect(tap(far, 150, 100, 150)).toBe(false);
    expect(tap(createDetector(), 100, 100, 0)).toBe(false);
  });

  test('un mouvement (défilement) ou une annulation entre les deux : rien', () => {
    const moved = createDetector();
    tap(moved, 100, 100, 0);
    moved.down(100, 100, 150);
    moved.move(100, 140);
    expect(moved.up(100, 140, 190)).toBe(false);
    const cancelled = createDetector();
    tap(cancelled, 100, 100, 0);
    cancelled.cancel();
    expect(tap(cancelled, 100, 100, 150)).toBe(false);
  });
});

describe('Découvrir', () => {
  const fn = (name) => APP_JS.slice(APP_JS.indexOf(`function ${name}(`), APP_JS.indexOf('\n}\n', APP_JS.indexOf(`function ${name}(`)));

  test('jamais « désenregistrer », rien pour sa propre offre ou hors connexion', () => {
    const body = fn('saveFromDoubleTap');
    expect(body).toContain('if (!state.user || !offer || offer.is_mine) return;');
    expect(body).toContain('if (!offer.saved && !button.disabled) {\n    toggleSave(offer, button);');
    expect(body).not.toMatch(/toggleSave\([^)]*\)[\s\S]*toggleSave\(/);
  });

  test('zones exclues, Pointer Events et pas de dblclick', () => {
    expect(APP_JS).toContain("const DISCOVER_NO_DOUBLE_TAP = 'button, a, input, .discover-caption, .discover-who, .discover-badges, .discover-actions';");
    expect(fn('bindDiscoverDoubleTap')).toContain("feed.addEventListener('pointerup'");
    expect(APP_JS).not.toContain('dblclick');
  });

  test('signet : pointer-events none, 600 ms, retiré du DOM, rien en mouvement réduit', () => {
    expect(CSS).toMatch(/\.discover-burst \{[^}]*pointer-events: none;[^}]*animation: discover-burst 600ms/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.discover-burst \{ display: none; \}/);
    expect(fn('discoverBurst')).toContain("burst.addEventListener('animationend', remove, { once: true });");
  });
});

describe('Accueil', () => {
  const body = APP_JS.slice(APP_JS.indexOf('function bindPostDoubleTap('), APP_JS.indexOf('\n}\n', APP_JS.indexOf('function bindPostDoubleTap(')));

  test('double tap sur l’image : même enregistrement, simple tap = ouverture différée', () => {
    expect(body).toContain("open.addEventListener('pointerup'");
    expect(body).toContain("saveFromDoubleTap(offer, card.querySelector('.post-actions .save-button')");
    expect(body).toContain('event.detail === 0');
    expect(APP_JS).toContain('bindPostDoubleTap(open, offer, card);');
    expect(CSS).toContain('.post-open { touch-action: manipulation; }');
  });
});
