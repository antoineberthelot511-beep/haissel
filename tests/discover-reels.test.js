/*
 * Découvrir façon Reels : slide plein écran, colonne d'actions (Enregistrer,
 * Infos, Visiter si can_open, « ⋯ » sauf sa propre offre), feuille
 * Description avec lignes dépliables. Fonctions de app.js exécutées telles
 * quelles avec un mini DOM.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const APP_JS = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(FRONTEND, 'app-v2.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

const fnSource = (name) => {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(name);
  const asyncStart = APP_JS.lastIndexOf('async ', start) === start - 6 ? start - 6 : start;
  return APP_JS.slice(asyncStart, APP_JS.indexOf('\n}\n', start) + 2);
};

function el(tag) {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  const node = {
    tag, attrs, children: [], disabled: false, offsetWidth: 1, isConnected: true,
    setAttribute(k, v) { attrs[k] = String(v); if (k === 'class') String(v).split(/\s+/).forEach((c) => c && classes.add(c)); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    click() { return listeners.click?.(); },
    replaceChildren(...kids) { node.children = kids.flat().filter((c) => c !== null && c !== undefined && c !== false); },
    focus() {},
    get dataset() {
      return Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-'))
        .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase()), v]));
    },
  };
  return node;
}

function h(tag, props, ...children) {
  const node = el(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.replaceChildren(...children);
  return node;
}

/* Tous les nœuds d'un arbre. */
function walk(node, out = []) {
  if (node && typeof node === 'object' && node.tag) {
    out.push(node);
    node.children.forEach((c) => walk(c, out));
  }
  return out;
}
const byClass = (root, c) => walk(root).filter((n) => n.classList.contains(c));
const byLabel = (root, label) => walk(root).find((n) => n.getAttribute('aria-label') === label) || null;
const text = (node) => (typeof node === 'string' ? node : node.children.map(text).join(''));

function load() {
  const calls = { api: [], leave: [], report: [], sheets: [] };
  const sheetBody = el('div');
  const moreBody = el('div');
  const disclosureSandbox = {};
  disclosureSandbox.window = disclosureSandbox;
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'disclosure.js'), 'utf8'), disclosureSandbox);
  const ctx = {
    h,
    icon: (name) => h('svg', { 'data-icon': name }),
    window: { HaisselDisclosure: disclosureSandbox.HaisselDisclosure, alert() {} },
    state: {},
    ui: { communitySaved: { checked: false }, discoverSheet: { id: 'discover-sheet' }, discoverMoreSheet: { id: 'discover-more-sheet' } },
    document: {
      activeElement: null,
      getElementById: (id) => ({ 'discover-sheet-body': sheetBody, 'discover-more-body': moreBody }[id] || { id }),
    },
    api: async (url, opts) => { calls.api.push([url, opts.method]); return {}; },
    loadCommunity() {},
    storyTimeLeft: () => null,
    categoryVisual: (cat, className, ...kids) => h('div', { className }, ...kids),
    categoryIcon: () => h('svg', null),
    storyAvatar: () => h('span', { className: 'story-avatar' }),
    kindBadge: () => h('span', { className: 'kind-badge' }),
    openMember() {},
    confirmLeave: (offer) => calls.leave.push(offer.id),
    openReport: (offer) => calls.report.push(offer.id),
    openSheet: (sheet) => calls.sheets.push(['open', sheet.id]),
    closeSheet: (sheet) => calls.sheets.push(['close', sheet.id]),
  };
  vm.runInNewContext([
    'teamBadge', 'paintSaveButton', 'saveButtonFor', 'toggleSave', 'disclosureRow', 'discoverAction',
    'discoverSlide', 'discoverSheetContent', 'openDiscoverSheet', 'openDiscoverMore',
  ].map(fnSource).join('\n') + '\nthis.discoverSlide = discoverSlide;', ctx);
  return { ctx, calls, sheetBody, moreBody };
}

const offer = (extra = {}) => ({
  id: 7, title: 'Pass Culture', description: 'Une longue description de l’offre.', category: 'autre',
  expected_action: 'Créer ton compte', conditions: 'Résider en France', countries: 'FR', min_age: 15,
  member_benefit: null, author: { username: 'equipe' }, from_team: true, can_open: true, is_mine: false, saved: false,
  kind: 'free', ...extra,
});

describe('slide', () => {
  test('Enregistrer, Infos, Visiter et ⋯ ; plus de discover-side ni de discover-text', () => {
    const { ctx } = load();
    const slide = ctx.discoverSlide(offer());
    expect(byLabel(slide, 'Enregistrer')).not.toBeNull();
    expect(byLabel(slide, 'Infos sur « Pass Culture »')).not.toBeNull();
    expect(byLabel(slide, 'Visiter le site de « Pass Culture » (site externe)')).not.toBeNull();
    expect(byLabel(slide, 'Plus d’options pour « Pass Culture »')).not.toBeNull();
    expect(byClass(slide, 'discover-side')).toHaveLength(0);
    expect(byClass(slide, 'discover-text')).toHaveLength(0);
    expect(byClass(slide, 'lg-glass')).toHaveLength(0);
    // Plus de « Ce qu'il faut faire » dans le fil.
    expect(text(slide)).not.toContain('Ce qu’il faut faire');
    // Mini ours de l'équipe sur la ligne auteur.
    expect(byClass(slide, 'team-pill')).toHaveLength(1);
  });

  test('Visiter seulement si can_open ; ⋯ (Signaler) absent si is_mine', () => {
    const { ctx } = load();
    const blocked = ctx.discoverSlide(offer({ can_open: false }));
    expect(walk(blocked).some((n) => /^Visiter/.test(n.getAttribute('aria-label') || ''))).toBe(false);
    const mine = ctx.discoverSlide(offer({ is_mine: true }));
    expect(walk(mine).some((n) => /^Plus d’options/.test(n.getAttribute('aria-label') || ''))).toBe(false);
    expect(byLabel(mine, 'Enregistrer')).toBeNull();
  });

  test('Visiter passe par confirmLeave ; ⋯ ouvre le menu puis Signaler', () => {
    const { ctx, calls, moreBody } = load();
    const slide = ctx.discoverSlide(offer());
    byLabel(slide, 'Visiter le site de « Pass Culture » (site externe)').click();
    expect(calls.leave).toEqual([7]);
    byLabel(slide, 'Plus d’options pour « Pass Culture »').click();
    expect(calls.sheets).toContainEqual(['open', 'discover-more-sheet']);
    const report = walk(moreBody).find((n) => n.tag === 'button' && text(n) === 'Signaler');
    report.click();
    expect(calls.report).toEqual([7]);
  });

  test('Enregistrer bascule l’état avec le même endpoint qu’avant', async () => {
    const { ctx, calls } = load();
    const data = offer();
    const slide = ctx.discoverSlide(data);
    const save = byLabel(slide, 'Enregistrer');
    await save.click();
    expect(calls.api).toEqual([['/api/community/offers/7/save', 'POST']]);
    expect(data.saved).toBe(true);
    expect(save.getAttribute('aria-label')).toBe('Enregistré');
    expect(save.getAttribute('aria-pressed')).toBe('true');
    expect(walk(save).some((n) => n.getAttribute('data-icon') === 'i-bookmark-fill')).toBe(true);
    expect(save.classList.contains('is-popping')).toBe(true);
    await save.click();
    expect(calls.api[1]).toEqual(['/api/community/offers/7/save', 'DELETE']);
    expect(save.getAttribute('aria-label')).toBe('Enregistrer');
  });
});

describe('feuille Description', () => {
  test('s’ouvre depuis Infos ou la légende, lignes repliées puis dépliées et repliées', () => {
    const { ctx, calls, sheetBody } = load();
    const slide = ctx.discoverSlide(offer({ member_benefit: '' }));
    byLabel(slide, 'Lire la description de « Pass Culture »').click();
    byLabel(slide, 'Infos sur « Pass Culture »').click();
    expect(calls.sheets.filter(([what, id]) => what === 'open' && id === 'discover-sheet')).toHaveLength(2);

    expect(text(sheetBody)).toContain('Une longue description de l’offre.');
    expect(walk(sheetBody).some((n) => text(n) === 'Visiter le site')).toBe(true);
    const rows = walk(sheetBody).filter((n) => n.classList.contains('od-row'));
    // « Ce que tu y gagnes » vide : pas de ligne.
    expect(rows.map((r) => text(r))).toEqual(['Comment en profiter', 'Conditions']);
    for (const row of rows) {
      expect(row.getAttribute('aria-expanded')).toBe('false');
      expect(row.getAttribute('aria-controls')).toMatch(/^od-panel-ds-/);
      row.click();
      expect(row.getAttribute('aria-expanded')).toBe('true');
      row.click();
      expect(row.getAttribute('aria-expanded')).toBe('false');
    }
  });

  test('« Visiter le site » absent si le lien ne peut pas être ouvert', () => {
    const { ctx, sheetBody } = load();
    byLabel(ctx.discoverSlide(offer({ can_open: false })), 'Infos sur « Pass Culture »').click();
    expect(walk(sheetBody).some((n) => text(n) === 'Visiter le site')).toBe(false);
  });

  test('feuille en verre avec poignée, reliée au geste commun ; ~70 % de l’écran', () => {
    expect(INDEX).toMatch(/<dialog id="discover-sheet" class="sheet discover-sheet"[^>]*>\s*<div class="sheet-panel lg-glass lg-sheet">\s*<div class="sheet-grabber"/);
    expect(APP_JS).toContain("bindSheet(ui.discoverSheet, { onClose: restoreDiscoverFocus });");
    expect(CSS).toContain('.discover-sheet .sheet-panel { height: 70dvh;');
  });
});

describe('CSS', () => {
  test('plein écran au-dessus de la barre du bas, barre de défilement masquée', () => {
    expect(CSS).toMatch(/\.discover-feed \{[^}]*inset: 0 0 calc\(var\(--v2-nav-height\) \+ env\(safe-area-inset-bottom, 0px\)\) 0;[^}]*scrollbar-width: none;[^}]*scroll-snap-type: y mandatory/);
    expect(CSS).toContain('.discover-feed::-webkit-scrollbar { display: none; }');
    expect(CSS).toMatch(/\.discover-card \{[^}]*position: absolute; inset: 0; margin: 0; border-radius: 0;/);
    expect(CSS).toMatch(/\.discover-shade \{[^}]*rgba\(0, 0, 0, \.6\)/);
  });

  test('zones tactiles ≥ 44 px, pop 200 ms coupé en mouvement réduit', () => {
    expect(CSS).toMatch(/\.discover-action, \.discover-actions \.save-button \{[^}]*min-width: 52px; min-height: 52px;/);
    expect(CSS).toContain('.discover-action.is-popping .icon { animation: discover-pop 200ms ease-out; }');
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.discover-action\.is-popping \.icon \{ animation: none; \}/);
  });
});
