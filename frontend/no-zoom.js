/*
 * iPhone : aucun zoom, comme une app. iOS ignore parfois touch-action :
 * - deux touchend à moins de 350 ms et 40 px : le second est annulé (pas de
 *   zoom au double tap). Le double tap « Enregistrer » est déjà détecté par
 *   les Pointer Events (pointerup arrive avant touchend) ;
 * - dblclick annulé ;
 * - pincement bloqué seulement dans Découvrir et le fil d'Accueil.
 * Jamais dans les champs de saisie ni [contenteditable].
 */
(function noZoom() {
  'use strict';

  const DOUBLE = { delay: 350, distance: 40 };
  const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  let last = null;

  const editable = (target) => Boolean(target && target.closest && target.closest(EDITABLE));

  document.addEventListener('touchend', (event) => {
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch || editable(event.target)) { last = null; return; }
    const now = event.timeStamp;
    if (last && now - last.t < DOUBLE.delay && Math.hypot(touch.clientX - last.x, touch.clientY - last.y) < DOUBLE.distance) {
      if (event.cancelable) event.preventDefault();
      last = null;
      return;
    }
    last = { t: now, x: touch.clientX, y: touch.clientY };
  }, { passive: false });

  document.addEventListener('dblclick', (event) => {
    if (!editable(event.target)) event.preventDefault();
  }, { passive: false });

  const PINCH_VIEWS = ['discover', 'home'];
  const blockPinch = (event) => {
    if (document.body && PINCH_VIEWS.indexOf(document.body.dataset.view) >= 0) event.preventDefault();
  };
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => document.addEventListener(type, blockPinch, { passive: false }));
}());
