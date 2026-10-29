/*
 * Geste « glisser vers le bas pour fermer », commun à toutes les feuilles du
 * bas (filtres, installation, tuto…), sans DOM : testé par
 * tests/sheet-gesture.test.js, utilisé par bindSheet (app.js).
 *
 *  - la direction est décidée au premier mouvement (8 px) : vers le bas, la
 *    feuille suit le doigt ; à l'horizontale (carrousel) ou vers le haut,
 *    le geste est abandonné et rien ne se ferme ;
 *  - au lâcher : fermeture au-delà de 25 % de la hauteur, ou si le doigt
 *    est lancé vite vers le bas ; sinon retour avec un ressort ;
 *  - le fond assombri s'éclaircit à mesure que la feuille descend.
 */
(function attach(root) {
  const SHEET_GESTURE = { start: 8, closeRatio: 0.25, closeVelocity: 0.6, velocityWindowMs: 100 };

  /** Direction au premier mouvement : null (pas encore), 'down', ou 'other' (abandon). */
  function lockAxis(dx, dy, start = SHEET_GESTURE.start) {
    if (Math.hypot(dx, dy) < start) return null;
    return dy > 0 && Math.abs(dy) > Math.abs(dx) ? 'down' : 'other';
  }

  /** Décision au lâcher : 'close' ou 'restore'. */
  function decideSheetRelease({ dy = 0, vy = 0, height = 1 } = {}) {
    if (dy <= 0) return 'restore';
    return dy > height * SHEET_GESTURE.closeRatio || vy > SHEET_GESTURE.closeVelocity ? 'close' : 'restore';
  }

  /** Opacité du fond : 1 feuille en place, jusqu'à 0,2 feuille entièrement descendue. */
  function backdropOpacity(dy, height) {
    const p = Math.min(1, Math.max(0, dy / Math.max(1, height)));
    return Math.round((1 - p * 0.8) * 1000) / 1000;
  }

  /*
   * Suivi d'un geste : start(x, y, t), puis move(x, y, t) → { axis, dy },
   * puis end() → 'close' | 'restore' | 'ignore'. Vitesse calculée sur les
   * 100 dernières millisecondes (px/ms, positive vers le bas).
   */
  function createSheetDrag({ height }) {
    let origin = null;
    let axis = null;
    let dy = 0;
    const samples = [];

    return {
      start(x, y, t) {
        origin = { x, y };
        axis = null;
        dy = 0;
        samples.length = 0;
        samples.push({ y, t });
      },
      move(x, y, t) {
        if (!origin) return { axis: null, dy: 0 };
        if (!axis) axis = lockAxis(x - origin.x, y - origin.y);
        if (axis === 'down') {
          dy = Math.max(0, y - origin.y);
          samples.push({ y, t });
          while (samples.length > 2 && t - samples[0].t > SHEET_GESTURE.velocityWindowMs) samples.shift();
        }
        return { axis, dy };
      },
      get axis() { return axis; },
      get dy() { return dy; },
      velocity() {
        if (samples.length < 2) return 0;
        const first = samples[0];
        const last = samples[samples.length - 1];
        return (last.y - first.y) / Math.max(1, last.t - first.t);
      },
      end() {
        const result = axis === 'down' ? decideSheetRelease({ dy, vy: this.velocity(), height }) : 'ignore';
        origin = null;
        return result;
      },
    };
  }

  root.HaisselSheetGesture = { SHEET_GESTURE, lockAxis, decideSheetRelease, backdropOpacity, createSheetDrag };
}(typeof window !== 'undefined' ? window : globalThis));
