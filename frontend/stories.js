'use strict';

/*
 * Stories HAISSEL : logique sans interface (regroupement par auteur, fiches
 * vues). L'interface est dans app.js.
 *
 * « Vu » reste dans ce navigateur (localStorage) : aucune métrique de vue
 * n'est envoyée au serveur. Chaque accès est protégé : sans stockage
 * (navigation privée, stockage bloqué), tout est simplement « non vu ».
 */
(function attach(root) {
  const SEEN_KEY = 'haissel_stories_seen_v1';
  const MAX_SEEN = 500;

  /* Une republication rend la fiche de nouveau « non vue ». */
  function seenId(offer) {
    return `${offer.id}@${offer.shown_at || offer.published_at || ''}`;
  }

  function readSeen(storage) {
    try {
      const list = JSON.parse(storage.getItem(SEEN_KEY) || '[]');
      return new Set(Array.isArray(list) ? list.filter((v) => typeof v === 'string') : []);
    } catch (error) {
      return new Set();
    }
  }

  function markSeen(storage, offer) {
    try {
      const seen = readSeen(storage);
      seen.delete(seenId(offer));
      seen.add(seenId(offer));
      storage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-MAX_SEEN)));
    } catch (error) { /* stockage indisponible : rien n'est retenu */ }
  }

  function isStory(offer) {
    return offer.kind === 'campaign' && offer.status === 'published' && !offer.expired;
  }

  const time = (offer) => new Date(offer.shown_at || offer.published_at || 0).getTime();

  /*
   * Un groupe par auteur, ses fiches de la plus ancienne à la plus récente
   * (ordre de lecture). Les groupes : non vus d'abord, puis le plus récent.
   * Les offres ADMIN (« affiliate ») ne sont jamais des stories.
   */
  function groupStories(items, seen = new Set()) {
    const byAuthor = new Map();
    for (const offer of items) {
      if (!isStory(offer) || offer.is_mine) continue;
      const name = offer.author.username;
      if (!byAuthor.has(name)) byAuthor.set(name, []);
      byAuthor.get(name).push(offer);
    }
    const groups = [...byAuthor].map(([username, offers]) => {
      offers.sort((a, b) => time(a) - time(b));
      return {
        username,
        offers,
        latest: Math.max(...offers.map(time)),
        unseen: offers.some((offer) => !seen.has(seenId(offer))),
      };
    });
    groups.sort((a, b) => (Number(b.unseen) - Number(a.unseen)) || (b.latest - a.latest));
    return groups;
  }

  function ownStories(items) {
    return items.filter((offer) => offer.is_mine && isStory(offer)).sort((a, b) => time(a) - time(b));
  }

  /* Première fiche non vue d'un groupe (sinon la première). */
  function startIndex(offers, seen) {
    const index = offers.findIndex((offer) => !seen.has(seenId(offer)));
    return index === -1 ? 0 : index;
  }

  root.HaisselStories = { SEEN_KEY, seenId, readSeen, markSeen, groupStories, ownStories, startIndex, isStory };
}(typeof window !== 'undefined' ? window : globalThis));
