/*
 * Swipe entre les onglets (frontend/tab-swipe.js) : geste horizontal de
 * 40 % → onglet voisin ; geste vertical, départ dans .stories-row ou feuille
 * ouverte → rien. Pointer Events simulés sur un faux conteneur.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const APP_JS = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(FRONTEND, 'app-v2.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const sandbox = {};
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'tab-swipe.js'), 'utf8'), sandbox);
const Swipe = sandbox.HaisselTabSwipe;

const WIDTH = 400;

/* Élément cible : closest() répond pour les sélecteurs de ses « ancêtres ». */
const target = (...classes) => ({
  closest: (selector) => (selector.split(',').map((s) => s.trim()).some((s) => classes.includes(s)) ? {} : null),
});

function setup({ view = 'home', blocked = false, reduced = false } = {}) {
  const listeners = {};
  const state = { view, blocked, went: [], painted: [] };
  Swipe.bind({ addEventListener: (type, fn) => { listeners[type] = fn; } }, {
    view: () => state.view,
    width: () => WIDTH,
    isBlocked: () => state.blocked,
    scrollsHorizontally: () => false,
    reduced: () => reduced,
    paint: (dx) => state.painted.push(dx),
    go: (next) => { state.went.push(next); state.view = next; },
  });
  // Geste : départ (x, y), arrivée (x + dx, y + dy) en 10 pas sur 300 ms.
  state.gesture = ({ x = 200, y = 300, dx = 0, dy = 0, from = target(), ms = 300 }) => {
    listeners.pointerdown({ pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y, timeStamp: 0, target: from });
    for (let i = 1; i <= 10; i += 1) {
      listeners.pointermove({ pointerId: 1, clientX: x + (dx * i) / 10, clientY: y + (dy * i) / 10, timeStamp: (ms * i) / 10 });
    }
    listeners.pointerup({ pointerId: 1, type: 'pointerup', clientX: x + dx, clientY: y + dy, timeStamp: ms });
  };
  return state;
}

describe('changement d’onglet', () => {
  test('geste horizontal de 40 % vers la gauche : onglet suivant ; vers la droite : précédent', () => {
    const s = setup({ view: 'discover' });
    s.gesture({ dx: -0.4 * WIDTH });
    expect(s.went).toEqual(['messages']);
    s.gesture({ dx: 0.4 * WIDTH });
    expect(s.went).toEqual(['messages', 'discover']);
    // L'écran a suivi le doigt, puis est revenu en place.
    expect(s.painted.some((dx) => dx < -100)).toBe(true);
    expect(s.painted[s.painted.length - 1]).toBe(0);
  });

  test('ordre Accueil ↔ Découvrir ↔ Messages ↔ Recherche ↔ Profil, rien au-delà (élastique)', () => {
    expect([...Swipe.TABS]).toEqual(['home', 'discover', 'messages', 'links', 'profile']);
    const first = setup({ view: 'home' });
    first.gesture({ dx: 0.4 * WIDTH });
    expect(first.went).toEqual([]);
    expect(Math.max(...first.painted)).toBeCloseTo(0.4 * WIDTH * Swipe.SWIPE.elastic);
    const last = setup({ view: 'profile' });
    last.gesture({ dx: -0.4 * WIDTH });
    expect(last.went).toEqual([]);
  });

  test('geste court et lent : retour en place ; lancer rapide : changement', () => {
    const slow = setup({ view: 'home' });
    slow.gesture({ dx: -0.15 * WIDTH, ms: 600 });
    expect(slow.went).toEqual([]);
    const fast = setup({ view: 'home' });
    fast.gesture({ dx: -0.15 * WIDTH, ms: 60 });
    expect(fast.went).toEqual(['discover']);
  });
});

describe('aucun changement', () => {
  test('geste vertical', () => {
    const s = setup();
    s.gesture({ dx: 60, dy: 300 });
    expect(s.went).toEqual([]);
    expect(s.painted).toEqual([]);
  });

  test('geste qui commence dans .stories-row', () => {
    const s = setup();
    s.gesture({ dx: -0.4 * WIDTH, from: target('.stories-row') });
    expect(s.went).toEqual([]);
  });

  test('champ de saisie, conversation ouverte, bord de l’écran (retour iOS)', () => {
    for (const from of [target('input'), target('textarea'), target('.chat')]) {
      const s = setup({ view: 'messages' });
      s.gesture({ dx: -0.4 * WIDTH, from });
      expect(s.went).toEqual([]);
    }
    const edge = setup();
    edge.gesture({ x: 10, dx: 0.4 * WIDTH });
    expect(edge.went).toEqual([]);
  });

  test('geste qui commence dans le fil de Découvrir', () => {
    const s = setup({ view: 'discover' });
    s.gesture({ dx: -0.4 * WIDTH, from: target('.discover-feed') });
    expect(s.went).toEqual([]);
    expect(s.painted).toEqual([]);
  });

  test('feuille ouverte', () => {
    const s = setup({ blocked: true });
    s.gesture({ dx: -0.4 * WIDTH });
    expect(s.went).toEqual([]);
  });

  test('mouvement réduit : pas de suivi du doigt, changement direct', () => {
    const s = setup({ reduced: true });
    s.gesture({ dx: -0.4 * WIDTH });
    expect(s.went).toEqual(['discover']);
    expect(s.painted).toEqual([0]);
  });
});

describe('branchement', () => {
  test('app.js : même chemin qu’un tap, feuilles et modales bloquent, position gardée', () => {
    expect(APP_JS).toContain('bindTabSwipe();');
    expect(APP_JS).toContain(`isBlocked: () => Boolean(document.querySelector('dialog[open], [aria-modal="true"], .m-menu-in'))`);
    const switchTab = APP_JS.slice(APP_JS.indexOf('function switchTab('), APP_JS.indexOf('function bindTabSwipe('));
    expect(switchTab).toContain('setActiveView(next);');
    expect(switchTab).toContain('tabScroll[from] = window.scrollY;');
    // Régression iOS : jamais de touch-action sur #main (ancêtre du fil fixe de Découvrir).
    expect(CSS).not.toMatch(/#main {[^}]*touch-action/);
    expect(CSS).toContain('.view-panel:not(#discover-view) { touch-action: pan-y; }');
    expect(CSS).toContain('.discover-slide { touch-action: manipulation; }');
    // Jamais de transformation posée sur le fil de Découvrir.
    expect(APP_JS).toContain("return view === 'discover' ? null : document.getElementById(");
    expect(INDEX.indexOf('src="tab-swipe.js"')).toBeLessThan(INDEX.indexOf('src="app.js"'));
  });
});
