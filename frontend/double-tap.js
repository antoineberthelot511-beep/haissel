/*
 * Double tap (Pointer Events, sans dblclick, peu fiable sur iOS) : deux
 * pointerup à moins de 300 ms et à moins de 30 px l'un de l'autre, sans
 * mouvement entre l'appui et le relâcher (un défilement annule).
 *
 * Logique pure : testée par tests/double-tap.test.js, utilisée par app.js
 * (Découvrir : double tap = Enregistrer).
 */
(function attach(root) {
  'use strict';

  const DOUBLE_TAP = { delay: 300, distance: 30, move: 10 };

  function createDetector(options = {}) {
    const o = { ...DOUBLE_TAP, ...options };
    let down = null;
    let last = null;
    return {
      down(x, y, t) { down = { x, y, t }; },
      move(x, y) {
        if (down && Math.hypot(x - down.x, y - down.y) > o.move) { down = null; last = null; }
      },
      cancel() { down = null; last = null; },
      /** true au second tap d'un double tap. */
      up(x, y, t) {
        if (!down) return false;
        down = null;
        if (last && t - last.t <= o.delay && Math.hypot(x - last.x, y - last.y) <= o.distance) {
          last = null;
          return true;
        }
        last = { x, y, t };
        return false;
      },
    };
  }

  root.HaisselDoubleTap = { DOUBLE_TAP, createDetector };
}(typeof window !== 'undefined' ? window : globalThis));
