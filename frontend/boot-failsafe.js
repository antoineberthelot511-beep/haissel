/*
 * Secours de l'écran de démarrage : si boot.js n'a pas pu s'exécuter
 * (window.HaisselBoot absent), #boot-screen est retiré dès le chargement de
 * la page. Fichier séparé : la CSP interdit les scripts en ligne.
 */
window.addEventListener('load', () => {
  if (window.HaisselBoot) return;
  const screen = document.getElementById('boot-screen');
  if (screen) screen.remove();
});
