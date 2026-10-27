'use strict';

/*
 * « Goutte » de la barre de navigation du bas (voir liquid-glass.css).
 *
 * - Elle se place derrière l'onglet actif et glisse vers le nouvel onglet.
 *   L'onglet actif reste décidé par app.js (classe .active) : on l'observe.
 * - On peut faire glisser le doigt sur la barre : la goutte suit, l'onglet
 *   est choisi au relâchement. Un simple toucher et le clavier ne changent
 *   pas : tant que le doigt n'a pas bougé, c'est un clic ordinaire.
 * - Réfraction SVG pour Chromium seulement, détecté par JavaScript :
 *   @supports accepte backdrop-filter: url() dans Safari sans l'appliquer.
 */
(function liquidGlass() {
  const DRAG_THRESHOLD = 8;

  function isChromium() {
    const brands = navigator.userAgentData?.brands || [];
    return brands.some((brand) => /Chromium/i.test(brand.brand));
  }

  function addRefraction() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = '<filter id="lg-refract" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">'
      + '<feTurbulence type="fractalNoise" baseFrequency="0.008 0.03" numOctaves="2" seed="7" result="noise"/>'
      + '<feGaussianBlur in="noise" stdDeviation="2" result="map"/>'
      + '<feDisplacementMap in="SourceGraphic" in2="map" scale="14" xChannelSelector="R" yChannelSelector="G"/>'
      + '</filter>';
    document.body.append(svg);
    document.documentElement.classList.add('lg-refract');
  }

  function init() {
    const bar = document.querySelector('.topbar-nav .topbar-nav-inner');
    if (!bar) return;
    if (isChromium()) addRefraction();

    const drop = document.createElement('span');
    drop.className = 'lg-drop';
    drop.setAttribute('aria-hidden', 'true');
    bar.prepend(drop);

    // Onglets « goutte » : tous sauf le bouton rond « Publier ».
    const tabs = () => [...bar.querySelectorAll('.nav-button:not(.nav-fab)')];

    function placeOn(button, { animate = true } = {}) {
      if (!button || button.classList.contains('nav-fab') || !button.offsetWidth) {
        drop.classList.add('is-hidden');
        return;
      }
      const x = button.offsetLeft;
      const previous = drop.style.getPropertyValue('--lg-x');
      drop.style.setProperty('--lg-x', `${x}px`);
      drop.style.setProperty('--lg-w', `${button.offsetWidth}px`);
      const wasHidden = drop.classList.contains('is-hidden');
      drop.classList.remove('is-hidden');
      if (animate && !wasHidden && previous && previous !== `${x}px`) {
        drop.classList.remove('is-moving');
        void drop.offsetWidth; // relance l'animation d'étirement
        drop.classList.add('is-moving');
      }
    }

    function syncToActive(options) {
      placeOn(bar.querySelector('.nav-button.active'), options);
    }

    drop.addEventListener('animationend', () => drop.classList.remove('is-moving'));
    // On observe les boutons seuls : la goutte change aussi de classe, et
    // l'observer sur toute la barre se relancerait lui-même sans fin.
    const observer = new MutationObserver(() => syncToActive());
    bar.querySelectorAll('.nav-button').forEach((button) => observer.observe(button, { attributes: true, attributeFilter: ['class'] }));
    window.addEventListener('resize', () => syncToActive({ animate: false }));
    // La barre est masquée tant que l'écran de connexion est affiché : on
    // replace la goutte quand elle prend sa taille.
    if ('ResizeObserver' in window) new ResizeObserver(() => syncToActive({ animate: false })).observe(bar);
    // Pas d'animation au premier placement.
    drop.style.transition = 'none';
    syncToActive({ animate: false });
    requestAnimationFrame(() => { drop.style.transition = ''; });

    /* Glisser le doigt sur la barre. */
    let drag = null;

    function nearest(clientX) {
      let best = null;
      let bestDistance = Infinity;
      for (const tab of tabs()) {
        const rect = tab.getBoundingClientRect();
        const distance = Math.abs(clientX - (rect.left + rect.width / 2));
        if (distance < bestDistance) { best = tab; bestDistance = distance; }
      }
      return best;
    }

    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.nav-fab')) return;
      drag = { id: event.pointerId, startX: event.clientX, moved: false };
    });

    bar.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        bar.setPointerCapture(event.pointerId);
        drop.classList.remove('is-hidden', 'is-moving');
        drop.classList.add('is-dragging');
      }
      const barRect = bar.getBoundingClientRect();
      const width = drop.offsetWidth;
      const x = Math.max(0, Math.min(barRect.width - width, event.clientX - barRect.left - width / 2));
      drop.style.setProperty('--lg-x', `${x}px`);
    });

    function endDrag(event, cancelled) {
      if (!drag || event.pointerId !== drag.id) return;
      const { moved } = drag;
      drag = null;
      if (!moved) return; // simple toucher : le clic suit normalement
      drop.classList.remove('is-dragging');
      const target = cancelled ? null : nearest(event.clientX);
      if (target && !target.classList.contains('active')) target.click();
      else syncToActive();
    }

    bar.addEventListener('pointerup', (event) => endDrag(event, false));
    bar.addEventListener('pointercancel', (event) => endDrag(event, true));
    // Après un glissement, le navigateur peut émettre un clic : on l'ignore.
    bar.addEventListener('click', (event) => {
      if (event.target === bar) event.stopPropagation();
    }, true);
  }

  /*
   * Défilement : l'en-tête est transparent tout en haut et devient en verre
   * au-delà de 8 px ; les boutons + et cloche font l'inverse (pilules en
   * verre seulement sur l'en-tête transparent). La barre de recherche n'est
   * en verre que collée sous l'en-tête. Une lecture par image au plus.
   */
  const SCROLL_THRESHOLD = 8;

  function initScrollGlass() {
    const topbar = document.querySelector('.topbar');
    const layer = document.querySelector('.topbar-glass');
    if (!topbar || !layer) return;
    const pills = [...topbar.querySelectorAll('.topbar-icon.lg-glass')];
    const search = document.getElementById('community-filters');
    let pending = false;

    function update() {
      pending = false;
      const scrolled = window.scrollY > SCROLL_THRESHOLD;
      layer.classList.toggle('is-flat', !scrolled);
      pills.forEach((pill) => pill.classList.toggle('is-flat', scrolled));
      if (search) {
        const visible = search.offsetParent !== null;
        const top = parseFloat(window.getComputedStyle(search).top) || 0;
        const stuck = visible && scrolled && search.getBoundingClientRect().top <= top + 0.5;
        search.classList.toggle('is-flat', !stuck);
      }
    }

    function schedule() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Changement d'onglet (app.js remet le défilement en haut, data-view change).
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    update();
    document.documentElement.classList.add('lg-ready');
  }

  function start() {
    init();
    initScrollGlass();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());
