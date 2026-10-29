/*
 * Geste des feuilles du bas (frontend/sheet-gesture.js) : fermeture au-delà
 * de 25 % ou sur un lancer, retour en deçà, aucun effet d'un balayage
 * horizontal ; branchement commun à toutes les feuilles.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const sandbox = { Math };
vm.runInNewContext(read('sheet-gesture.js'), sandbox);
const G = sandbox.HaisselSheetGesture;

/** Glissement de (0, 0) jusqu'à (x, y) en `ms`, par pas de 16 ms. */
function slide(height, x, y, ms) {
  const drag = G.createSheetDrag({ height });
  drag.start(0, 0, 0);
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i += 1) drag.move((x * i) / steps, (y * i) / steps, (ms * i) / steps);
  return drag;
}

describe('geste « glisser vers le bas »', () => {
  test('fermeture au-delà de 25 % de la hauteur (glissement lent)', () => {
    const drag = slide(800, 0, 220, 2000);
    expect(drag.axis).toBe('down');
    expect(drag.end()).toBe('close');
  });

  test('retour en deçà de 25 % (glissement lent)', () => {
    const drag = slide(800, 0, 150, 2000);
    expect(drag.dy).toBe(150);
    expect(drag.end()).toBe('restore');
  });

  test('lancer rapide : fermeture même sur une courte distance', () => {
    expect(slide(800, 0, 120, 80).end()).toBe('close');
  });

  test('balayage horizontal (carrousel) : abandonné, rien ne se ferme', () => {
    const drag = slide(800, -300, 40, 200);
    expect(drag.axis).toBe('other');
    expect(drag.dy).toBe(0);
    expect(drag.end()).toBe('ignore');
  });

  test('vers le haut : abandonné', () => {
    expect(slide(800, 0, -200, 200).end()).toBe('ignore');
  });

  test('direction décidée au premier mouvement (8 px)', () => {
    expect(G.lockAxis(3, 4)).toBeNull();
    expect(G.lockAxis(2, 10)).toBe('down');
    expect(G.lockAxis(10, 4)).toBe('other');
    expect(G.SHEET_GESTURE.closeRatio).toBe(0.25);
  });

  test('le fond s’éclaircit à mesure que la feuille descend', () => {
    expect(G.backdropOpacity(0, 800)).toBe(1);
    expect(G.backdropOpacity(400, 800)).toBe(0.6);
    expect(G.backdropOpacity(2000, 800)).toBe(0.2);
  });
});

describe('branchement', () => {
  const app = read('app.js');
  const css = read('app-v2.css');

  test('toutes les feuilles passent par bindSheet et le même geste', () => {
    const bind = app.slice(app.indexOf('function bindSheet('), app.indexOf('let filtersBefore'));
    expect(bind).toContain('Gesture.createSheetDrag({ height: panel.offsetHeight })');
    expect(bind).toContain("if (axis === 'other') { entry.drag = null; return; }");
    expect(bind).toContain("dialog.addEventListener('cancel'");
    expect(bind).toContain('if (event.target === dialog) closeSheet(dialog);');
    for (const id of ['ui.filtersSheet', 'ui.howtoSheet', 'ui.installSheet']) expect(app).toContain(`bindSheet(${id}`);
    const html = read('index.html');
    expect((html.match(/<dialog id="[a-z-]+" class="sheet/g) || []).length).toBe((app.match(/bindSheet\(ui\.\w+Sheet/g) || []).length);
    expect(html.indexOf('src="sheet-gesture.js"')).toBeLessThan(html.indexOf('src="app.js"'));
  });

  test('poignée et titre : touch-action none, zone tactile élargie ; fond lié au glissement', () => {
    expect(css).toContain('.sheet-grabber, .sheet-title { touch-action: none; }');
    expect(css).toMatch(/\.sheet-grabber \{[^}]*padding: 10px 40px;[^}]*background-clip: content-box;/);
    expect(css).toContain('.sheet[open]::backdrop { opacity: var(--sheet-fade, 1); }');
  });

  test('tuto : focus initial sur « Suivant », contour du carrousel au clavier seulement', () => {
    expect(read('index.html')).toMatch(/<button id="tuto-next" class="primary-button sheet-apply" type="button" autofocus>Suivant<\/button>/);
    expect(css).toContain('.tuto-track:focus { outline: none; }');
    expect(css).toContain('.tuto-track:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }');
  });
});

test('focus initial sans anneau tant que le clavier n’a pas servi', () => {
  const app = read('app.js');
  expect(app).toMatch(/dialog\.dataset\.noRing = '';\s*dialog\.addEventListener\('keydown', \(\) => \{ delete dialog\.dataset\.noRing; \}, \{ once: true \}\);/);
  expect(read('app-v2.css')).toContain('.sheet[data-no-ring] :focus { outline: none; box-shadow: none; }');
});
