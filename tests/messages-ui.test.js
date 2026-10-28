/*
 * Messages côté navigateur : envoi optimiste et réessai, interrogation sans
 * doublon ni re-rendu complet, recherche dans la liste, rythme d'interrogation,
 * textes destinés aux membres, animations neutralisées par prefers-reduced-motion.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');

function loadChat() {
  const sandbox = { Date, Number, Promise };
  sandbox.window = sandbox;
  vm.runInNewContext(read('chat-thread.js'), sandbox);
  return sandbox.HaisselChat;
}

function loadMotion() {
  const sandbox = { Math, Number };
  vm.runInNewContext(read('motion.js'), sandbox);
  return sandbox.HaisselMotion;
}

const Chat = loadChat();
const Motion = loadMotion();
const app = read('app.js');
const fixedNow = () => new Date(Date.UTC(2026, 9, 28, 10, 0));
const server = (id, minutes, fromTeam, content = `m${id}`) => ({
  id, content, from_team: fromTeam, is_read: true, created_at: new Date(Date.UTC(2026, 9, 28, 9, minutes)).toISOString(),
});

/** Promesse contrôlée par le test : resolve / reject à la main. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, ko) => { resolve = ok; reject = ko; });
  return { promise, resolve, reject };
}

describe('envoi optimiste', () => {
  test('la bulle apparaît tout de suite (« Envoi… »), puis « Envoyé »', async () => {
    const pending = deferred();
    const store = Chat.createThreadStore({ send: () => pending.promise, now: fixedNow });
    store.applyServer([server(1, 0, true)]);
    const { item, done } = store.post('Bonjour');

    let rows = Chat.layoutThread(store.messages());
    let mine = rows.filter((row) => row.type === 'bubble' && row.mine);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('sending');
    expect(mine[0].sent).toBe(false);
    expect(mine[0].message.content).toBe('Bonjour');

    pending.resolve({ id: 2, content: 'Bonjour', from_team: false, created_at: fixedNow().toISOString() });
    await done;
    expect(item.id).toBe(2);
    rows = Chat.layoutThread(store.messages());
    mine = rows.filter((row) => row.type === 'bubble' && row.mine);
    expect(mine[0]).toMatchObject({ status: '', sent: true, key: item.key });
  });

  test('échec : état « failed », puis réessai réussi, à la fin du fil', async () => {
    let attempts = 0;
    const store = Chat.createThreadStore({
      send: async (content) => {
        attempts += 1;
        if (attempts === 1) throw new Error('Réseau indisponible');
        return { id: 10 + attempts, content, from_team: false, created_at: fixedNow().toISOString() };
      },
      now: fixedNow,
    });
    const { item, done } = store.post('Premier');
    await done;
    expect(item.status).toBe('failed');
    expect(item.error).toBe('Réseau indisponible');
    let bubble = Chat.layoutThread(store.messages()).find((row) => row.key === item.key);
    expect(bubble.status).toBe('failed');
    expect(bubble.sent).toBe(false);

    // Un autre message part entre-temps ; le réessai repasse à la fin.
    await store.post('Second').done;
    expect(store.retry('inconnu')).toBeNull();
    const retried = store.retry(item.key);
    expect(item.status).toBe('sending');
    await retried;
    expect(item.status).toBe('');
    expect(store.messages().map((m) => m.content)).toEqual(['Second', 'Premier']);
    bubble = Chat.layoutThread(store.messages()).find((row) => row.key === item.key);
    expect(bubble.sent).toBe(true);
    expect(attempts).toBe(3);
  });

  test('les envois partent dans l’ordre de la saisie', async () => {
    const order = [];
    const gates = [deferred(), deferred()];
    const store = Chat.createThreadStore({
      send: async (content) => {
        order.push(`début ${content}`);
        await gates[order.length - 1].promise;
        return { id: order.length, content, created_at: fixedNow().toISOString() };
      },
      now: fixedNow,
    });
    const a = store.post('A');
    const b = store.post('B');
    await Promise.resolve();
    expect(order).toEqual(['début A']);
    gates[0].resolve();
    await a.done;
    gates[1].resolve();
    await b.done;
    expect(order).toEqual(['début A', 'début B']);
  });

  test('app.js : le champ se vide tout de suite, la bulle monte depuis la barre, toucher réessaie', () => {
    const send = app.slice(app.indexOf('function sendChat()'), app.indexOf('function retryChat'));
    expect(send).toMatch(/ui\.chatInput\.value = '';[\s\S]*store\.post\(content\)/);
    expect(send).not.toMatch(/await/);
    expect(app).toContain("const RECEIPTS = { sending: 'Envoi…', failed: 'Toucher pour réessayer' };");
    expect(app).toMatch(/node\.firstChild\.classList\.add\('m-send'\)/);
    expect(app).toMatch(/closest\('\.bubble-row\.is-failed'\);\s*if \(row\) retryChat\(row\.dataset\.key\);/);
  });
});

describe('interrogation sans doublon ni re-rendu complet', () => {
  test('la même réponse deux fois : rien de nouveau, mêmes clés', () => {
    const store = Chat.createThreadStore({ send: async () => ({}), now: fixedNow });
    const list = [server(1, 0, false), server(2, 1, true)];
    expect(store.applyServer(list).map((m) => m.id)).toEqual([1, 2]);
    const keys = Chat.layoutThread(store.messages()).map((row) => row.key);
    expect(store.applyServer(list)).toEqual([]);
    expect(Chat.layoutThread(store.messages()).map((row) => row.key)).toEqual(keys);
    // Un message de plus : seul celui-là est nouveau, les clés d'avant ne changent pas.
    const added = store.applyServer([...list, server(3, 2, true)]);
    expect(added.map((m) => m.id)).toEqual([3]);
    const next = Chat.layoutThread(store.messages()).map((row) => row.key);
    expect(next.slice(0, keys.length)).toEqual(keys);
    expect(next).toHaveLength(keys.length + 1);
  });

  test('mon message confirmé, renvoyé par l’interrogation : une seule bulle, clé locale gardée', async () => {
    const store = Chat.createThreadStore({
      send: async (content) => ({ id: 7, content, from_team: false, created_at: fixedNow().toISOString() }),
      now: fixedNow,
    });
    const { item, done } = store.post('Salut');
    await done;
    const added = store.applyServer([{ id: 7, content: 'Salut', from_team: false, created_at: fixedNow().toISOString() }]);
    expect(added).toEqual([]);
    const bubbles = Chat.layoutThread(store.messages()).filter((row) => row.type === 'bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].key).toBe(item.key);
    expect(bubbles[0].sent).toBe(true);
  });

  test('app.js : rapprochement par clé (insertBefore), jamais replaceChildren du fil', () => {
    const render = app.slice(app.indexOf('function renderChat()'), app.indexOf('function scrollChatToEnd'));
    expect(render).toContain('entry.nodes.get(row.key)');
    expect(render).toContain('list.insertBefore(node, expected)');
    expect(render).toContain('updateChatRow(node, row)');
    // Seul l'état vide remplace le contenu ; jamais quand il y a des messages.
    expect(render.match(/replaceChildren/g)).toHaveLength(1);
    expect(render).toMatch(/if \(!messages\.length\) \{[\s\S]*?replaceChildren[\s\S]*?return/);
    // Lecture plus haut : position gardée (ancrage) et bouton « Nouveaux messages ».
    expect(render).toContain('firstVisibleRow(list)');
    expect(render).toContain('list.scrollTop += delta');
    const load = app.slice(app.indexOf('async function loadChat()'), app.indexOf('function sendChat()'));
    expect(load).toMatch(/if \(atBottom\) scrollChatToEnd\(true\);\s*else if \(added\.length\) ui\.chatNew\.hidden = false;/);
  });

  test('rythme : 4 s conversation ouverte et visible, 60 s sinon, arrêt onglet caché', () => {
    expect(Chat.pollDelay({ open: true, visible: true })).toBe(4000);
    expect(Chat.pollDelay({ open: false, visible: true })).toBe(60000);
    expect(Chat.pollDelay({ open: true, visible: false })).toBeNull();
    expect(Chat.pollDelay({ open: false, visible: false })).toBeNull();
    expect(app).toMatch(/document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(!state\.user\) return;\s*if \(document\.visibilityState === 'visible'\) pollTick\(\);\s*else stopPolling\(\);/);
    expect(app).not.toMatch(/setInterval\(loadChat/);
  });

  test('cache en mémoire : la réouverture affiche le fil tout de suite, puis le rafraîchit', () => {
    const open = app.slice(app.indexOf('function openChat()'), app.indexOf('function closeChat('));
    expect(open.indexOf('renderChat()')).toBeLessThan(open.indexOf('pollTick()'));
    expect(app).toContain('const chatCache = new Map();');
    // Fermer ne vide pas le fil ; seule la déconnexion efface le cache.
    const close = app.slice(app.indexOf('function closeChat('), app.indexOf('function bindChatEdgeSwipe'));
    expect(close).not.toMatch(/chatMessages\.replaceChildren|chatCache\.clear/);
    expect(app).toMatch(/function resetChat\(\) \{[\s\S]*?chatCache\.clear\(\);/);
  });
});

describe('liste des conversations', () => {
  const list = [
    { id: 'team', name: 'Équipe Haissel', preview: 'Ta fiche est validée' },
    { id: 'autre', name: 'Camille', preview: 'Merci pour l’astuce' },
  ];

  test('recherche en direct : nom ou aperçu, sans accents ni casse', () => {
    expect(Chat.filterConversations(list, '').map((c) => c.id)).toEqual(['team', 'autre']);
    expect(Chat.filterConversations(list, '  ').map((c) => c.id)).toEqual(['team', 'autre']);
    expect(Chat.filterConversations(list, 'equipe').map((c) => c.id)).toEqual(['team']);
    expect(Chat.filterConversations(list, 'VALIDÉE').map((c) => c.id)).toEqual(['team']);
    expect(Chat.filterConversations(list, 'astuce').map((c) => c.id)).toEqual(['autre']);
    expect(Chat.filterConversations(list, 'zzz')).toEqual([]);
    expect(app).toMatch(/ui\.msgSearch\.addEventListener\('input', \(\) => \{ chat\.query = ui\.msgSearch\.value; renderInbox\(\); \}\);/);
  });

  test('index.html : grand titre, recherche, épinglée avec le logo, squelettes, état vide', () => {
    const html = read('index.html');
    const inbox = html.slice(html.indexOf('id="messages-inbox"'), html.indexOf('id="team-thread"'));
    expect(inbox).toContain('<h2 id="messages-title" class="msg-title">Messages</h2>');
    expect(inbox).toMatch(/<input id="msg-search" type="search" placeholder="Rechercher"/);
    expect(inbox).toMatch(/<img class="msg-pin-avatar team-avatar" src="\/images\/mascotte\/avatar-equipe-128.webp" alt="Équipe Haissel" width="64" height="64" \/>/);
    expect(inbox).toMatch(/<img class="msg-avatar team-avatar" src="\/images\/mascotte\/avatar-equipe-128.webp" alt="Équipe Haissel" width="52" height="52" \/>/);
    expect(inbox).toContain('msg-chevron');
    expect(inbox).toContain('id="msg-skeleton"');
    expect(inbox).toMatch(/<div id="msg-empty" class="msg-empty" hidden>\s*<span id="msg-empty-mascot"><\/span>/);
    expect(html).toContain('<span class="topbar-title" aria-hidden="true">Messages</span>');
    const css = read('app-v2.css');
    expect(css).toMatch(/\.msg-title \{[^}]*font-size: 34px;[^}]*font-weight: 800;/);
    expect(css).toMatch(/body\[data-view="messages"\] \.topbar-title \{ visibility: visible; opacity: var\(--msg-collapse, 0\); \}/);
  });

  test('appui long : aperçu flouté + menu (Marquer comme lu, Épingler / Désépingler)', () => {
    const peek = app.slice(app.indexOf('function openPeek('), app.indexOf('function closePeek('));
    expect(peek).toContain("menuItem('Marquer comme lu'");
    expect(peek).toContain("pinned ? 'Désépingler' : 'Épingler'");
    expect(peek).toContain('HaisselMotion?.openMenu(menu, point)');
    expect(read('app-v2.css')).toMatch(/\.msg-peek \{[^}]*backdrop-filter: blur\(18px\)/);
    expect(read('motion.css')).toMatch(/\.msg-peek-card \{ animation: m-peek var\(--dur-3\) var\(--spring\) both; \}/);
  });

  test('conversation : glisse depuis la droite en 300 ms, balayage depuis le bord gauche', () => {
    expect(app).toContain("const CHAT_SLIDE = { duration: 300, easing: 'cubic-bezier(.2, .8, .2, 1)' };");
    expect(app).toMatch(/animate\(\[\{ transform: 'translateX\(100%\)' \}, \{ transform: 'none' \}\], CHAT_SLIDE\)/);
    expect(app).toMatch(/event\.clientX > 24\) return;/);
  });

  test('appui long sur une bulle : seulement Copier', () => {
    const menu = app.slice(app.indexOf('function openBubbleMenu('), app.indexOf('function closeBubbleMenu('));
    expect(menu.match(/role: 'menuitem'/g)).toHaveLength(1);
    expect(menu).toContain("}, 'Copier'));");
    expect(menu).toContain('navigator.clipboard.writeText(text)');
  });
});

describe('textes destinés aux membres', () => {
  test('plus aucune phrase sur l’impossibilité d’écrire aux autres membres', () => {
    const memberFiles = fs.readdirSync(FRONTEND)
      .filter((name) => /\.(html|js)$/.test(name) && !name.startsWith('admin'));
    const forbidden = /s.écrire entre eux|entre membres|écrire aux autres membres|écrire à d.autres membres|ne peux pas écrire|pas de messages? entre/i;
    for (const name of memberFiles) {
      expect([name, forbidden.test(read(name))]).toEqual([name, false]);
    }
  });
});

describe('menus et toasts (motion.js)', () => {
  test('menu : origine au point touché, ramenée dans le menu ; centre sans point', () => {
    const rect = { left: 100, top: 200, width: 220, height: 100 };
    expect(Motion.menuOrigin(rect, { x: 150, y: 210 })).toEqual({ x: 50, y: 10 });
    expect(Motion.menuOrigin(rect, { x: 10, y: 900 })).toEqual({ x: 0, y: 100 });
    expect(Motion.menuOrigin(rect)).toEqual({ x: 110, y: 50 });
    expect(Motion.MENU_STEP_MS).toBe(20);
    expect(Motion.MENU_CLOSE_MS).toBe(120);
  });

  test('toast : fermé par un balayage vers le haut (distance ou vitesse)', () => {
    expect(Motion.toastDismissed(-40, 0)).toBe(true);
    expect(Motion.toastDismissed(-10, -0.5)).toBe(true);
    expect(Motion.toastDismissed(-10, -0.1)).toBe(false);
    expect(Motion.toastDismissed(0, 0)).toBe(false);
  });

  test('menu « … » des stories branché sur openMenu / closeMenu', () => {
    const menu = app.slice(app.indexOf('function storyMenu('), app.indexOf('function storyFace('));
    expect(menu).toContain('motion?.openMenu(menu, { x: event.clientX, y: event.clientY })');
    expect(menu).toContain("motion.closeMenu(menu, () => menu.classList.add('hidden'))");
  });
});

describe('prefers-reduced-motion', () => {
  const css = read('motion.css');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

  test('les nouvelles animations sont neutralisées', () => {
    expect(block).toMatch(/\.m-menu-in, \.bubble\.m-send, \.msg-peek-card, \.app-dialog\[open\], \.chat-new \{ animation: m-fade 100ms ease both !important; \}/);
    expect(block).toMatch(/\.m-menu-in > \*, \.m-menu-out, \.m-shake \{ animation: none !important; \}/);
    expect(block).toMatch(/\.bubble\.is-lifted, \.field:focus-within > span[^{]*\{ transform: none !important; \}/);
    expect(block).toContain('.sk::after { animation: none !important; }');
  });

  test('chaque nouvelle classe animée a sa règle dans le bloc', () => {
    for (const selector of ['.m-menu-in', '.m-menu-out', '.bubble.m-send', '.msg-peek-card', '.app-dialog[open]', '.m-shake', '.bubble.is-lifted', '.chat-new']) {
      expect([selector, css.slice(0, css.indexOf('@media (prefers-reduced-motion: reduce)')).includes(selector), block.includes(selector)])
        .toEqual([selector, true, true]);
    }
  });

  test('côté script : pas de glissement ni de secousse en mouvement réduit', () => {
    expect(app).toMatch(/if \(reducedMotion\(\)\) hideInbox\(\);/);
    expect(app).toMatch(/if \(!animate \|\| reducedMotion\(\)\) finish\(\);/);
    const motion = read('motion.js');
    expect(motion).toMatch(/function shake\(element\) \{\s*if \(!element \|\| reduced\(\)\) return;/);
    expect(motion).toMatch(/if \(reduced\(\) \|\| !menu\.isConnected/);
  });
});
