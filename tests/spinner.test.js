/*
 * Roue de chargement et « tirer pour rafraîchir » (frontend/spinner.js,
 * spinner.css, motion.js) : seuil, retour sans rechargement, rechargement
 * au-delà du seuil, geste vertical seulement, mouvement réduit, loader à
 * carrés réservé à l'écran de démarrage.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');

function loadPure() {
  const sandbox = { Math, Number, Object, String };
  vm.runInNewContext(read('spinner.js'), sandbox);
  return sandbox.HaisselSpinner;
}
const S = loadPure();

describe('logique', () => {
  test('arc de 0 à 270° jusqu’au seuil (70 px), qui tourne avec la distance', () => {
    expect(S.PTR.threshold).toBe(70);
    expect(S.pullState(0)).toMatchObject({ progress: 0, sweep: 0, armed: false });
    expect(S.pullState(35)).toMatchObject({ progress: 0.5, sweep: 135, armed: false });
    expect(S.pullState(70)).toMatchObject({ progress: 1, sweep: 270, armed: true });
    expect(S.pullState(300).sweep).toBe(270);
    expect(S.pullState(40).rotate).toBeGreaterThan(S.pullState(20).rotate);
  });

  test('lâcher : rechargement au-delà du seuil, sinon rien', () => {
    expect(S.releaseDecision(69)).toBe('cancel');
    expect(S.releaseDecision(70)).toBe('refresh');
    expect(S.releaseDecision(0)).toBe('cancel');
  });

  test('geste vertical vers le bas seulement', () => {
    expect(S.lockAxis(2, 3)).toBeNull();
    expect(S.lockAxis(1, 20)).toBe('down');
    expect(S.lockAxis(30, 10)).toBe('other');
    expect(S.lockAxis(0, -20)).toBe('other');
  });
});

/* Fenêtre et document minimaux pour faire tourner pullToRefresh. */
function harness() {
  const listeners = {};
  const timers = [];
  const make = (tag) => {
    const classes = new Set();
    const node = {
      tag, children: [], attributes: {}, style: { setProperty() {} },
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(' ').filter(Boolean).forEach((c) => classes.add(c)); },
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c),
      },
      setAttribute(n, v) { this.attributes[n] = String(v); },
      append(...n) { this.children.push(...n); },
    };
    return node;
  };
  const doc = {
    readyState: 'complete', documentElement: { style: {}, dataset: {}, classList: { add() {}, remove() {} } },
    body: make('body'), createElement: make, createElementNS: (ns, tag) => make(tag),
    querySelectorAll: () => [], addEventListener() {},
  };
  const win = {
    Math, Number, Object, String, Promise, document: doc, scrollY: 0,
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    requestAnimationFrame: (fn) => fn(0),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    MutationObserver: function MO() { this.observe = () => {}; },
  };
  win.window = win;
  vm.runInNewContext(read('spinner.js'), win);
  vm.runInNewContext(read('motion.js'), win);
  const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
  const pull = async (dy, dx = 0) => {
    listeners.touchstart(touch(100, 100));
    for (let i = 1; i <= 10; i += 1) listeners.touchmove(touch(100 + (dx * i) / 10, 100 + (dy * i) / 10));
    await listeners.touchend({});
  };
  return { win, doc, pull, timers };
}

describe('tirer pour rafraîchir', () => {
  test('relâché avant le seuil : la pastille remonte, rien n’est rechargé', async () => {
    const { win, pull } = harness();
    const onRefresh = jest.fn(async () => {});
    const ptr = win.HaisselMotion.pullToRefresh({ isActive: () => true, onRefresh });
    await pull(50);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(ptr.indicator.classList.contains('is-leaving')).toBe(true);
  });

  test('seuil atteint : flèche cachée et rebond ; relâché : rechargement, pastille calée à 64 px puis disparue', async () => {
    const { win, pull, doc } = harness();
    let seenDuring = null;
    const ptr = win.HaisselMotion.pullToRefresh({
      isActive: () => true,
      onRefresh: async () => { seenDuring = { transform: ptr.indicator.style.transform, spinning: !ptr.wheel.classList.contains('is-determinate') }; },
    });
    expect(doc.documentElement.style.overscrollBehaviorY).toBe('contain');
    await pull(90);
    expect(seenDuring).toEqual({ transform: 'translateY(64px) scale(1)', spinning: true });
    expect(ptr.indicator.classList.contains('is-leaving')).toBe(true);
  });

  test('pendant la traction au-delà du seuil : classe is-armed (rebond, flèche cachée)', () => {
    const { win } = harness();
    const listeners = {};
    win.addEventListener = (type, fn) => { listeners[type] = fn; };
    const ptr = win.HaisselMotion.pullToRefresh({ isActive: () => true, onRefresh: async () => {} });
    listeners.touchstart({ touches: [{ clientX: 0, clientY: 0 }] });
    listeners.touchmove({ touches: [{ clientX: 0, clientY: 20 }] });
    expect(ptr.indicator.classList.contains('is-armed')).toBe(false);
    listeners.touchmove({ touches: [{ clientX: 0, clientY: 80 }] });
    expect(ptr.indicator.classList.contains('is-armed')).toBe(true);
    expect(ptr.wheel.classList.contains('is-armed')).toBe(true);
  });

  test('balayage horizontal, page défilée ou vue inactive : aucun rechargement', async () => {
    const horizontal = harness();
    const a = jest.fn(async () => {});
    horizontal.win.HaisselMotion.pullToRefresh({ isActive: () => true, onRefresh: a });
    await horizontal.pull(90, 200);
    expect(a).not.toHaveBeenCalled();

    const scrolled = harness();
    scrolled.win.scrollY = 300;
    const b = jest.fn(async () => {});
    scrolled.win.HaisselMotion.pullToRefresh({ isActive: () => true, onRefresh: b });
    await scrolled.pull(120);
    expect(b).not.toHaveBeenCalled();

    const inactive = harness();
    const c = jest.fn(async () => {});
    inactive.win.HaisselMotion.pullToRefresh({ isActive: () => false, onRefresh: c });
    await inactive.pull(120);
    expect(c).not.toHaveBeenCalled();
  });
});

describe('CSS', () => {
  const css = read('spinner.css');

  test('arc --brand de 3 px, bouts arrondis ; indéterminée : rotation 1,2 s linéaire + arc qui grandit/rétrécit', () => {
    expect(css).toMatch(/\.spinner \{[^}]*color: var\(--spinner-color, var\(--brand\)\);/);
    expect(css).toMatch(/\.spinner-arc \{[^}]*stroke-width: 3; stroke-linecap: round;[^}]*animation: spinner-dash 1\.2s ease-in-out infinite;/);
    expect(css).toMatch(/\.spinner-svg \{[^}]*animation: spinner-rotate 1\.2s linear infinite;/);
    expect(css).toMatch(/\.ptr \{[^}]*width: 40px; height: 40px;[^}]*border-radius: 50%;[^}]*backdrop-filter/);
    expect(css).toMatch(/\.ptr\.is-armed \{ animation: ptr-bounce/);
  });

  test('mouvement réduit : rotation lente seule, arc fixe, pas de rebond', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.spinner-svg \{ animation: spinner-rotate 2\.4s linear infinite !important; \}/);
    expect(block).toMatch(/\.spinner-arc \{ animation: none !important; stroke-dasharray: 40 60; \}/);
    expect(block).toContain('.ptr.is-armed { animation: none !important; }');
  });

  test('loader à carrés réservé à l’écran de démarrage', () => {
    const html = read('index.html');
    expect(html.match(/class="loader/g)).toHaveLength(1);
    expect(html).toContain('<div id="boot-screen" class="boot-screen"><div class="loader"');
    for (const file of ['app.js', 'motion.js']) expect([file, /className: 'loader|class="loader/.test(read(file))]).toEqual([file, false]);
    expect(read('app.js')).toContain('return window.HaisselSpinner.spinnerRow({ size: 28 });');
    expect(html.indexOf('src="spinner.js"')).toBeLessThan(html.indexOf('src="motion.js"'));
    expect(html).toContain('<link rel="stylesheet" href="spinner.css" />');
  });
});
