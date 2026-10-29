/*
 * Feuille « Installe HAISSEL en 30 secondes » (iPhone) : carrousel de 5
 * images (frontend/images/tuto-ios/etape-N.webp, 572×1024, ours compris ;
 * npm run tuto:build les copie depuis design/tuto-ios-v2/).
 *
 * Légende hors des images, à hauteur fixe (2 lignes) : la feuille ne change
 * pas de hauteur d'une étape à l'autre. Balayage au doigt natif (scroll-snap) ;
 * l'image qui arrive grandit légèrement pendant le glissement.
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
  // Échelle de l'image pendant le glissement : 0,92 sur le côté, 1 au centre.
  const MIN_SCALE = 0.92;

  /** Échelle d'une image selon sa distance au centre (en largeurs de piste). */
  function scaleFor(distance) {
    return 1 - (1 - MIN_SCALE) * Math.min(1, Math.abs(distance));
  }

  const IMAGE_DIR = '/images/tuto-ios/';
  const IMAGE_WIDTH = 572;
  const IMAGE_HEIGHT = 1024;

  /** Étapes : image, légende et texte alternatif. */
  function steps() {
    return CAPTIONS.map((caption, index) => ({
      number: index + 1, caption, src: `${IMAGE_DIR}etape-${index + 1}.webp`, alt: `Étape ${index + 1} : ${caption}`,
    }));
  }

  /*
   * Carrousel : balayage natif (scroll-snap), points de pagination,
   * « Précédent » (discret, invisible à la 1re étape) et « Suivant » puis
   * « C'est parti » sur la dernière.
   */
  function mount({ track, dots, next, prev, caption, onDone }) {
    const doc = track.ownerDocument;
    let current = 0;
    const reduced = () => {
      try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; }
    };

    track.replaceChildren(...steps().map((step, index) => {
      const slide = doc.createElement('figure');
      slide.className = 'tuto-slide';
      slide.setAttribute('aria-roledescription', 'étape');
      slide.setAttribute('aria-label', `${step.number} sur ${STEPS}`);
      const img = doc.createElement('img');
      img.className = 'tuto-image';
      img.src = step.src;
      img.alt = step.alt;
      // Taille réelle : place réservée (pas de saut), jamais agrandie au-delà.
      img.width = IMAGE_WIDTH;
      img.height = IMAGE_HEIGHT;
      img.loading = index === 0 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      slide.append(img);
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

    /* Glissement : l'image qui arrive grandit (0,92 → 1). */
    function scaleSlides() {
      const width = track.clientWidth || 1;
      [...track.children].forEach((slide) => {
        const image = slide.firstChild;
        if (!image || !image.style) return;
        // La piste est position: relative : offsetLeft se compte depuis son bord.
        image.style.transform = reduced() ? '' : `scale(${scaleFor((slide.offsetLeft - track.scrollLeft) / width)})`;
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

  root.HaisselTuto = { CAPTIONS, STEPS, MIN_SCALE, IMAGE_WIDTH, IMAGE_HEIGHT, steps, scaleFor, mount };
}(typeof window !== 'undefined' ? window : globalThis));
