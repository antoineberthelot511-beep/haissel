/*
 * Feuille « Installe HAISSEL en 30 secondes » (iPhone) : carrousel de 5
 * mini-écrans dessinés en HTML/CSS/SVG (aucune image : nets à toute taille,
 * clairs ou sombres avec le thème). Éléments d'interface génériques et
 * simplifiés, sans logo de marque tierce ; seul le logo HAISSEL apparaît.
 *
 * Sur chaque écran, l'élément à toucher est mis en évidence : anneau bleu
 * --brand qui pulse doucement et petit doigt stylisé (pulsation coupée en
 * prefers-reduced-motion, app-v2.css).
 *
 * Légende hors des écrans, à hauteur fixe (2 lignes) : la feuille ne change
 * pas de hauteur d'une étape à l'autre. Balayage au doigt natif (scroll-snap) ;
 * l'écran qui arrive grandit légèrement pendant le glissement.
 */
(function attach(root) {
  const CAPTIONS = [
    'Touche le bouton ≡ à gauche de l’adresse',
    'Choisis « Partager »',
    'Touche « En voir plus »',
    'Choisis « Sur l’écran d’accueil »',
    'Active « Ouvrir comme app web », puis touche « Ajouter »',
  ];
  const STEPS = CAPTIONS.length;
  // Écart d'échelle de l'écran pendant le glissement : 0,92 sur le côté, 1 au centre.
  const MIN_SCALE = 0.92;

  /** Échelle d'un écran selon sa distance au centre (en largeurs d'écran). */
  function scaleFor(distance) {
    return 1 - (1 - MIN_SCALE) * Math.min(1, Math.abs(distance));
  }

  // Icônes génériques (traits simples), insérées telles quelles : aucun contenu externe.
  const ICONS = {
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11v9h12v-9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.5v7M8.5 12h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>',
    finger: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M13 4.5a2.5 2.5 0 0 1 5 0V14l5.2 1.1a3 3 0 0 1 2.3 3.4l-1.1 7.2A4 4 0 0 1 20.4 29h-6.2a4 4 0 0 1-3.3-1.8l-4.3-6.4a2.2 2.2 0 0 1 3.3-2.8L13 21Z" fill="#fff" stroke="#1d2433" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  };

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  function factory(doc) {
    const el = (tag, className, ...children) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
      }
      return node;
    };
    const svg = (name, className = 'ts-ico') => {
      const span = el('span', className);
      span.innerHTML = ICONS[name];
      return span;
    };
    // Mise en évidence : anneau qui pulse + doigt.
    const hl = (node) => {
      node.classList.add('ts-hl');
      node.append(svg('finger', 'ts-finger'));
      return node;
    };
    const logo = (className) => {
      const img = doc.createElement('img');
      img.className = className;
      img.src = '/logo.svg';
      img.alt = '';
      img.width = 28;
      img.height = 28;
      return img;
    };
    const bar = (w) => {
      const line = el('span', 'ts-line');
      line.style.width = `${w}%`;
      return line;
    };
    const status = () => el('div', 'ts-status', el('span', null, '9:41'), el('span', 'ts-status-icons', el('i'), el('i'), el('i')));
    // Aperçu simplifié de l'Accueil HAISSEL (deux cartes du fil).
    const page = () => el('div', 'ts-page',
      el('div', 'ts-app-head', logo('ts-logo'), el('strong', null, 'HAISSEL')),
      el('div', 'ts-stories', el('i'), el('i'), el('i'), el('i')),
      [0, 1].map(() => el('div', 'ts-card',
        el('div', 'ts-card-head', el('i', 'ts-dot'), bar(40), el('span', 'ts-badge', 'Lien affilié')),
        el('div', 'ts-card-visual'),
        bar(80), bar(55))));
    const address = (highlight) => {
      const menu = el('span', 'ts-addr-btn', svg('menu'));
      return el('div', 'ts-addr', highlight ? hl(menu) : menu, el('span', 'ts-addr-text', 'haissel'), svg('share', 'ts-ico ts-addr-share'));
    };
    const row = (icon, label, highlight) => {
      const node = el('div', 'ts-row', el('span', null, label), icon ? svg(icon) : null);
      return highlight ? hl(node) : node;
    };
    const screen = (...children) => el('div', 'ts-phone', el('div', 'ts-screen', status(), children));

    return [
      // 1. Safari ouvert sur HAISSEL, bouton ≡ de la barre d'adresse.
      () => screen(page(), address(true)),
      // 2. Menu ouvert : « Partager ».
      () => screen(page(), el('div', 'ts-dim'), el('div', 'ts-popover',
        row(null, 'Ajouter aux favoris'), row('share', 'Partager', true), row(null, 'Rechercher dans la page'), row(null, 'Réglages du site')),
      address(false)),
      // 3. Feuille de partage : « En voir plus ».
      () => screen(page(), el('div', 'ts-dim'), el('div', 'ts-sheet',
        el('div', 'ts-sheet-head', logo('ts-logo sm'), el('div', null, el('strong', null, 'HAISSEL'), bar(60))),
        el('div', 'ts-apps', el('i'), el('i'), el('i'), el('i')),
        row(null, 'Copier'), row(null, 'Ajouter aux favoris'),
        hl(el('div', 'ts-more', svg('more'), el('span', null, 'En voir plus'))))),
      // 4. Liste d'actions : « Sur l'écran d'accueil ».
      () => screen(page(), el('div', 'ts-dim'), el('div', 'ts-sheet tall',
        el('div', 'ts-sheet-grab'),
        row(null, 'Copier'), row(null, 'Ajouter à la liste de lecture'), row('plus', 'Sur l’écran d’accueil', true),
        row(null, 'Imprimer'), row(null, 'Enregistrer dans Fichiers'))),
      // 5. « Sur l'écran d'accueil » : icône HAISSEL, « Ouvrir comme app web » activé, « Ajouter ».
      () => screen(el('div', 'ts-add',
        el('div', 'ts-add-nav', el('span', 'ts-link', 'Annuler'), el('strong', null, 'Sur l’écran d’accueil'), hl(el('span', 'ts-link ts-strong', 'Ajouter'))),
        el('div', 'ts-add-card', logo('ts-app-icon'), el('div', 'ts-add-name', el('strong', null, 'HAISSEL'), bar(70))),
        el('div', 'ts-row ts-switch-row', el('span', null, 'Ouvrir comme app web'), el('span', 'ts-switch is-on')),
        bar(85), bar(60))),
    ];
  }

  /*
   * Carrousel : balayage natif (scroll-snap), points de pagination,
   * « Précédent » (discret, invisible à la 1re étape) et « Suivant » puis
   * « C'est parti » sur la dernière.
   */
  function mount({ track, dots, next, prev, caption, onDone }) {
    const doc = track.ownerDocument;
    const screens = factory(doc);
    let current = 0;
    const reduced = () => {
      try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; }
    };

    track.replaceChildren(...screens.map((draw, index) => {
      const slide = doc.createElement('figure');
      slide.className = 'tuto-slide';
      slide.setAttribute('aria-roledescription', 'étape');
      slide.setAttribute('aria-label', `Étape ${index + 1} sur ${STEPS} : ${CAPTIONS[index]}`);
      const phone = draw();
      phone.setAttribute('aria-hidden', 'true');
      slide.append(phone);
      return slide;
    }));

    dots.replaceChildren(...CAPTIONS.map((text, index) => {
      const dot = doc.createElement('button');
      dot.type = 'button';
      dot.className = 'tuto-dot';
      dot.setAttribute('aria-label', `Étape ${index + 1}`);
      dot.addEventListener('click', () => goTo(index));
      return dot;
    }));

    function paint() {
      [...dots.children].forEach((dot, index) => {
        if (index === current) dot.setAttribute('aria-current', 'step');
        else dot.removeAttribute('aria-current');
      });
      next.textContent = current >= STEPS - 1 ? 'C’est parti' : 'Suivant';
      if (prev) prev.classList.toggle('is-hidden', current === 0);
      if (caption) caption.textContent = CAPTIONS[current];
    }

    /* Glissement : l'écran qui arrive grandit (0,92 → 1). */
    function scaleSlides() {
      const width = track.clientWidth || 1;
      [...track.children].forEach((slide) => {
        const phone = slide.firstChild;
        if (!phone || !phone.style) return;
        // La piste est position: relative : offsetLeft se compte depuis son bord.
        phone.style.transform = reduced() ? '' : `scale(${scaleFor((slide.offsetLeft - track.scrollLeft) / width)})`;
      });
    }

    function goTo(index, { smooth = true } = {}) {
      current = Math.max(0, Math.min(STEPS - 1, index));
      const slide = track.children[current];
      if (slide) track.scrollTo({ left: slide.offsetLeft, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
      paint();
    }

    let pending = false;
    track.addEventListener('scroll', () => {
      if (pending) return;
      pending = true;
      root.requestAnimationFrame(() => {
        pending = false;
        scaleSlides();
        const width = track.clientWidth || 1;
        const index = Math.round(track.scrollLeft / width);
        if (index !== current) { current = Math.max(0, Math.min(STEPS - 1, index)); paint(); }
      });
    }, { passive: true });

    next.addEventListener('click', () => {
      if (current >= STEPS - 1) onDone();
      else goTo(current + 1);
    });
    if (prev) prev.addEventListener('click', () => goTo(current - 1));

    paint();
    return { reset: () => { goTo(0, { smooth: false }); scaleSlides(); }, count: STEPS, goTo };
  }

  root.HaisselTuto = { CAPTIONS, STEPS, MIN_SCALE, ICONS, scaleFor, mount };
}(typeof window !== 'undefined' ? window : globalThis));
