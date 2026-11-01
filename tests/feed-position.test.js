/*
 * Position dans le fil : ouvrir une publication à mi-fil puis revenir (bouton
 * « Retour » de l'app ou history.back / geste iOS) ramène à la même place,
 * jamais à l'accueil quand on vient d'un autre fil.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const APP_JS = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
const sandbox = {};
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'feed-position.js'), 'utf8'), sandbox);
const Feed = sandbox.HaisselFeedPosition;

const fnSource = (name) => {
  const start = APP_JS.indexOf(`function ${name}(`);
  return APP_JS.slice(start, APP_JS.indexOf('\n}\n', start) + 2);
};

/*
 * Petite page simulée : un fil de cartes de 400 px, une fenêtre de 800 px,
 * un historique avec pushState / back → popstate. Les fonctions openOffer,
 * closeOffer, leaveOfferView, rememberFeedPosition, restoreFeedPosition et
 * currentFeedKey sont celles de app.js, exécutées telles quelles.
 */
function simulatePage({ cards = 30, cardHeight = 400 } = {}) {
  const page = { scrollY: 0, view: 'home', cards, cardHeight, query: '' };
  const listeners = [];
  const stack = [{ state: null }];
  const history = {
    get state() { return stack[stack.length - 1].state; },
    pushState(state) { stack.push({ state }); },
    back() { stack.pop(); listeners.forEach((fn) => fn()); },
  };
  const card = (id) => ({ getBoundingClientRect: () => ({ top: (id - 1) * page.cardHeight - page.scrollY }) });
  const offerView = { classList: { contains: () => page.view !== 'offer' } };
  const env = {
    HaisselFeedPosition: Feed,
    CSS: { escape: (v) => v },
    history,
    scrollTo: ({ top }) => { page.scrollY = Math.max(0, top); },
    get scrollY() { return page.scrollY; },
    addEventListener: (type, fn) => { if (type === 'popstate') listeners.push(fn); },
  };
  env.window = env;
  const ctx = {
    window: env,
    state: { community: {} },
    ui: { memberDialog: { open: false }, offerDetail: { replaceChildren() {} } },
    document: {
      documentElement: { get scrollHeight() { return page.cards * page.cardHeight; } },
      querySelector(selector) {
        if (selector === '.view-panel:not(.hidden)') return { id: `${page.view}-view` };
        const match = selector.match(/^#(\w+)-view \[data-offer-id="(\d+)"\]$/);
        if (!match || match[1] !== page.view) return null;
        const id = Number(match[2]);
        return id <= page.cards ? card(id) : null;
      },
      getElementById: (id) => (id === 'offer-view' ? offerView : null),
    },
    closeDialog() {},
    offerDetail: () => [],
    communityQuery: () => page.query,
    setActiveView: (view) => { page.view = view; page.scrollY = 0; },
  };
  vm.runInNewContext([
    fnSource('openOffer'), 'const feedPositions = window.HaisselFeedPosition.createStore();',
    fnSource('currentFeedKey'), fnSource('feedCard'), fnSource('rememberFeedPosition'),
    fnSource('restoreFeedPosition'), fnSource('closeOffer'), fnSource('leaveOfferView'),
    "window.addEventListener('popstate', () => { if (!document.getElementById('offer-view').classList.contains('hidden')) closeOffer(); });",
    'this.openOffer = openOffer; this.leaveOfferView = leaveOfferView;',
  ].join('\n'), ctx);
  return { page, history, ctx };
}

describe('feed-position.js', () => {
  test('une position par vue et par filtres', () => {
    const store = Feed.createStore();
    store.save(Feed.feedKey('links', 'q=ciné'), { scroll: 900, offerId: 4, height: 5000 });
    expect(store.get(Feed.feedKey('links', 'q=ciné')).scroll).toBe(900);
    expect(store.get(Feed.feedKey('links', ''))).toBeNull();
    expect(store.get(Feed.feedKey('home', ''))).toBeNull();
  });

  test('même hauteur : position gardée ; hauteur changée : la carte, au même décalage', () => {
    const entry = { scroll: 1000, offerId: 3, height: 5000, cardOffset: 200 };
    expect(Feed.plan(entry, { height: 5000, cardTop: 1200 })).toEqual({ type: 'scroll', top: 1000 });
    expect(Feed.plan(entry, { height: 6000, cardTop: 1600 })).toEqual({ type: 'card', top: 1400 });
    expect(Feed.plan(entry, { height: 6000, cardTop: null })).toEqual({ type: 'scroll', top: 1000 });
    expect(Feed.plan(null, { height: 1 })).toEqual({ type: 'none' });
  });
});

describe('ouvrir à mi-fil puis revenir', () => {
  test('bouton « Retour » de l’app : même vue, même position', () => {
    const { page, ctx } = simulatePage();
    page.scrollY = 4100;
    ctx.openOffer({ id: 11 });
    expect(page.view).toBe('offer');
    ctx.leaveOfferView(); // history.back() → popstate → closeOffer
    expect(page.view).toBe('home');
    expect(page.scrollY).toBe(4100);
  });

  test('history.back (retour du navigateur, geste iOS) : même position', () => {
    const sim = simulatePage();
    sim.page.scrollY = 6300;
    sim.ctx.openOffer({ id: 16 });
    sim.history.back();
    expect(sim.page.view).toBe('home');
    expect(sim.page.scrollY).toBe(6300);
  });

  test('depuis Recherche avec un filtre : retour à Recherche, jamais à l’accueil', () => {
    const sim = simulatePage();
    sim.page.view = 'links';
    sim.page.query = 'category=education';
    sim.page.scrollY = 2000;
    sim.ctx.openOffer({ id: 6 });
    sim.history.back();
    expect(sim.page.view).toBe('links');
    expect(sim.page.scrollY).toBe(2000);
  });

  test('fil rechargé entre-temps (hauteur changée) : on retombe sur la carte ouverte', () => {
    const sim = simulatePage();
    sim.page.scrollY = 4000; // la carte 11 est à 0 px du haut de l'écran
    sim.ctx.openOffer({ id: 11 });
    sim.page.cardHeight = 500; // nouvelles cartes plus hautes
    sim.history.back();
    expect(sim.page.scrollY).toBe(5000); // carte 11 de nouveau en haut de l'écran
  });
});

describe('app.js', () => {
  test('scrollRestoration manuel, retour navigateur relié à closeOffer', () => {
    expect(APP_JS).toContain("window.history.scrollRestoration = 'manual'");
    expect(APP_JS).toMatch(/addEventListener\('popstate', \(\) => \{\n\s+if \(!document\.getElementById\('offer-view'\)\.classList\.contains\('hidden'\)\) closeOffer\(\);/);
  });

  test('les filtres gardent l’entrée d’historique de la publication ouverte', () => {
    expect(fnSource('syncFiltersToUrl')).toContain('replaceState(window.history.state,');
  });

  test('cartes du fil repérables par leur id', () => {
    for (const fn of ['postCard', 'gridTile', 'communityCard', 'discoverSlide']) {
      expect([fn, fnSource(fn).includes("'data-offer-id': offer.id")]).toEqual([fn, true]);
    }
  });
});
