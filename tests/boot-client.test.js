/*
 * Écran de démarrage (frontend/boot.js) : retiré après le premier rendu,
 * « Réessayer » au bout de 10 s sans signal.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/boot.js'), 'utf8');

// DOM minimal : juste ce que boot.js utilise.
function fakeElement(tag) {
  const listeners = {};
  const classes = new Set();
  const element = {
    tag, children: [], attributes: {}, textContent: '', parent: null,
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { if (listeners.click) listeners.click(); },
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); },
  };
  return element;
}

function setup() {
  const body = fakeElement('body');
  const screen = fakeElement('div');
  screen.append(fakeElement('div'));
  body.append(screen);
  const doc = {
    getElementById: (id) => (id === 'boot-screen' && body.children.includes(screen) ? screen : null),
    createElement: fakeElement,
  };
  const sandbox = { window: {} };
  vm.runInNewContext(SOURCE, sandbox);
  const reload = jest.fn();
  const boot = sandbox.window.HaisselBoot.create({ doc, timers: { setTimeout, clearTimeout }, now: () => Date.now(), reload });
  return { boot, body, screen, doc, reload };
}

const findText = (node, text) => node.textContent === text || node.children.some((child) => findText(child, text));

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('#boot-screen reste au moins 600 ms, puis fondu de 200 ms et retrait', () => {
  const { boot, doc, screen } = setup();
  boot.ready(); // tout est prêt tout de suite
  jest.advanceTimersByTime(599);
  expect(screen.classList.contains('is-leaving')).toBe(false);
  jest.advanceTimersByTime(1);
  expect(screen.classList.contains('is-leaving')).toBe(true);
  expect(doc.getElementById('boot-screen')).toBe(screen);
  jest.advanceTimersByTime(200);
  expect(doc.getElementById('boot-screen')).toBeNull();
  // Plus de « Connexion lente » une fois prêt.
  jest.advanceTimersByTime(10000);
  expect(findText(screen, 'Réessayer')).toBe(false);
});

test('premier rendu après 600 ms : fondu immédiat, sans attente supplémentaire', () => {
  const { boot, doc, screen } = setup();
  jest.advanceTimersByTime(900);
  boot.ready();
  jest.advanceTimersByTime(0);
  expect(screen.classList.contains('is-leaving')).toBe(true);
  jest.advanceTimersByTime(200);
  expect(doc.getElementById('boot-screen')).toBeNull();
});

test('le loader est visible immédiatement (plus de délai de 300 ms)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../frontend/app-v2.css'), 'utf8');
  expect(css).not.toMatch(/boot-show/);
  expect(css).not.toMatch(/\.boot-screen \.loader\s*\{[^}]*opacity:\s*0/);
});

test('après 10 s sans signal : « Connexion lente… » et « Réessayer » qui recharge', () => {
  const { screen, reload } = setup();
  jest.advanceTimersByTime(9999);
  expect(findText(screen, 'Réessayer')).toBe(false);
  jest.advanceTimersByTime(1);
  expect(findText(screen, 'Connexion lente…')).toBe(true);
  const button = screen.children[0].children.find((n) => n.textContent === 'Réessayer');
  button.click();
  expect(reload).toHaveBeenCalledTimes(1);
});

test('le premier rendu après le message de lenteur retire quand même l’écran', () => {
  const { boot, doc } = setup();
  jest.advanceTimersByTime(10000);
  boot.ready();
  jest.advanceTimersByTime(200);
  expect(doc.getElementById('boot-screen')).toBeNull();
});
