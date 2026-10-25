/*
 * Logique navigateur des stories (frontend/stories.js) : regroupement par
 * auteur, offres ADMIN exclues, « vu » mémorisé localement et site
 * fonctionnel sans stockage.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/stories.js'), 'utf8');

function load() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.HaisselStories;
}

function memoryStorage() {
  const data = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

const brokenStorage = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

let n = 0;
function offer(username, overrides = {}) {
  n += 1;
  return {
    id: n, kind: 'campaign', status: 'published', expired: false, is_mine: false,
    shown_at: new Date(Date.UTC(2026, 9, 25, n)).toISOString(), author: { username }, ...overrides,
  };
}

describe('stories', () => {
  const S = load();

  test('un groupe par auteur, sans offres ADMIN, sans mes fiches ni fiches expirées', () => {
    const items = [
      offer('lea'), offer('tom'), offer('lea'),
      offer('equipe', { kind: 'affiliate' }),
      offer('moi', { is_mine: true }),
      offer('ancien', { expired: true }),
    ];
    const groups = S.groupStories(items);
    expect(groups.map((g) => g.username).sort()).toEqual(['lea', 'tom']);
    expect(groups.find((g) => g.username === 'lea').offers).toHaveLength(2);
    expect(S.ownStories(items).map((o) => o.author.username)).toEqual(['moi']);
  });

  test('un auteur dont tout est vu passe après les non vus', () => {
    const storage = memoryStorage();
    const a = offer('vu');
    const b = offer('nonvu');
    S.markSeen(storage, a);
    const groups = S.groupStories([a, b], S.readSeen(storage));
    expect(groups.map((g) => [g.username, g.unseen])).toEqual([['nonvu', true], ['vu', false]]);
  });

  test('une republication rend la fiche de nouveau non vue', () => {
    const storage = memoryStorage();
    const a = offer('lea');
    S.markSeen(storage, a);
    const renewed = { ...a, shown_at: new Date(Date.UTC(2026, 9, 27)).toISOString() };
    expect(S.groupStories([renewed], S.readSeen(storage))[0].unseen).toBe(true);
  });

  test('sans stockage utilisable, tout fonctionne et rien n est vu', () => {
    const a = offer('lea');
    expect(() => S.markSeen(brokenStorage, a)).not.toThrow();
    expect(S.readSeen(brokenStorage).size).toBe(0);
    expect(S.groupStories([a], S.readSeen(brokenStorage))[0].unseen).toBe(true);
  });

  test('le lecteur commence à la première fiche non vue', () => {
    const storage = memoryStorage();
    const list = [offer('lea'), offer('lea'), offer('lea')];
    S.markSeen(storage, list[0]);
    expect(S.startIndex(list, S.readSeen(storage))).toBe(1);
  });

  describe('gestes du lecteur', () => {
    const size = { width: 393, height: 727 };

    test('seuil de démarrage et direction', () => {
      expect(S.classifyGesture(3, 4)).toBeNull();
      expect(S.classifyGesture(2, 30)).toBe('dismiss');
      expect(S.classifyGesture(2, -30)).toBe('ignore');
      expect(S.classifyGesture(-40, 10)).toBe('author');
    });

    test('fermer au-delà de 25 % ou vite, sinon revenir', () => {
      expect(S.decideRelease('dismiss', { ...size, dy: 200 })).toBe('close');
      expect(S.decideRelease('dismiss', { ...size, dy: 60, vy: 0.9 })).toBe('close');
      expect(S.decideRelease('dismiss', { ...size, dy: 120, vy: 0.2 })).toBe('restore');
    });

    test('auteur suivant ou précédent au-delà de 30 % ou vite', () => {
      const ends = { hasPrev: true, hasNext: true };
      expect(S.decideRelease('author', { ...size, ...ends, dx: -150 })).toBe('next-author');
      expect(S.decideRelease('author', { ...size, ...ends, dx: 150 })).toBe('prev-author');
      expect(S.decideRelease('author', { ...size, ...ends, dx: -40, vx: -0.8 })).toBe('next-author');
      expect(S.decideRelease('author', { ...size, ...ends, dx: -80, vx: 0.1 })).toBe('restore');
      // Vitesse dans le sens contraire du déplacement : pas de changement.
      expect(S.decideRelease('author', { ...size, ...ends, dx: -40, vx: 0.8 })).toBe('restore');
    });

    test('premier ou dernier auteur : retour élastique', () => {
      expect(S.decideRelease('author', { ...size, dx: -300, hasNext: false, hasPrev: true })).toBe('restore');
      expect(S.decideRelease('author', { ...size, dx: 300, hasPrev: false, hasNext: true })).toBe('restore');
    });

    test('toucher : tiers gauche = précédente, le reste = suivante', () => {
      expect(S.tapZone(100, 393)).toBe('prev');
      expect(S.tapZone(140, 393)).toBe('next');
      expect(S.tapZone(380, 393)).toBe('next');
    });
  });
});
