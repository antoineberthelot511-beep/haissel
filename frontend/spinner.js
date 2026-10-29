/*
 * Roue de chargement circulaire (SVG inline, style Material), commune à tous
 * les petits chargements : tirer pour rafraîchir, suite du fil, résultats de
 * recherche… Le loader à carrés reste réservé à l'écran de démarrage.
 *
 *  - spinner({ size, label }) : roue indéterminée (rotation 1,2 s + arc qui
 *    grandit et rétrécit, spinner.css) ;
 *  - mode « traction » : setPull(distance) dessine un arc de 0 à 270° qui
 *    tourne avec la distance, avec une pointe de flèche au bout.
 *
 * La logique testable (pullState, releaseDecision) est sans DOM.
 */
(function attach(root) {
  // Seuil du geste, distance maximale suivie, position de la pastille pendant le rechargement.
  const PTR = { threshold: 70, max: 120, rest: 64, start: 8 };
  const R = 8.5;
  const CIRCUMFERENCE = 2 * Math.PI * R;
  const MAX_SWEEP = 270;

  /**
   * État de la pastille pour une distance tirée : progression (0 → 1 au
   * seuil), arc en degrés (0 → 270), rotation, décalage vertical, seuil atteint.
   */
  function pullState(pull, { threshold = PTR.threshold, max = PTR.max } = {}) {
    const distance = Math.max(0, Math.min(pull, max));
    const p = Math.min(1, distance / threshold);
    return {
      progress: Math.round(p * 1000) / 1000,
      sweep: Math.round(p * MAX_SWEEP),
      rotate: Math.round(distance * 1.5),
      offset: Math.round(distance * 0.75),
      armed: pull >= threshold,
    };
  }

  /** Au lâcher : 'refresh' au-delà du seuil, sinon 'cancel' (rien n'est rechargé). */
  function releaseDecision(pull, threshold = PTR.threshold) {
    return pull >= threshold ? 'refresh' : 'cancel';
  }

  /** Direction au premier mouvement : null (trop tôt), 'down' ou 'other' (abandon). */
  function lockAxis(dx, dy, start = PTR.start) {
    if (Math.hypot(dx, dy) < start) return null;
    return dy > 0 && Math.abs(dy) > Math.abs(dx) ? 'down' : 'other';
  }

  if (typeof root.document === 'undefined') {
    root.HaisselSpinner = { PTR, MAX_SWEEP, CIRCUMFERENCE, pullState, releaseDecision, lockAxis };
    return;
  }
  const doc = root.document;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  }

  /* Roue : <span class="spinner"> contenant le SVG (arc + pointe de flèche). */
  function spinner({ size = 24, label = 'Chargement', determinate = false } = {}) {
    const wrap = doc.createElement('span');
    wrap.className = `spinner${determinate ? ' is-determinate' : ''}`;
    wrap.style.setProperty('--spinner-size', `${size}px`);
    if (label) {
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-label', label);
    } else wrap.setAttribute('aria-hidden', 'true');
    const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'spinner-svg' });
    const group = svgEl('g', { class: 'spinner-turn' });
    const arc = svgEl('circle', { class: 'spinner-arc', cx: 12, cy: 12, r: R, fill: 'none' });
    const arrow = svgEl('path', { class: 'spinner-arrow', d: 'M11.5 -0.5 L17 3.5 L11.5 7.5 Z' });
    group.append(arc, arrow);
    svg.append(group);
    wrap.append(svg);

    /* Traction : arc proportionnel à la distance, qui tourne avec elle. */
    wrap.setPull = (pull) => {
      const state = pullState(pull);
      arc.style.strokeDasharray = `${(CIRCUMFERENCE * state.sweep) / 360} ${CIRCUMFERENCE}`;
      group.style.transform = `rotate(${state.rotate}deg)`;
      // Pointe au bout de l'arc (départ en haut, sens horaire).
      arrow.style.transform = `rotate(${state.sweep}deg)`;
      wrap.classList.toggle('is-armed', state.armed);
      return state;
    };
    /* Rechargement : rotation continue, arc qui grandit et rétrécit. */
    wrap.spin = () => {
      wrap.classList.remove('is-determinate', 'is-armed');
      arc.style.strokeDasharray = '';
      group.style.transform = '';
    };
    return wrap;
  }

  /** Rangée centrée avec une roue (suite du fil, résultats de recherche). */
  function spinnerRow(options) {
    const row = doc.createElement('div');
    row.className = 'spinner-row';
    row.append(spinner(options));
    return row;
  }

  root.HaisselSpinner = { PTR, MAX_SWEEP, CIRCUMFERENCE, pullState, releaseDecision, lockAxis, spinner, spinnerRow };
}(typeof window !== 'undefined' ? window : globalThis));
