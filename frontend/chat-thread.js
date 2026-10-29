/*
 * Logique pure de la messagerie et des filtres de « Recherche », sans DOM :
 * testée par tests/chat-thread.test.js, utilisée par app.js.
 *
 * - layoutThread : transforme la liste de messages (ordre chronologique) en
 *   lignes à afficher : séparateurs de date (« Aujourd’hui », « Hier »,
 *   date), heure quand 15 minutes séparent deux messages, bulles regroupées
 *   par auteur, « queue » sur la dernière bulle d'un groupe, état d'envoi.
 *   Chaque ligne a une clé stable : app.js ne crée que les lignes nouvelles.
 * - createThreadStore : messages reçus du serveur + messages envoyés de façon
 *   optimiste (« Envoi… », « Envoyé », échec avec réessai), sans doublon.
 * - pollDelay : rythme d'interrogation selon la conversation ouverte et l'onglet.
 * - stampLabel, dayLabel, hourLabel : libellés de date.
 * - countActiveFilters : nombre affiché sur le bouton « Filtres ».
 */
(function attach(root) {
  // Plus de 15 minutes entre deux messages : heure centrée.
  const STAMP_GAP_MS = 15 * 60 * 1000;
  // Interrogation : 4 s conversation ouverte et visible, 60 s sinon, rien onglet caché.
  const POLL_OPEN_MS = 4000;
  const POLL_IDLE_MS = 60000;

  const time = (value) => new Date(value).getTime();
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (value) => {
    const d = new Date(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const keyOf = (message) => message.key || `m${message.id}`;

  function layoutThread(messages) {
    const rows = [];
    let previous = null;
    let lastMine = -1;
    messages.forEach((message) => {
      const mine = !message.from_team;
      const newDay = !previous || dayKey(message.created_at) !== dayKey(previous.created_at);
      const gap = !newDay && time(message.created_at) - time(previous.created_at) > STAMP_GAP_MS;
      if (newDay) rows.push({ type: 'day', key: `d${dayKey(message.created_at)}`, at: message.created_at });
      else if (gap) rows.push({ type: 'stamp', key: `s${keyOf(message)}`, at: message.created_at });
      const cut = newDay || gap;
      // Nouveau groupe : autre auteur, ou séparateur intercalé.
      const startsGroup = cut || !previous.from_team !== mine;
      if (startsGroup && rows.length > 1) {
        const before = rows[rows.length - (cut ? 2 : 1)];
        if (before && before.type === 'bubble') before.tail = true;
      }
      const pending = message.status === 'sending' || message.status === 'failed';
      rows.push({
        type: 'bubble', key: keyOf(message), message, mine, groupStart: startsGroup, tail: false, sent: false,
        status: mine && pending ? message.status : '',
      });
      if (mine && message.id && !pending) lastMine = rows.length - 1;
      previous = message;
    });
    const last = rows[rows.length - 1];
    if (last && last.type === 'bubble') last.tail = true;
    // « Envoyé » : mon dernier message enregistré côté serveur. Pas d'accusé de lecture.
    if (lastMine >= 0) rows[lastMine].sent = true;
    return rows;
  }

  /*
   * Conversation côté navigateur : messages du serveur (par id) et messages
   * envoyés depuis cet appareil (clé locale). Un message confirmé garde sa
   * clé locale, même quand l'interrogation le renvoie : sa bulle n'est pas
   * recréée. send(content) renvoie le message enregistré ({ id, created_at })
   * ou lève une erreur.
   */
  function createThreadStore({ send, now = () => new Date() } = {}) {
    let server = [];
    const local = [];
    const keyById = new Map();
    let counter = 0;

    function messages() {
      const known = new Set(server.map((m) => m.id));
      const mine = local.filter((m) => !(m.id && known.has(m.id)));
      return [...server.map((m) => (keyById.has(m.id) ? { ...m, key: keyById.get(m.id) } : m)), ...mine];
    }

    /** Réponse du serveur : renvoie les messages qui n'étaient pas encore connus. */
    function applyServer(list) {
      const before = new Set(messages().map((m) => m.id).filter(Boolean));
      server = (list || []).slice();
      return server.filter((m) => !before.has(m.id));
    }

    // Un envoi après l'autre : l'ordre du fil est celui de la saisie.
    let chain = Promise.resolve();

    function deliver(item) {
      item.status = 'sending';
      const run = chain.then(() => attempt(item));
      chain = run;
      return run;
    }

    async function attempt(item) {
      try {
        const saved = await send(item.content);
        item.id = saved.id;
        item.created_at = saved.created_at || item.created_at;
        item.status = '';
        keyById.set(item.id, item.key);
      } catch (error) {
        item.status = 'failed';
        item.error = error && error.message ? error.message : '';
      }
      return item;
    }

    function post(content) {
      counter += 1;
      const item = { key: `l${counter}`, content, from_team: false, created_at: now().toISOString(), status: 'sending' };
      local.push(item);
      return { item, done: deliver(item) };
    }

    /** Réessai d'un message en échec : il repasse à la fin du fil. */
    function retry(key) {
      const item = local.find((m) => m.key === key && m.status === 'failed');
      if (!item) return null;
      local.splice(local.indexOf(item), 1);
      item.created_at = now().toISOString();
      local.push(item);
      return deliver(item);
    }

    return { messages, applyServer, post, retry };
  }

  /*
   * État vide de la conversation (ours « aucun message ») : seulement une
   * fois chargée ET sans aucun message, ni du membre ni de l'équipe. Un envoi
   * optimiste en cours compte comme un message.
   */
  function showEmptyState(messages, loaded) {
    return Boolean(loaded) && (!messages || messages.length === 0);
  }

  /** Délai avant la prochaine interrogation ; null : on n'interroge pas (onglet caché). */
  function pollDelay({ open = false, visible = true } = {}) {
    if (!visible) return null;
    return open ? POLL_OPEN_MS : POLL_IDLE_MS;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function stampLabel(value, now = new Date()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const hour = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (sameDay(date, now)) return `Aujourd’hui ${hour}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return `Hier ${hour}`;
    const day = date.toLocaleDateString('fr-FR', {
      weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
    return `${day} ${hour}`;
  }

  /** Séparateur de date : « Aujourd’hui », « Hier », sinon « lundi 3 mars ». */
  function dayLabel(value, now = new Date()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    if (sameDay(date, now)) return 'Aujourd’hui';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return 'Hier';
    return date.toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  }

  /** Heure seule (« 14:05 ») : séparateur dans une même journée. */
  function hourLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  /** Le tri n'est pas un filtre : seuls catégorie, type et « sauvegardées » comptent. */
  function countActiveFilters({ category = '', kind = '', saved = false } = {}) {
    return (category ? 1 : 0) + (kind ? 1 : 0) + (saved ? 1 : 0);
  }

  /*
   * Entrée dans le champ de message : sur ordinateur, Entrée envoie et
   * Maj+Entrée fait un saut de ligne ; sur mobile (pointeur tactile), Entrée
   * fait toujours un saut de ligne et l'envoi passe par le bouton.
   */
  function enterSends({ key, shiftKey = false, isComposing = false } = {}, touch = false) {
    return key === 'Enter' && !shiftKey && !isComposing && !touch;
  }

  root.HaisselChat = {
    STAMP_GAP_MS, POLL_OPEN_MS, POLL_IDLE_MS, layoutThread, createThreadStore, showEmptyState, pollDelay,
    stampLabel, dayLabel, hourLabel, countActiveFilters, enterSends,
  };
}(typeof window !== 'undefined' ? window : globalThis));
