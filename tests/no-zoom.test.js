/* iPhone sans zoom : viewport, touch-action, filet touchend (frontend/no-zoom.js). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const INDEX = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(FRONTEND, 'app-v2.css'), 'utf8');

function load(view = 'discover') {
  const handlers = {};
  const document = {
    body: { dataset: { view } },
    addEventListener: (type, fn, opts) => { handlers[type] = { fn, opts }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'no-zoom.js'), 'utf8'), { document });
  return handlers;
}
const event = (t, x, y, target = { closest: () => null }) => {
  const e = { timeStamp: t, changedTouches: [{ clientX: x, clientY: y }], target, cancelable: true, prevented: false };
  e.preventDefault = () => { e.prevented = true; };
  return e;
};

test('viewport et touch-action', () => {
  expect(INDEX).toContain('content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"');
  expect(INDEX.indexOf('src="no-zoom.js"')).toBeLessThan(INDEX.indexOf('src="app.js"'));
  expect(CSS).toContain('html { touch-action: manipulation; }');
  expect(CSS).toMatch(/input, textarea, select \{ font-size: max\(16px, 1em\) !important; \}/);
});

test('second touchend rapproché annulé, non passif ; saisie jamais bloquée', () => {
  const h = load();
  expect(h.touchend.opts).toEqual({ passive: false });
  const a = event(0, 100, 100); h.touchend.fn(a);
  const b = event(200, 110, 110); h.touchend.fn(b);
  expect([a.prevented, b.prevented]).toEqual([false, true]);
  const far = event(400, 300, 300); h.touchend.fn(far);
  const slow = event(900, 300, 300); h.touchend.fn(slow);
  expect([far.prevented, slow.prevented]).toEqual([false, false]);
  const input = { closest: () => ({}) };
  h.touchend.fn(event(1000, 50, 50, input));
  const c = event(1100, 50, 50, input); h.touchend.fn(c);
  expect(c.prevented).toBe(false);
});

test('pincement bloqué seulement dans Découvrir et le fil', () => {
  for (const [view, blocked] of [['discover', true], ['home', true], ['profile', false]]) {
    const h = load(view);
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    h.gesturestart.fn(e);
    expect([view, e.prevented]).toEqual([view, blocked]);
  }
});
