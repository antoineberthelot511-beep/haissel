/*
 * Mascotte HAISSEL : l'ours, 20 poses (images/mascotte/ours-NN-nom.webp,
 * 512×512, fond transparent).
 *
 *  - mascot('bravo', { size: 160 }) renvoie un <img> chargé en différé, de
 *    taille fixe, décoratif (alt="") sauf texte fourni ; entrée douce (fondu
 *    + léger rebond, mascot.css), coupée en prefers-reduced-motion ;
 *  - les emplacements fixes du HTML (<span data-mascot="nom" data-mascot-size="96">)
 *    sont remplis au chargement ;
 *  - un seul ours visible à la fois : parmi les ours visibles à l'écran, le
 *    plus récent reste, les autres sont masqués (et réapparaissent quand ils
 *    redeviennent seuls).
 *
 * Tailles : 120 à 160 px dans les états vides, 72 à 96 px dans les en-têtes
 * et les feuilles. Jamais dans les listes ni dans le fil.
 */
(function attach(root) {
  const POSES = [
    'bienvenue', 'bravo', 'vide-dodo', 'aucun-resultat', 'oups-erreur', 'patience', 'tuto-telephone', 'notifications',
    'messages', 'message-recu', 'fiche-validee', 'fiche-refusee', 'story-selfie', 'securite', 'hors-ligne',
    'admin-support', 'admin-moderation', 'guides', 'reglages', 'au-revoir',
  ];
  const MIN_SIZE = 72;
  const MAX_SIZE = 160;

  function src(name) {
    const index = POSES.indexOf(name);
    if (index < 0) throw new Error(`Pose inconnue : ${name}`);
    return `/images/mascotte/ours-${String(index + 1).padStart(2, '0')}-${name}.webp`;
  }

  const clampSize = (size) => Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, Number(size) || 120)));

  /**
   * Un seul ours : parmi les candidats visibles ({ visible, order }), garde
   * le plus récent. Renvoie l'index gagnant (-1 si aucun n'est visible).
   */
  function pickVisible(candidates) {
    let winner = -1;
    candidates.forEach((c, i) => {
      if (c.visible && (winner < 0 || c.order > candidates[winner].order)) winner = i;
    });
    return winner;
  }

  if (typeof root.document === 'undefined') {
    root.HaisselMascot = { POSES, MIN_SIZE, MAX_SIZE, src, clampSize, pickVisible };
    return;
  }
  const doc = root.document;
  let counter = 0;

  function mascot(name, { size = 120, alt = '', className = '' } = {}) {
    const px = clampSize(size);
    const img = doc.createElement('img');
    img.className = `mascot${className ? ` ${className}` : ''}`;
    img.src = src(name);
    img.alt = alt;
    if (!alt) img.setAttribute('aria-hidden', 'true');
    img.width = px;
    img.height = px;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.dataset.mascot = name;
    counter += 1;
    img.dataset.mascotOrder = String(counter);
    schedule();
    return img;
  }

  /* Emplacements fixes du HTML. */
  function fillSlots(scope = doc) {
    scope.querySelectorAll('[data-mascot]:not(img)').forEach((slot) => {
      if (slot.querySelector('img.mascot')) return;
      slot.append(mascot(slot.dataset.mascot, { size: slot.dataset.mascotSize }));
    });
  }

  /* Visible si son conteneur est affiché (l'image masquée par nous ne compte pas). */
  const shown = (img) => Boolean(img.parentElement && img.parentElement.getClientRects().length)
    && !img.closest('.hidden, [hidden]:not(img)');

  function enforce() {
    frame = 0;
    const all = [...doc.querySelectorAll('img.mascot')];
    const winner = pickVisible(all.map((img) => ({ visible: shown(img), order: Number(img.dataset.mascotOrder) })));
    all.forEach((img, i) => {
      const hide = i !== winner && shown(img);
      if (img.hidden !== hide) img.hidden = hide;
    });
  }

  let frame = 0;
  function schedule() {
    if (!frame) frame = (root.requestAnimationFrame || ((fn) => root.setTimeout(fn, 16)))(enforce);
  }

  function start() {
    fillSlots();
    new root.MutationObserver(schedule).observe(doc.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'],
    });
    schedule();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  root.HaisselMascot = { POSES, MIN_SIZE, MAX_SIZE, src, clampSize, pickVisible, mascot, fillSlots, enforce };
  root.mascot = mascot;
}(typeof window !== 'undefined' ? window : globalThis));
