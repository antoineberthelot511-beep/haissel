/*
 * Écran d'accueil smartphone : visible tant que l'utilisateur n'est pas
 * connecté. Deux sortes d'actions, déclarées dans le HTML :
 *
 *  - data-splash-form="login|register" : masque l'écran et ouvre l'onglet
 *    correspondant du formulaire d'authentification ;
 *  - data-splash-scroll="<id>" : masque l'écran et amène à cette section.
 *
 * Les positions ne sont plus calculées : ce sont de vrais boutons dans le flux.
 */
(() => {
  const splash = document.getElementById('mobile-splash');
  const authScreen = document.getElementById('auth-screen');
  if (!splash || !authScreen) return;

  /*
   * L'écran ne couvre la page que sous 760 px (mobile-splash.css). Le reste du
   * code doit connaître cette condition : il rend le contenu de dessous inerte,
   * ce qu'une règle CSS ne peut pas faire, et l'appliquer sur grand écran
   * neutraliserait le clavier sur tout le site.
   */
  const narrow = window.matchMedia('(max-width: 760px)');

  // Contenu situé derrière l'écran (enfants directs de <body>).
  const behind = ['.skip-link', '.app-shell']
    .map((selector) => document.querySelector(selector))
    .filter(Boolean);

  let dismissed = false;
  let wasOpen = false;

  const sync = () => {
    const open = !dismissed && !authScreen.classList.contains('hidden') && narrow.matches;
    splash.hidden = !open;
    document.body.classList.toggle('splash-open', open);
    /*
     * « inert » retire la page de dessous de l'ordre de tabulation et de
     * l'arbre d'accessibilité : sans cela, la première tabulation atteignait
     * « Aller au contenu » et le formulaire masqués sous l'écran, ce que
     * aria-modal annonce pourtant comme impossible.
     *
     * Via HaisselInert : la question de majorité couvre la même zone, et
     * chacun doit pouvoir la relâcher sans annuler l'autre.
     */
    for (const element of behind) window.HaisselInert.set(element, 'splash', open);

    // À l'ouverture, le focus entre dans l'écran : le lecteur d'écran annonce
    // le titre, puis la tabulation atteint « Créer un compte ».
    if (open && !wasOpen) splash.focus({ preventScroll: true });
    wasOpen = open;
  };

  const dismiss = () => {
    dismissed = true;
    sync();
  };

  splash.querySelectorAll('[data-splash-form]').forEach((button) => {
    button.addEventListener('click', () => {
      dismiss();
      const tab = document.querySelector(`.tab-button[data-form="${button.dataset.splashForm}"]`);
      if (tab) tab.click();
      authScreen.scrollIntoView({ block: 'start' });
    });
  });

  /*
   * « En savoir plus » : mène à la présentation publique du site (ce que
   * HAISSEL contient, les trois étapes, la confidentialité). L'onglet
   * « Apprendre » n'est pas une destination possible ici : il vit dans
   * #app-screen, masqué hors session, et /api/learn/* exige une session —
   * or cet écran ne s'affiche justement que lorsqu'on n'est pas connecté.
   */
  splash.querySelectorAll('[data-splash-scroll]').forEach((button) => {
    button.addEventListener('click', () => {
      dismiss();
      const target = document.getElementById(button.dataset.splashScroll);
      (target || authScreen).scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  });

  new MutationObserver(sync).observe(authScreen, { attributes: true, attributeFilter: ['class'] });
  // Rotation ou redimensionnement : l'écran apparaît ou disparaît.
  narrow.addEventListener('change', sync);
  sync();
})();
