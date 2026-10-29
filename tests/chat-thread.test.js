/*
 * Logique navigateur de la messagerie et des filtres (frontend/chat-thread.js) :
 * regroupement des bulles, horodatages, « Envoyé », pastille des filtres.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/chat-thread.js'), 'utf8');

function load() {
  const sandbox = { Date, Number };
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.HaisselChat;
}

const Chat = load();

describe('touche Entrée du champ de message', () => {
  test('ordinateur : Entrée envoie, Maj+Entrée fait un saut de ligne', () => {
    expect(Chat.enterSends({ key: 'Enter' }, false)).toBe(true);
    expect(Chat.enterSends({ key: 'Enter', shiftKey: true }, false)).toBe(false);
    expect(Chat.enterSends({ key: 'Enter', isComposing: true }, false)).toBe(false);
    expect(Chat.enterSends({ key: 'a' }, false)).toBe(false);
  });

  test('mobile : Entrée fait toujours un saut de ligne', () => {
    expect(Chat.enterSends({ key: 'Enter' }, true)).toBe(false);
  });
});

describe('barre de saisie de la conversation (index.html)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const thread = html.slice(html.indexOf('id="team-thread"'), html.indexOf('id="notifications-view"'));

  test('un textarea hors de tout <form>, avec les bons attributs', () => {
    expect(thread).not.toMatch(/<form/);
    const textarea = thread.match(/<textarea[^>]*>/)[0];
    for (const attr of ['rows="1"', 'autocomplete="off"', 'autocorrect="on"', 'autocapitalize="sentences"', 'enterkeyhint="send"', 'aria-label="Message"']) {
      expect(textarea).toContain(attr);
    }
  });

  test('bouton d’envoi toujours présent, désactivé au départ', () => {
    const button = thread.match(/<button id="chat-send"[^>]*>/)[0];
    expect(button).toContain('disabled');
    expect(button).not.toContain('hidden');
  });
});
const at = (minutes) => new Date(Date.UTC(2026, 9, 25, 12, 0) + minutes * 60000).toISOString();
const msg = (id, minutes, fromTeam) => ({ id, content: `m${id}`, from_team: fromTeam, created_at: at(minutes) });
const bubbles = (rows) => rows.filter((row) => row.type === 'bubble');

describe('layoutThread', () => {
  test('regroupe les messages consécutifs du même auteur ; queue sur la dernière bulle du groupe', () => {
    const rows = Chat.layoutThread([msg(1, 0, false), msg(2, 1, false), msg(3, 2, true), msg(4, 3, true), msg(5, 4, false)]);
    const b = bubbles(rows);
    expect(b.map((row) => row.groupStart)).toEqual([true, false, true, false, true]);
    expect(b.map((row) => row.tail)).toEqual([false, true, false, true, true]);
    expect(b.map((row) => row.mine)).toEqual([true, true, false, false, true]);
  });

  test('séparateur de date au début, heure quand plus de 15 minutes séparent deux messages', () => {
    const rows = Chat.layoutThread([msg(1, 0, false), msg(2, 15, false), msg(3, 31, false)]);
    expect(rows.map((row) => row.type)).toEqual(['day', 'bubble', 'bubble', 'stamp', 'bubble']);
    // Le séparateur coupe le groupe : la bulle d'avant reçoit sa queue.
    expect(bubbles(rows).map((row) => row.tail)).toEqual([false, true, true]);
  });

  test('nouveau jour : nouveau séparateur de date ; clés stables et uniques', () => {
    const rows = Chat.layoutThread([msg(1, 0, false), msg(2, 24 * 60, true)]);
    expect(rows.map((row) => row.type)).toEqual(['day', 'bubble', 'day', 'bubble']);
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Chat.layoutThread([msg(1, 0, false), msg(2, 24 * 60, true)]).map((row) => row.key)).toEqual(keys);
  });

  test('« Envoyé » sous mon dernier message seulement, jamais d’accusé de lecture', () => {
    const rows = Chat.layoutThread([msg(1, 0, false), msg(2, 1, false), msg(3, 2, true)]);
    expect(bubbles(rows).map((row) => row.sent)).toEqual([false, true, false]);
    expect(JSON.stringify(rows)).not.toMatch(/"read"|"seen"/);
    expect(bubbles(Chat.layoutThread([msg(1, 0, true)])).some((row) => row.sent)).toBe(false);
    expect(Chat.layoutThread([])).toEqual([]);
  });
});

describe('libellés de date', () => {
  const now = new Date(2026, 9, 25, 18, 0);
  test('aujourd’hui, hier, sinon la date', () => {
    expect(Chat.stampLabel(new Date(2026, 9, 25, 14, 5), now)).toBe('Aujourd’hui 14:05');
    expect(Chat.stampLabel(new Date(2026, 9, 24, 9, 12), now)).toBe('Hier 09:12');
    expect(Chat.stampLabel('pas une date', now)).toBe('');
    expect(Chat.dayLabel(new Date(2026, 9, 25, 9, 0), now)).toBe('Aujourd’hui');
    expect(Chat.dayLabel(new Date(2026, 9, 24, 9, 0), now)).toBe('Hier');
    expect(Chat.dayLabel(new Date(2026, 9, 20, 9, 0), now)).toMatch(/^mardi 20 octobre$/);
    expect(Chat.hourLabel(new Date(2026, 9, 25, 14, 5))).toBe('14:05');
  });
});

describe('countActiveFilters', () => {
  test('catégorie, type et sauvegardées comptent ; le tri non', () => {
    expect(Chat.countActiveFilters({})).toBe(0);
    expect(Chat.countActiveFilters({ category: 'jeux', kind: 'campaign', saved: true, sort: 'popular' })).toBe(3);
    expect(Chat.countActiveFilters({ sort: 'popular' })).toBe(0);
  });
});
