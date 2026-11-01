/*
 * Page d'une offre : lignes dépliables style Réglages iOS (disclosure.js).
 * Repliées par défaut, dépliage et repliage, aria-expanded à jour, ligne
 * absente si son contenu est vide, mouvement réduit respecté.
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
vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'disclosure.js'), 'utf8'), sandbox);

const fnSource = (name) => {
  const start = APP_JS.indexOf(`function ${name}(`);
  return APP_JS.slice(start, APP_JS.indexOf('\n}\n', start) + 2);
};

/* Élément minimal : attributs, classes, écouteurs ; assez pour disclosureRow. */
function fakeElement(tag) {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  return {
    tag, children: [], attrs,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    click() { listeners.click?.(); },
  };
}

function h(tag, props, ...children) {
  const el = fakeElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') el.setAttribute('class', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.children = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
  return el;
}

const ctx = { window: { HaisselDisclosure: sandbox.HaisselDisclosure }, h, icon: (name) => ({ icon: name }) };
vm.runInNewContext(`${fnSource('disclosureRow')}; this.disclosureRow = disclosureRow;`, ctx);

describe('disclosureRow', () => {
  test('repliée par défaut, puis dépliage et repliage, aria-expanded à jour', () => {
    const row = ctx.disclosureRow('terms', 'i-shield', 'Conditions', 'Texte des conditions');
    const [button, panel] = row.children;
    expect(button.tag).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(panel.getAttribute('id'));
    expect(panel.getAttribute('aria-labelledby')).toBe(button.getAttribute('id'));
    // Fermée : hors du clavier et des lecteurs d'écran.
    expect(panel.getAttribute('inert')).toBe('');

    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.getAttribute('inert')).toBeNull();
    expect(panel.classList.contains('is-open')).toBe(true);

    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.getAttribute('inert')).toBe('');
    expect(panel.classList.contains('is-open')).toBe(false);
  });

  test('icône à gauche, chevron à droite', () => {
    const [button] = ctx.disclosureRow('todo', 'i-check-circle', 'Comment en profiter', 'x').children;
    const [iconBox, label, chevron] = button.children;
    expect(iconBox.children[0]).toEqual({ icon: 'i-check-circle' });
    expect(label.children).toEqual(['Comment en profiter']);
    expect(chevron.children[0]).toEqual({ icon: 'i-chevron-right' });
  });

  test('contenu vide : pas de ligne', () => {
    for (const empty of [null, undefined, '', '   ', [], [null, '']]) {
      expect(ctx.disclosureRow('x', 'i-info', 'Vide', empty)).toBeNull();
    }
  });
});

describe('page d’une offre', () => {
  const detail = fnSource('offerDetail');

  test('infos principales en clair, sections repliées dans une liste groupée en verre', () => {
    const hero = detail.slice(detail.indexOf("'od-card od-hero'"), detail.indexOf("'od-group lg-glass'"));
    expect(hero).toContain('offer.description');
    expect(hero).toContain('confirmLeave(offer)');
    for (const label of ['Comment en profiter', 'Ce que tu y gagnes', 'Conditions']) {
      expect(detail).toContain(`'${label}'`);
    }
    // Plus de bloc « Ce qu'il faut faire » affiché d'office.
    expect(detail).not.toContain('offer-todo-title');
  });

  test('animation ~250 ms, chevron 90°, rien en mouvement réduit, pas de style en ligne', () => {
    expect(CSS).toMatch(/\.od-panel \{[^}]*grid-template-rows: 0fr;[^}]*250ms/);
    expect(CSS).toMatch(/\.od-row\[aria-expanded="true"\] \.od-row-chevron \{ transform: rotate\(90deg\); \}/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n\s+\.od-row-chevron, \.od-panel, \.od-panel\.is-open \{ transition: none; \}/);
    expect(fnSource('disclosureRow')).not.toMatch(/style/);
    expect(INDEX).toContain('<script src="disclosure.js"></script>');
    expect(INDEX).toContain('<script src="feed-position.js"></script>');
  });
});
