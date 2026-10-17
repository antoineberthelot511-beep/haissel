// Écran d'accueil smartphone : visible tant que l'utilisateur n'est pas connecté.
(() => {
  const splash = document.getElementById('mobile-splash');
  const authScreen = document.getElementById('auth-screen');
  if (!splash || !authScreen) return;

  let dismissed = false;
  const sync = () => {
    const show = !dismissed && !authScreen.classList.contains('hidden');
    splash.hidden = !show;
    document.body.classList.toggle('splash-open', show);
  };

  splash.querySelectorAll('[data-splash-form]').forEach((button) => {
    button.addEventListener('click', () => {
      dismissed = true;
      sync();
      const tab = document.querySelector(`.tab-button[data-form="${button.dataset.splashForm}"]`);
      if (tab) tab.click();
      authScreen.scrollIntoView({ block: 'start' });
    });
  });

  new MutationObserver(sync).observe(authScreen, { attributes: true, attributeFilter: ['class'] });
  sync();
})();
