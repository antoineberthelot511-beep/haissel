/*
 * Logique pure de la messagerie et des filtres de « Recherche », sans DOM :
 * testée par tests/chat-thread.test.js, utilisée par app.js.
 *
 * - layoutThread : transforme la liste de messages (ordre chronologique) en
 *   lignes à afficher : horodatages centrés, bulles regroupées par auteur,
 *   « queue » sur la dernière bulle d'un groupe, « Envoyé » sous mon
 *   dernier message.
 * - stampLabel : libellé d'un horodatage (« Aujourd’hui 14:05 »…).
 * - countActiveFilters : nombre affiché sur le bouton « Filtres ».
 */
(function attach(root) {
  // Plus de 15 minutes entre deux messages : horodatage centré.
  const STAMP_GAP_MS = 15 * 60 * 1000;

  const time = (value) => new Date(value).getTime();

  function layoutThread(messages) {
    const rows = [];
    let previous = null;
    let lastMine = -1;
    messages.forEach((message) => {
      const mine = !message.from_team;
      const stamp = !previous || time(message.created_at) - time(previous.created_at) > STAMP_GAP_MS;
      if (stamp) rows.push({ type: 'stamp', at: message.created_at });
      // Nouveau groupe : autre auteur, ou horodatage intercalé.
      const startsGroup = stamp || !previous || !previous.from_team !== mine;
      if (startsGroup && rows.length > 1) {
        const before = rows[rows.length - (stamp ? 2 : 1)];
        if (before && before.type === 'bubble') before.tail = true;
      }
      rows.push({ type: 'bubble', message, mine, groupStart: startsGroup, tail: false, sent: false });
      if (mine) lastMine = rows.length - 1;
      previous = message;
    });
    const last = rows[rows.length - 1];
    if (last && last.type === 'bubble') last.tail = true;
    // « Envoyé » : le message existe côté serveur (il a un identifiant). Pas d'accusé de lecture.
    if (lastMine >= 0 && rows[lastMine].message.id) rows[lastMine].sent = true;
    return rows;
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

  /** Heure de la liste des conversations : heure du jour, « Hier », sinon la date. */
  function listTimeLabel(value, now = new Date()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    if (sameDay(date, now)) return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(date, yesterday)) return 'Hier';
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
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

  root.HaisselChat = { STAMP_GAP_MS, layoutThread, stampLabel, listTimeLabel, countActiveFilters, enterSends };
}(typeof window !== 'undefined' ? window : globalThis));
