/*
 * Feuille « Comment faire ? » (installer HAISSEL sur iPhone) : carrousel de
 * 5 étapes au plus, une image et une légende par étape. Les images gardent
 * leur taille réelle (jamais agrandies : pas de flou).
 *
 * Légendes : à modifier ici seulement (aussi lues par scripts/tuto-build.js
 * pour les images provisoires). Images : npm run tuto:build, qui écrit
 * frontend/images/tuto-ios/ et la liste des fichiers disponibles
 * (steps.js, window.HaisselTutoFiles). Seules ces étapes sont affichées.
 */
(function attach(root) {
  const CAPTIONS = [
    'Touche le bouton ≡ à gauche de l’adresse',
    'Choisis « Partager »',
    'Touche « En voir plus »',
    'Choisis « Sur l’écran d’accueil »',
    'Active « Ouvrir comme app web », puis touche « Ajouter »',
  ];
  const MAX_STEPS = 5;
  const IMAGE_DIR = '/images/tuto-ios/';

  const size = (value, fallback) => (Number.isInteger(value) && value > 0 && value <= 2000 ? value : fallback);

  /**
   * Étapes affichables : celles dont l'image existe, dans l'ordre, 5 au plus.
   * files : { 1: { file, width, height } } (steps.js, généré avec les tailles réelles).
   */
  function availableSteps(files = {}, captions = CAPTIONS) {
    return captions.slice(0, MAX_STEPS)
      .map((caption, index) => {
        const entry = files[index + 1];
        const file = typeof entry === 'string' ? entry : entry && entry.file;
        return { number: index + 1, caption, file, width: size(entry && entry.width, 600), height: size(entry && entry.height, 1300) };
      })
      .filter((step) => typeof step.file === 'string' && /^etape-[1-5]\.(webp|svg)$/.test(step.file))
      .map((step) => ({ ...step, src: IMAGE_DIR + step.file, alt: `Étape ${step.number} : ${step.caption}` }));
  }

  /*
   * Carrousel (DOM) : balayage horizontal natif (scroll-snap), points de
   * pagination, « Suivant » puis « C'est parti » sur la dernière étape.
   */
  function mount({ track, dots, next, onDone }) {
    const steps = availableSteps(root.HaisselTutoFiles || {});
    const doc = track.ownerDocument;
    let current = 0;

    track.replaceChildren(...steps.map((step) => {
      const figure = doc.createElement('figure');
      figure.className = 'tuto-slide';
      figure.setAttribute('aria-roledescription', 'étape');
      figure.setAttribute('aria-label', `${step.number} sur ${steps.length}`);
      const img = doc.createElement('img');
      img.className = 'tuto-image';
      img.src = step.src;
      img.alt = step.alt;
      img.loading = 'lazy';
      img.decoding = 'async';
      // Taille réelle : réserve la place (pas de saut) et sert de limite d'affichage.
      img.width = step.width;
      img.height = step.height;
      const caption = doc.createElement('figcaption');
      caption.className = 'tuto-caption';
      caption.textContent = step.caption;
      figure.append(img, caption);
      return figure;
    }));

    dots.replaceChildren(...steps.map((step, index) => {
      const dot = doc.createElement('button');
      dot.type = 'button';
      dot.className = 'tuto-dot';
      dot.setAttribute('aria-label', `Étape ${step.number}`);
      dot.addEventListener('click', () => goTo(index));
      return dot;
    }));
    dots.hidden = steps.length < 2;

    function paint() {
      [...dots.children].forEach((dot, index) => {
        if (index === current) dot.setAttribute('aria-current', 'step');
        else dot.removeAttribute('aria-current');
      });
      next.textContent = current >= steps.length - 1 ? 'C’est parti' : 'Suivant';
    }

    function goTo(index, { smooth = true } = {}) {
      current = Math.max(0, Math.min(steps.length - 1, index));
      const slide = track.children[current];
      if (slide) track.scrollTo({ left: slide.offsetLeft - track.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
      paint();
    }

    // Balayage au doigt : l'étape visible suit le défilement.
    let pending = false;
    track.addEventListener('scroll', () => {
      if (pending) return;
      pending = true;
      root.requestAnimationFrame(() => {
        pending = false;
        const width = track.clientWidth || 1;
        const index = Math.round(track.scrollLeft / width);
        if (index !== current) { current = Math.max(0, Math.min(steps.length - 1, index)); paint(); }
      });
    }, { passive: true });

    next.addEventListener('click', () => {
      if (current >= steps.length - 1) onDone();
      else goTo(current + 1);
    });

    paint();
    return { reset: () => goTo(0, { smooth: false }), count: steps.length };
  }

  root.HaisselTuto = { CAPTIONS, MAX_STEPS, availableSteps, mount };
}(typeof window !== 'undefined' ? window : globalThis));
