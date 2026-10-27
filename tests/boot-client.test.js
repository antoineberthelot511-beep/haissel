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

/*
 * Non-régression « Illegal invocation » : dans un navigateur, window.setTimeout
 * refuse d'être appelé avec un autre « this » que window (ou undefined).
 * Node l'accepte : ces faux timers reproduisent la règle du navigateur.
 */
describe('timers par défaut, comme dans un navigateur', () => {
  function browserLike() {
    const body = fakeElement('body');
    const screen = fakeElement('div');
    body.append(screen);
    const sandbox = vm.createContext({});
    // Global vu depuis le code chargé (le « window » du navigateur simulé).
    const inner = vm.runInContext('this', sandbox);
    sandbox.window = inner;
    const strict = (native) => function guarded(...args) {
      if (this !== undefined && this !== inner && this !== sandbox) throw new TypeError('Illegal invocation');
      return native(...args);
    };
    sandbox.setTimeout = strict((fn, ms) => setTimeout(fn, ms));
    sandbox.clearTimeout = strict((id) => clearTimeout(id));
    sandbox.document = {
      getElementById: (id) => (id === 'boot-screen' && body.children.includes(screen) ? screen : null),
      createElement: fakeElement,
    };
    sandbox.location = { reload: jest.fn() };
    return { sandbox, screen, strict };
  }

  test('les faux timers refusent un autre « this » (comme le navigateur)', () => {
    const { sandbox } = browserLike();
    const detached = { setTimeout: sandbox.setTimeout };
    expect(() => detached.setTimeout(() => {}, 0)).toThrow('Illegal invocation');
  });

  test('boot.js se charge, définit HaisselBoot et retire l’écran avec ses timers par défaut', () => {
    const { sandbox, screen } = browserLike();
    expect(() => vm.runInContext(SOURCE, sandbox)).not.toThrow();
    expect(typeof sandbox.HaisselBoot.ready).toBe('function');
    expect(() => sandbox.HaisselBoot.ready()).not.toThrow();
    jest.advanceTimersByTime(800);
    expect(sandbox.document.getElementById('boot-screen')).toBeNull();
    expect(screen.classList.contains('is-leaving')).toBe(true);
  });

  test('create() sans timers fournis, puis « Réessayer » au bout de 10 s', () => {
    const { sandbox } = browserLike();
    vm.runInContext(SOURCE, sandbox);
    const body = fakeElement('body');
    const screen = fakeElement('div');
    body.append(screen);
    const doc = { getElementById: () => screen, createElement: fakeElement };
    expect(() => sandbox.HaisselBoot.create({ doc, reload: jest.fn() })).not.toThrow();
    jest.advanceTimersByTime(10000);
    expect(findText(screen, 'Réessayer')).toBe(true);
  });
});

describe('filets de sécurité', () => {
  const css = fs.readFileSync(path.join(__dirname, '../frontend/app-v2.css'), 'utf8');

  test('.boot-screen a une animation de secours à 12 s (sans JavaScript)', () => {
    const rule = css.match(/\.boot-screen\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/animation:\s*boot-failsafe\s+0s\s+12s\s+forwards/);
    const keyframes = css.match(/@keyframes boot-failsafe\s*\{[^}]*\}/)[0];
    expect(keyframes).toMatch(/opacity:\s*0/);
    expect(keyframes).toMatch(/visibility:\s*hidden/);
    expect(keyframes).toMatch(/pointer-events:\s*none/);
  });

  test('boot-failsafe.js est chargé avant </body>', () => {
    const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
    expect(html).toMatch(/<script src="boot-failsafe\.js"><\/script>\s*<\/body>/);
  });
});
