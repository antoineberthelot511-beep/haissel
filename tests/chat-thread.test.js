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

  test('horodatage au début et quand plus de 15 minutes séparent deux messages', () => {
    const rows = Chat.layoutThread([msg(1, 0, false), msg(2, 15, false), msg(3, 31, false)]);
    expect(rows.map((row) => row.type)).toEqual(['stamp', 'bubble', 'bubble', 'stamp', 'bubble']);
    // L'horodatage coupe le groupe : la bulle d'avant reçoit sa queue.
    expect(bubbles(rows).map((row) => row.tail)).toEqual([false, true, true]);
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
    expect(Chat.listTimeLabel(new Date(2026, 9, 25, 14, 5), now)).toBe('14:05');
    expect(Chat.listTimeLabel(new Date(2026, 9, 24, 9, 12), now)).toBe('Hier');
  });
});

describe('countActiveFilters', () => {
  test('catégorie, type et sauvegardées comptent ; le tri non', () => {
    expect(Chat.countActiveFilters({})).toBe(0);
    expect(Chat.countActiveFilters({ category: 'jeux', kind: 'campaign', saved: true, sort: 'popular' })).toBe(3);
    expect(Chat.countActiveFilters({ sort: 'popular' })).toBe(0);
  });
});
