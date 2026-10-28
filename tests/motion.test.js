/*
 * Système de mouvement (frontend/motion.css, motion.js) : mouvement réduit,
 * propriétés animées, cascade limitée à 8 éléments, compteur du profil,
 * toast de publication.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const css = fs.readFileSync(path.join(FRONTEND, 'motion.css'), 'utf8');
const SOURCE = fs.readFileSync(path.join(FRONTEND, 'motion.js'), 'utf8');
const app = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');

function loadPure() {
  const sandbox = { Math, Number };
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.HaisselMotion;
}

describe('motion.css', () => {
  test('variables du système', () => {
    expect(css).toContain('--dur-1: 120ms;');
    expect(css).toContain('--dur-2: 220ms;');
    expect(css).toContain('--dur-3: 350ms;');
    expect(css).toContain('--ease-out: cubic-bezier(.2, .8, .2, 1);');
    expect(css).toMatch(/--spring: var\(--lg-spring/);
  });

  test('prefers-reduced-motion neutralise toutes les animations', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\*, \*::before, \*::after \{[^}]*animation-duration: 1ms !important;[^}]*animation-iteration-count: 1 !important;[^}]*transition-duration: 1ms !important;/);
    // Boucles coupées, fondus de 100 ms au plus.
    expect(block).toMatch(/\.activity-empty-icon, \.m-float, \.story-ring\.is-loading::before[^{]*\{ animation: none !important; \}/);
    expect(block).toMatch(/m-fade 100ms/);
    // Le filet de secours de l'écran de démarrage garde son délai de 12 s.
    expect(block).toContain('.boot-screen { animation-duration: 0s !important; animation-delay: 12s !important; }');
  });

  test('seulement transform et opacity (filter, et le tracé SVG de la coche)', () => {
    const allowed = new Set(['transform', 'opacity', 'filter', 'stroke-dashoffset']);
    for (const [, name, body] of css.matchAll(/@keyframes ([a-z-]+) \{([\s\S]*?)\}\s*\}?/g)) {
      for (const [, prop] of body.matchAll(/([a-z-]+)\s*:/g)) {
        expect([name, prop, allowed.has(prop)]).toEqual([name, prop, true]);
      }
    }
    expect(css).not.toMatch(/transition:[^;]*\b(width|height|top|left)\b/);
  });

  test('aucune animation ne bloque le toucher', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/pointer-events:\s*none/);
  });

  test('pas de View Transitions (mesurées trop coûteuses) : glissement CSS', () => {
    expect(SOURCE).not.toMatch(/startViewTransition\(/);
    expect(css).toMatch(/\.view-panel:not\(\.hidden\) \{ animation: m-slide-fwd/);
    expect(css).toMatch(/html\[data-nav-dir="back"\] \.view-panel:not\(\.hidden\) \{ animation-name: m-slide-back; \}/);
  });
});

describe('logique', () => {
  const M = loadPure();

  test('cascade : premier écran seulement, 8 éléments au plus', () => {
    const rects = Array.from({ length: 20 }, (_, i) => ({ top: i * 100, bottom: i * 100 + 90 }));
    expect(M.cascadeTargets(rects, 844)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(M.cascadeTargets(rects, 300)).toEqual([0, 1, 2]);
    // Éléments déjà au-dessus de l'écran ignorés.
    expect(M.cascadeTargets([{ top: -200, bottom: -10 }, { top: 0, bottom: 50 }], 844)).toEqual([1]);
    expect(M.CASCADE_MAX).toBe(8);
    expect(M.CASCADE_STEP_MS).toBe(30);
  });

  test('compteur du profil : de 0 à la valeur en 600 ms', () => {
    expect(M.COUNT_MS).toBe(600);
    expect(M.countAt(42, 0)).toBe(0);
    expect(M.countAt(42, 300)).toBeGreaterThan(21); // ralenti à la fin
    expect(M.countAt(42, 300)).toBeLessThan(42);
    expect(M.countAt(42, 600)).toBe(42);
    expect(M.countAt(42, 900)).toBe(42);
    const values = [0, 100, 200, 300, 400, 500, 600].map((t) => M.countAt(10, t));
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });
});

describe('toast de publication', () => {
  function fakeDom() {
    const nodes = [];
    const el = (tag) => {
      const node = {
        tag, children: [], className: '', attributes: {}, html: '', textContent: '',
        classList: { add: (c) => { node.className += ` ${c}`; }, contains: (c) => node.className.split(' ').includes(c) },
        setAttribute(name, value) { this.attributes[name] = value; },
        insertAdjacentHTML(where, html) { this.html += html; },
        append(...items) { this.children.push(...items); },
        remove() { nodes.splice(nodes.indexOf(node), 1); },
        addEventListener() {},
      };
      return node;
    };
    const doc = {
      readyState: 'complete', documentElement: { dataset: {}, classList: { add() {}, remove() {} } },
      createElement: el,
      querySelectorAll: () => [],
      body: { append: (node) => nodes.push(node) },
    };
    return { doc, nodes };
  }

  test('toast en verre depuis le haut, avec une coche dessinée', () => {
    const { doc, nodes } = fakeDom();
    const timers = [];
    const sandbox = {
      Math, Number, document: doc, setTimeout: (fn) => timers.push(fn),
      matchMedia: () => ({ matches: false }), MutationObserver: function MO() { this.observe = () => {}; },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(SOURCE, sandbox);
    sandbox.HaisselMotion.toast('Fiche envoyée à l’équipe');
    expect(nodes).toHaveLength(1);
    const toast = nodes[0];
    expect(toast.className).toContain('m-toast lg-glass lg-pill');
    expect(toast.attributes.role).toBe('status');
    const inner = toast.children[0];
    expect(inner.html).toMatch(/<svg class="m-check"[^>]*>.*<path d="M8 14.5l4 4 8-9"\/>/);
    expect(inner.children[0].textContent).toBe('Fiche envoyée à l’équipe');
    // Puis il repart et disparaît.
    timers.shift()();
    expect(toast.className).toContain('is-leaving');
    timers.shift()();
    expect(nodes).toHaveLength(0);
    expect(css).toMatch(/\.m-check path \{[^}]*stroke-dashoffset: 20;[^}]*animation: m-draw/);
    expect(css).toMatch(/@keyframes m-toast-in \{ from \{ opacity: 0; transform: translateY\(-24px\)/);
  });

  test('appelé après une publication réussie', () => {
    const handler = app.slice(app.indexOf('async function handlePublish'), app.indexOf('function renderMyLeadGuide'));
    expect(handler).toMatch(/window\.HaisselMotion\?\.toast\(editing \? 'Fiche modifiée' : 'Fiche envoyée à l’équipe', \{ mascot: 'bravo' \}\)/);
  });
});

describe('branchement', () => {
  test('chargé par la page, compteurs et pastilles câblés', () => {
    const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="motion.css" />');
    expect(html.indexOf('src="motion.js"')).toBeLessThan(html.indexOf('src="app.js"'));
    for (const id of ['bell-badge', 'nav-messages-badge']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*data-pop`));
    }
    // Pastilles de non-lu de la liste Messages (épinglée et ligne).
    expect(html.match(/data-unread-dot data-pop/g)).toHaveLength(2);
    expect(app).toContain('window.HaisselMotion.setCount(ui.statPublished, published);');
    expect(app).toMatch(/HaisselMotion\?\.cascade\(ui\.homeOffers\)/);
  });
});
