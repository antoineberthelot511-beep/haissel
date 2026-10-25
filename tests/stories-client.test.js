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
});
