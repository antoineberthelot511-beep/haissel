/*
 * Système de mouvement (voir motion.css) : apparition à l'écran, cascade du
 * premier écran, compteurs, pastilles, images, toast de confirmation (balayé
 * vers le haut pour le fermer), tirer pour rafraîchir, menus ouverts depuis
 * le point touché, secousse des champs en erreur. Aucune librairie ; tout
 * respecte prefers-reduced-motion.
 *
 * La logique testable (cascadeTargets, countFrames) est sans DOM.
 */
(function attach(root) {
  const CASCADE_MAX = 8;
  const CASCADE_STEP_MS = 30;
  const MENU_STEP_MS = 20;
  const MENU_CLOSE_MS = 120;
  const COUNT_MS = 600;
  const PTR_THRESHOLD = 70;
  const PTR_MAX = 110;

  const reduced = () => {
    try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; }
  };

  /**
   * Éléments à animer en cascade : ceux du premier écran (visibles dans la
   * fenêtre), 8 au plus, dans l'ordre. rects : getBoundingClientRect().
   */
  function cascadeTargets(rects, viewportHeight, max = CASCADE_MAX) {
    const picked = [];
    rects.forEach((rect, index) => {
      if (picked.length < max && rect.top < viewportHeight && rect.bottom > 0) picked.push(index);
    });
    return picked;
  }

  /**
   * Point d'origine d'un menu (transform-origin), en px dans le menu : le
   * point touché, ramené dans le rectangle du menu ; sans point, le centre.
   */
  function menuOrigin(rect, point) {
    if (!point) return { x: rect.width / 2, y: rect.height / 2 };
    const clamp = (v, max) => Math.round(Math.min(max, Math.max(0, v)));
    return { x: clamp(point.x - rect.left, rect.width), y: clamp(point.y - rect.top, rect.height) };
  }

  /** Toast lâché : fermé s'il a été tiré de 30 px vers le haut ou lancé vite. */
  function toastDismissed(dy, vy) {
    return dy < -30 || vy < -0.3;
  }

  /** Valeur affichée par le compteur à l'instant t (0 → valeur en 600 ms, ralenti à la fin). */
  function countAt(value, elapsed, duration = COUNT_MS) {
    if (elapsed >= duration) return value;
    const p = Math.max(0, elapsed) / duration;
    return Math.round(value * (1 - (1 - p) ** 3));
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  if (typeof root.document === 'undefined') {
    root.HaisselMotion = { CASCADE_MAX, CASCADE_STEP_MS, MENU_STEP_MS, MENU_CLOSE_MS, COUNT_MS, cascadeTargets, countAt, menuOrigin, toastDismissed };
    return;
  }
  const doc = root.document;

  /* Apparition à l'écran : une seule fois par élément. */
  const revealObserver = 'IntersectionObserver' in root
    ? new root.IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
        const pending = counters.get(entry.target);
        if (pending !== undefined) runCount(entry.target, pending);
      }
    }, { rootMargin: '0px 0px -5% 0px' })
    : null;

  function reveal(element) {
    if (!element) return;
    if (!revealObserver || reduced()) { element.classList.add('is-visible'); return; }
    revealObserver.observe(element);
  }

  /* Cascade : premier rendu d'une liste, éléments du premier écran seulement. */
  function cascade(container) {
    if (!container || container.dataset.cascaded || reduced()) return;
    container.dataset.cascaded = '1';
    const children = [...container.children];
    const picked = cascadeTargets(children.map((el) => el.getBoundingClientRect()), root.innerHeight);
    picked.forEach((index, order) => {
      const el = children[index];
      el.style.setProperty('--m-i', String(order));
      el.classList.add('m-enter');
      el.addEventListener('animationend', () => { el.classList.remove('m-enter'); el.style.removeProperty('--m-i'); }, { once: true });
    });
  }

  /* Compteurs du profil : 0 → valeur en 600 ms à la première apparition. */
  const counters = new WeakMap();
  const counted = new WeakSet();

  function runCount(element, value) {
    counters.delete(element);
    counted.add(element);
    if (reduced() || value <= 0) { element.textContent = String(value); return; }
    const start = root.performance.now();
    const step = (now) => {
      const elapsed = now - start;
      element.textContent = String(countAt(value, elapsed));
      if (elapsed < COUNT_MS) root.requestAnimationFrame(step);
    };
    element.textContent = '0';
    root.requestAnimationFrame(step);
  }

  function setCount(element, value) {
    if (!element) return;
    const n = Math.max(0, Number(value) || 0);
    if (counted.has(element) || !revealObserver) { element.textContent = String(n); counted.add(element); return; }
    // Pas encore apparu : on compte à la première apparition.
    counters.set(element, n);
    element.textContent = '0';
    revealObserver.observe(element);
  }

  /* Pastilles (data-pop) : petit « pop » quand elles apparaissent. */
  function watchPops() {
    const observer = new root.MutationObserver((mutations) => {
      for (const { target } of mutations) {
        if (target.hidden) continue;
        target.classList.remove('m-pop');
        void target.offsetWidth; // relance l'animation
        target.classList.add('m-pop');
      }
    });
    doc.querySelectorAll('[data-pop]').forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ['hidden'] }));
  }

  /* Rebond de l'icône de l'onglet touché. */
  function watchNav() {
    doc.querySelectorAll('.topbar-nav .nav-button:not(.nav-fab)').forEach((button) => {
      button.addEventListener('click', () => {
        const icon = button.querySelector('.icon, .nav-avatar');
        if (!icon || reduced()) return;
        icon.classList.remove('m-bounce');
        void icon.offsetWidth;
        icon.classList.add('m-bounce');
        icon.addEventListener('animationend', () => icon.classList.remove('m-bounce'), { once: true });
      });
    });
  }

  /* Images : fondu à la fin du chargement, sur fond squelette. */
  function fadeImage(img) {
    if (!img || img.dataset.motion) return;
    img.dataset.motion = '1';
    img.classList.add('m-img');
    const wrap = img.parentElement;
    const done = () => {
      img.classList.add('is-loaded');
      wrap?.classList.remove('is-loading');
    };
    if (img.complete && img.naturalWidth) { done(); return; }
    wrap?.classList.add('m-img-wrap', 'is-loading');
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  }

  /* Toast de confirmation en verre, depuis le haut, avec une coche dessinée. */
  function toast(message, { check = true, duration = 2600, mascot = '' } = {}) {
    doc.querySelectorAll('.m-toast').forEach((old) => old.remove());
    const el = doc.createElement('div');
    el.className = 'm-toast lg-glass lg-pill';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const inner = doc.createElement('div');
    inner.className = 'm-toast-inner';
    // Avec l'ours (mascot.js) à la place de la coche : publication, bienvenue…
    if (mascot && root.HaisselMascot) {
      el.classList.add('has-mascot');
      inner.append(root.HaisselMascot.mascot(mascot, { size: 72 }));
    } else if (check) {
      inner.insertAdjacentHTML('beforeend',
        '<svg class="m-check" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="14"/><path d="M8 14.5l4 4 8-9"/></svg>');
    }
    const text = doc.createElement('span');
    text.textContent = message;
    inner.append(text);
    el.append(inner);
    doc.body.append(el);
    const leave = () => {
      if (el.classList.contains('is-leaving')) return;
      el.classList.add('is-leaving');
      root.setTimeout(() => el.remove(), 240);
    };
    const timer = root.setTimeout(leave, duration);
    // Balayé vers le haut : suit le doigt, puis se ferme (ou revient en place).
    let drag = null;
    el.addEventListener('pointerdown', (event) => {
      drag = { id: event.pointerId, y: event.clientY, t: event.timeStamp, dy: 0, vy: 0 };
      try { el.setPointerCapture(event.pointerId); } catch (error) { /* pointeur déjà relâché */ }
    });
    el.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dy = Math.min(0, event.clientY - drag.y);
      drag.vy = (dy - drag.dy) / Math.max(1, event.timeStamp - drag.t);
      drag.dy = dy;
      drag.t = event.timeStamp;
      el.style.transform = `translateX(-50%) translateY(${dy}px)`;
    });
    const release = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const { dy, vy } = drag;
      drag = null;
      if (toastDismissed(dy, vy)) {
        root.clearTimeout(timer);
        el.classList.add('is-swiped');
        el.style.transform = 'translateX(-50%) translateY(-120%)';
        leave();
        return;
      }
      el.classList.add('is-settling');
      el.style.transform = '';
      root.setTimeout(() => el.classList.remove('is-settling'), 360);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    return el;
  }

  /*
   * Menus (déroulants, contextuels, « … » des stories) : ouverture depuis le
   * point touché, scale .85 → 1 et fondu avec ressort, éléments en cascade
   * (20 ms) ; fermeture en 120 ms. L'appelant affiche le menu avant
   * openMenu et le cache (ou le retire) dans done() de closeMenu.
   */
  function openMenu(menu, point) {
    if (!menu) return;
    menu.classList.remove('m-menu-out');
    const origin = menuOrigin(menu.getBoundingClientRect(), point);
    menu.style.transformOrigin = `${origin.x}px ${origin.y}px`;
    [...menu.children].forEach((item, index) => item.style.setProperty('--m-i', String(index)));
    menu.classList.remove('m-menu-in');
    void menu.offsetWidth;
    menu.classList.add('m-menu-in');
  }

  function closeMenu(menu, done = () => {}) {
    if (!menu) { done(); return; }
    menu.classList.remove('m-menu-in');
    if (reduced() || !menu.isConnected || !menu.getClientRects().length) { done(); return; }
    menu.classList.add('m-menu-out');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      menu.classList.remove('m-menu-out');
      done();
    };
    menu.addEventListener('animationend', finish, { once: true });
    root.setTimeout(finish, MENU_CLOSE_MS + 40);
  }

  /* Secousse légère d'un champ (ou d'un message) en erreur. */
  function shake(element) {
    if (!element || reduced()) return;
    element.classList.remove('m-shake');
    void element.offsetWidth;
    element.classList.add('m-shake');
    element.addEventListener('animationend', () => element.classList.remove('m-shake'), { once: true });
  }

  /* Champ marqué aria-invalid="true" : son libellé et son contour secouent. */
  function watchInvalid() {
    const observer = new root.MutationObserver((mutations) => {
      for (const { target } of mutations) {
        if (target.getAttribute('aria-invalid') === 'true') shake(target.closest('.field') || target);
      }
    });
    observer.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['aria-invalid'] });
  }

  /*
   * Tirer pour rafraîchir (Accueil, tout en haut de page, écran tactile) :
   * une pastille ronde descend avec le doigt ; l'arc de la roue (spinner.js)
   * s'allonge de 0 à 270° et tourne, avec une pointe de flèche. Au seuil
   * (70 px) la flèche disparaît et la pastille rebondit. Lâché au-delà : la
   * pastille se cale à 64 px, la roue tourne pendant onRefresh(), puis la
   * pastille rétrécit et disparaît (200 ms). Lâché avant : elle remonte, rien
   * n'est rechargé. Geste vertical vers le bas seulement, page tout en haut ;
   * écouteurs passifs, le défilement natif n'est jamais bloqué.
   */
  function pullToRefresh({ isActive, onRefresh }) {
    const Spinner = root.HaisselSpinner;
    if (!Spinner) return null;
    const { PTR } = Spinner;
    // Pas de « tirer pour actualiser » natif en plus (double rechargement sur Chrome Android).
    doc.documentElement.style.overscrollBehaviorY = 'contain';
    const indicator = doc.createElement('div');
    indicator.className = 'ptr';
    indicator.setAttribute('aria-hidden', 'true');
    const wheel = Spinner.spinner({ size: 24, label: '', determinate: true });
    indicator.append(wheel);
    doc.body.append(indicator);
    let start = null;
    let axis = null;
    let pull = 0;
    let armed = false;
    let busy = false;

    const place = (offset, scale) => { indicator.style.transform = `translateY(${offset}px) scale(${scale})`; };
    const paint = (distance) => {
      const state = wheel.setPull(distance);
      indicator.classList.add('is-pulling');
      place(state.offset, 0.6 + state.progress * 0.4);
      if (state.armed !== armed) {
        armed = state.armed;
        indicator.classList.toggle('is-armed', armed);
      }
    };
    const hide = () => {
      indicator.classList.remove('is-pulling', 'is-armed', 'is-settling');
      indicator.classList.add('is-leaving');
      place(0, 0.4);
      root.setTimeout(() => {
        indicator.classList.remove('is-leaving');
        wheel.classList.add('is-determinate');
        wheel.setPull(0);
      }, 200);
    };

    root.addEventListener('touchstart', (event) => {
      if (busy || event.touches.length !== 1 || root.scrollY > 0 || !isActive()) { start = null; return; }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      axis = null;
      pull = 0;
      armed = false;
    }, { passive: true });

    root.addEventListener('touchmove', (event) => {
      if (!start) return;
      const touch = event.touches[0];
      if (!axis) axis = Spinner.lockAxis(touch.clientX - start.x, touch.clientY - start.y);
      if (axis === 'other' || root.scrollY > 0) { start = null; if (pull) hide(); pull = 0; return; }
      if (axis !== 'down') return;
      pull = Math.max(0, touch.clientY - start.y);
      paint(pull);
    }, { passive: true });

    root.addEventListener('touchend', async () => {
      if (!start) return;
      start = null;
      if (Spinner.releaseDecision(pull) !== 'refresh') { if (pull) hide(); return; }
      busy = true;
      indicator.classList.remove('is-armed');
      indicator.classList.add('is-settling', 'is-pulling');
      wheel.spin();
      place(PTR.rest, 1);
      try { await onRefresh(); } finally {
        busy = false;
        hide();
      }
    }, { passive: true });

    return { indicator, wheel };
  }

  /* Changement d'onglet : sens de la navigation (ordre de la barre du bas). */
  const TAB_ORDER = ['home', 'discover', 'messages', 'links', 'profile'];
  let currentTab = 'home';

  function setDirection(from, to) {
    const a = TAB_ORDER.indexOf(from);
    const b = TAB_ORDER.indexOf(to);
    const back = a >= 0 && b >= 0 ? b < a : false;
    doc.documentElement.dataset.navDir = back ? 'back' : 'forward';
  }

  /*
   * Changement d'onglet : sens du glissement, puis mise à jour immédiate.
   * Pas de document.startViewTransition : mesurée (Chromium, CPU x4), la
   * capture d'écran coûtait des frames de plus de 50 ms ; le glissement CSS
   * de motion.css, non.
   */
  function navigate(to, update) {
    setDirection(currentTab, to);
    currentTab = to;
    update();
  }

  function noteView(view) {
    if (view !== currentTab) setDirection(currentTab, view);
    currentTab = view;
  }

  function start() {
    watchPops();
    watchNav();
    watchInvalid();
    doc.querySelectorAll('[data-reveal]').forEach(reveal);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  root.HaisselMotion = {
    CASCADE_MAX, CASCADE_STEP_MS, MENU_STEP_MS, MENU_CLOSE_MS, COUNT_MS, cascadeTargets, countAt, menuOrigin, toastDismissed,
    reduced, reveal, cascade, setCount, fadeImage, toast, pullToRefresh, navigate, noteView, openMenu, closeMenu, shake,
  };
}(typeof window !== 'undefined' ? window : globalThis));
