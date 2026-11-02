/*
 * Swipe horizontal entre les onglets (Accueil ↔ Découvrir ↔ Messages ↔
 * Recherche ↔ Profil), Pointer Events, sans bibliothèque.
 *
 *  - vers la gauche : onglet suivant ; vers la droite : précédent ; rien
 *    avant Accueil ni après Profil (effet élastique) ;
 *  - l'écran suit le doigt ; au lâcher : changement si |dx| > 25 % de la
 *    largeur ou lancer rapide, sinon retour en place ;
 *  - ignoré si le geste est plutôt vertical (|dx| < 1,5 × |dy|), s'il part
 *    d'un élément qui défile à l'horizontale, d'un champ de saisie, à moins
 *    de 24 px d'un bord (geste retour iOS), ou si une feuille / modale /
 *    menu est ouvert (deps.isBlocked).
 *
 * Testé par tests/tab-swipe.test.js ; branché par app.js (bindTabSwipe).
 */
(function attach(root) {
  'use strict';

  const TABS = ['home', 'discover', 'messages', 'links', 'profile'];
  const SWIPE = { start: 10, ratio: 1.5, commit: 0.25, velocity: 0.5, edge: 24, elastic: 0.3, velocityWindowMs: 100 };
  // Éléments d'où un swipe ne part jamais : défilement horizontal, saisie, conversation.
  const NO_SWIPE = [
    // Découvrir : fil fixe à défilement vertical natif, double tap ; pas de swipe d'onglet.
    '.discover-feed',
    '.stories-row', '.chip-row', '.badge-scroll', '.tuto-carousel', '[data-no-tab-swipe]',
    'input', 'textarea', 'select', '[contenteditable]', '.chat', 'dialog',
  ].join(', ');

  function neighbor(view, direction) {
    const i = TABS.indexOf(view);
    if (i < 0) return null;
    return TABS[i + direction] || null;
  }

  /** Direction au premier mouvement : null (trop tôt), 'h' ou 'v'. */
  function lockAxis(dx, dy) {
    if (Math.hypot(dx, dy) < SWIPE.start) return null;
    return Math.abs(dx) >= SWIPE.ratio * Math.abs(dy) ? 'h' : 'v';
  }

  /** Décalage affiché : suit le doigt, élastique s'il n'y a pas d'onglet voisin. */
  function offset(view, dx) {
    const target = neighbor(view, dx < 0 ? 1 : -1);
    return target ? dx : dx * SWIPE.elastic;
  }

  /** Au lâcher : onglet cible, ou null (retour en place). */
  function decide(view, { dx, vx, width }) {
    const fast = Math.abs(vx) > SWIPE.velocity && Math.sign(vx) === Math.sign(dx);
    if (Math.abs(dx) <= width * SWIPE.commit && !fast) return null;
    return neighbor(view, dx < 0 ? 1 : -1);
  }

  /** Le geste peut-il commencer ici ? */
  function canStart({ x, width, target, blocked, scrollsHorizontally }) {
    if (blocked) return false;
    if (x < SWIPE.edge || x > width - SWIPE.edge) return false;
    if (target && typeof target.closest === 'function' && target.closest(NO_SWIPE)) return false;
    if (scrollsHorizontally && target && scrollsHorizontally(target)) return false;
    return true;
  }

  /*
   * Branche le geste sur un conteneur (touch-action: pan-y en CSS).
   * deps : view() → onglet courant ; go(view) → changement d'onglet ;
   * paint(dx) → suivi du doigt (0 : retour) ; width() ; isBlocked() ;
   * scrollsHorizontally(target) ; reduced() → mouvement réduit.
   */
  function bind(container, deps) {
    let drag = null;

    container.addEventListener('pointerdown', (event) => {
      if (event.button > 0 || event.isPrimary === false) return;
      const view = deps.view();
      if (TABS.indexOf(view) < 0) return;
      if (!canStart({
        x: event.clientX, width: deps.width(), target: event.target,
        blocked: deps.isBlocked(), scrollsHorizontally: deps.scrollsHorizontally,
      })) return;
      drag = { id: event.pointerId, view, x0: event.clientX, y0: event.clientY, axis: null, dx: 0, samples: [[event.timeStamp, event.clientX]] };
    });

    container.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x0;
      const dy = event.clientY - drag.y0;
      if (!drag.axis) {
        drag.axis = lockAxis(dx, dy);
        if (drag.axis === 'v') { drag = null; return; }
        if (!drag.axis) return;
      }
      drag.dx = dx;
      drag.samples.push([event.timeStamp, event.clientX]);
      while (drag.samples.length > 2 && event.timeStamp - drag.samples[0][0] > SWIPE.velocityWindowMs) drag.samples.shift();
      if (!deps.reduced()) deps.paint(offset(drag.view, dx));
    });

    const release = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const current = drag;
      drag = null;
      if (current.axis !== 'h') { if (current.dx) deps.paint(0); return; }
      const [t0, x0] = current.samples[0];
      const [t1, x1] = current.samples[current.samples.length - 1];
      const vx = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
      const next = event.type === 'pointercancel' ? null : decide(current.view, { dx: current.dx, vx, width: deps.width() });
      deps.paint(0);
      if (next) deps.go(next, current.dx < 0 ? 'forward' : 'back');
    };
    container.addEventListener('pointerup', release);
    container.addEventListener('pointercancel', release);
  }

  root.HaisselTabSwipe = { TABS, SWIPE, NO_SWIPE, neighbor, lockAxis, offset, decide, canStart, bind };
}(typeof window !== 'undefined' ? window : globalThis));
