/*
 * Pages légales : « ‹ Retour » revient à la page précédente quand elle est sur
 * HAISSEL (l'app, une autre page légale) ; sinon le lien mène à /app.
 * Fichier séparé : la CSP interdit les scripts en ligne.
 */
(() => {
  const back = document.querySelector('[data-legal-back]');
  if (!back) return;
  back.addEventListener('click', (event) => {
    let sameOrigin = false;
    try { sameOrigin = Boolean(document.referrer) && new URL(document.referrer).origin === window.location.origin; } catch (error) { sameOrigin = false; }
    if (sameOrigin && window.history.length > 1) {
      event.preventDefault();
      window.history.back();
    }
  });
})();
