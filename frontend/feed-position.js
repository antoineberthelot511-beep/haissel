/*
 * Position dans le fil (Accueil, Recherche avec ses filtres, Découvrir) :
 * à l'ouverture d'une publication, on garde la position de défilement et
 * l'id de la publication ; au retour (bouton de l'app, retour du navigateur,
 * geste iOS), on la restaure. Si la page a changé de hauteur ou si la carte
 * n'est plus à l'écran (fil rechargé), on fait défiler jusqu'à la carte.
 *
 * Logique pure, sans DOM direct : testable (tests/feed-position.test.js).
 */
(function (root) {
  'use strict';

  /** Clé d'un fil : la vue et, pour Recherche, les filtres actifs. */
  function feedKey(view, query) {
    return `${view || 'home'}?${query || ''}`;
  }

  function createStore() {
    const positions = new Map();
    return {
      save(key, entry) {
        positions.set(key, {
          scroll: Math.max(0, Number(entry.scroll) || 0),
          offerId: entry.offerId ?? null,
          height: Number(entry.height) || 0,
          // Décalage de la carte par rapport au haut de l'écran.
          cardOffset: Number(entry.cardOffset) || 0,
        });
      },
      get(key) {
        return positions.get(key) || null;
      },
      clear(key) {
        positions.delete(key);
      },
    };
  }

  /*
   * Décide comment revenir :
   *   - même hauteur de page : la position gardée, telle quelle ;
   *   - hauteur changée (fil rechargé, images…) et carte trouvée : la carte,
   *     au même décalage qu'avant l'ouverture ;
   *   - carte introuvable : la position gardée, au mieux.
   * cardTop : position de la carte dans la page au retour (null si absente).
   */
  function plan(entry, { height, cardTop }) {
    if (!entry) return { type: 'none' };
    const sameHeight = Math.abs((Number(height) || 0) - entry.height) < 2;
    const found = cardTop !== null && cardTop !== undefined;
    if (!sameHeight && found) return { type: 'card', top: Math.max(0, cardTop - entry.cardOffset) };
    return { type: 'scroll', top: entry.scroll };
  }

  root.HaisselFeedPosition = { feedKey, createStore, plan };
}(typeof window !== 'undefined' ? window : globalThis));
