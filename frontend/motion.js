/*
 * Système de mouvement (voir motion.css) : apparition à l'écran, cascade du
 * premier écran, compteurs, pastilles, images, toast de confirmation, tirer
 * pour rafraîchir. Aucune librairie ; tout respecte prefers-reduced-motion.
 *
 * La logique testable (cascadeTargets, countFrames) est sans DOM.
 */
(function attach(root) {
  const CASCADE_MAX = 8;
  const CASCADE_STEP_MS = 30;
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
    root.HaisselMotion = { CASCADE_MAX, CASCADE_STEP_MS, COUNT_MS, cascadeTargets, countAt };
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
  function toast(message, { check = true, duration = 2600 } = {}) {
    doc.querySelectorAll('.m-toast').forEach((old) => old.remove());
    const el = doc.createElement('div');
    el.className = 'm-toast lg-glass lg-pill';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const inner = doc.createElement('div');
    inner.className = 'm-toast-inner';
    if (check) {
      inner.insertAdjacentHTML('beforeend',
        '<svg class="m-check" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="14"/><path d="M8 14.5l4 4 8-9"/></svg>');
    }
    const text = doc.createElement('span');
    text.textContent = message;
    inner.append(text);
    el.append(inner);
    doc.body.append(el);
    root.setTimeout(() => {
      el.classList.add('is-leaving');
      root.setTimeout(() => el.remove(), 240);
    }, duration);
    return el;
  }

  /*
   * Tirer pour rafraîchir (Accueil, tout en haut de page, écran tactile) :
   * le petit loader suit la traction, puis onRefresh() recharge le fil.
   * Écouteurs passifs : le défilement natif n'est jamais bloqué.
   */
  function pullToRefresh({ isActive, onRefresh }) {
    const indicator = doc.createElement('div');
    indicator.className = 'ptr lg-glass lg-pill';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML = '<div class="loader is-small"></div>';
    doc.body.append(indicator);
    let start = null;
    let pull = 0;
    let busy = false;

    const paint = (distance) => {
      const p = Math.min(1, distance / PTR_THRESHOLD);
      indicator.style.opacity = String(p);
      indicator.style.transform = `translateY(${Math.min(distance, PTR_MAX) * 0.6 - 48}px) scale(${0.6 + p * 0.4}) rotate(${p * 180}deg)`;
    };
    const settle = () => {
      indicator.classList.add('is-settling');
      indicator.style.opacity = '0';
      indicator.style.transform = '';
      root.setTimeout(() => indicator.classList.remove('is-settling', 'is-refreshing'), 400);
    };

    root.addEventListener('touchstart', (event) => {
      if (busy || event.touches.length !== 1 || root.scrollY > 0 || !isActive()) { start = null; return; }
      start = event.touches[0].clientY;
      pull = 0;
      indicator.classList.remove('is-settling');
    }, { passive: true });

    root.addEventListener('touchmove', (event) => {
      if (start === null) return;
      pull = event.touches[0].clientY - start;
      if (pull <= 0 || root.scrollY > 0) { paint(0); return; }
      paint(pull);
    }, { passive: true });

    root.addEventListener('touchend', async () => {
      if (start === null) return;
      start = null;
      if (pull < PTR_THRESHOLD) { settle(); return; }
      busy = true;
      indicator.classList.add('is-settling', 'is-refreshing');
      indicator.style.opacity = '1';
      indicator.style.transform = 'translateY(16px) scale(1)';
      try { await onRefresh(); } finally {
        busy = false;
        settle();
      }
    }, { passive: true });
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
    doc.querySelectorAll('[data-reveal]').forEach(reveal);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  root.HaisselMotion = {
    CASCADE_MAX, CASCADE_STEP_MS, COUNT_MS, cascadeTargets, countAt,
    reduced, reveal, cascade, setCount, fadeImage, toast, pullToRefresh, navigate, noteView,
  };
}(typeof window !== 'undefined' ? window : globalThis));
