/*
 * Écran de démarrage (#boot-screen) : couvre la page jusqu'au premier rendu
 * de l'Accueil, ou jusqu'à ce que la page de connexion soit prête.
 *
 *  - app.js appelle HaisselBoot.ready() quand l'écran peut partir ;
 *  - au bout de 10 s sans signal, le loader laisse place à « Connexion
 *    lente… » et à un bouton « Réessayer » qui recharge la page : l'écran ne
 *    reste jamais bloqué sans issue.
 *
 * Chargé juste après le <div id="boot-screen">, sans attendre le reste.
 */
(() => {
  const FADE_MS = 200;
  const SLOW_MS = 10000;
  // Durée minimale d'affichage, au premier chargement de la page seulement.
  const MIN_MS = 600;

  function create({ doc, timers = { setTimeout, clearTimeout }, now = Date.now, reload }) {
    const screen = doc.getElementById('boot-screen');
    const startedAt = now();
    let done = false;

    const slowTimer = timers.setTimeout(() => {
      if (done || !screen) return;
      const text = doc.createElement('p');
      text.className = 'boot-slow-text';
      text.textContent = 'Connexion lente…';
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'primary-button boot-retry';
      button.textContent = 'Réessayer';
      button.addEventListener('click', () => reload());
      const box = doc.createElement('div');
      box.className = 'boot-slow';
      box.setAttribute('role', 'alert');
      box.append(text, button);
      screen.replaceChildren(box);
    }, SLOW_MS);

    function ready() {
      if (done) return;
      done = true;
      timers.clearTimeout(slowTimer);
      if (!screen) return;
      const wait = Math.max(0, MIN_MS - (now() - startedAt));
      timers.setTimeout(() => {
        screen.classList.add('is-leaving');
        timers.setTimeout(() => screen.remove(), FADE_MS);
      }, wait);
    }

    return { ready };
  }

  const api = { create };
  if (typeof document !== 'undefined' && document.getElementById) {
    Object.assign(api, create({ doc: document, reload: () => window.location.reload() }));
  }
  window.HaisselBoot = api;
})();
