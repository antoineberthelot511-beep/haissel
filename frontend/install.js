/*
 * Installation de l'application (écran d'accueil), sans DOM pour la logique :
 * testée par tests/install-client.test.js, utilisée par app.js.
 *
 * - installState : que propose la ligne « Installer l'application HAISSEL »
 *   de Profil › Réglages ;
 * - bannerVisible : la petite bannière de l'Accueil (3 jours après la
 *   première visite, jamais plus après la croix) ;
 * - capture de beforeinstallprompt (Android, Chrome, Edge) dès le
 *   chargement : l'événement n'est émis qu'une fois, il est gardé ici.
 */
(function attach(root) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BANNER_DELAY_MS = 3 * DAY_MS;

  function isAppleMobile({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
    // iPadOS se présente comme un Mac : on le reconnaît à l'écran tactile.
    return /iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  }

  // Sur iOS, seul Safari sait ajouter une app à l'écran d'accueil.
  function isIosSafari(userAgent = '') {
    return /Safari\//.test(userAgent)
      && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|YaBrowser|DuckDuckGo|Instagram|FBAN|FBAV|Line\//.test(userAgent);
  }

  /**
   * 'installed'  : déjà installée (standalone, ou appinstalled reçu) : ligne cachée ;
   * 'prompt'     : Android / Chrome / Edge, beforeinstallprompt reçu ;
   * 'ios-safari' : iPhone/iPad dans Safari : feuille « Comment faire ? » ;
   * 'ios-other'  : autre navigateur iOS : « Ouvre HAISSEL dans Safari » ;
   * 'unavailable': rien à proposer (ligne cachée).
   */
  function installState(env = {}) {
    if (env.standalone || env.displayModeStandalone || env.installed) return 'installed';
    if (isAppleMobile(env)) return isIosSafari(env.userAgent) ? 'ios-safari' : 'ios-other';
    if (env.hasPrompt) return 'prompt';
    return 'unavailable';
  }

  /** Bannière de l'Accueil : une seule fois par appareil, 3 jours après la première visite. */
  function bannerVisible({ state, firstSeenAt, dismissed = false, now = Date.now() } = {}) {
    if (dismissed || !firstSeenAt) return false;
    if (state !== 'prompt' && state !== 'ios-safari') return false;
    return now - Number(firstSeenAt) >= BANNER_DELAY_MS;
  }

  /**
   * Après l'installation, ou app ouverte depuis l'écran d'accueil : proposer
   * d'activer les notifications (permission demandée seulement au toucher).
   */
  function notifyOfferVisible({ state, pushEnabled = false, canPush = false, permission = 'default', subscribed = false, dismissed = false } = {}) {
    return state === 'installed' && pushEnabled && canPush && permission === 'default' && !subscribed && !dismissed;
  }

  const api = {
    BANNER_DELAY_MS, isIosSafari, installState, bannerVisible, notifyOfferVisible, deferred: null, installed: false,
  };

  // Capture au plus tôt : sans preventDefault, Chrome afficherait sa propre mini-barre.
  if (typeof root.addEventListener === 'function') {
    const changed = () => {
      try { root.dispatchEvent(new root.Event('haissel-install-change')); } catch (error) { /* ancien navigateur */ }
    };
    root.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      api.deferred = event;
      changed();
    });
    root.addEventListener('appinstalled', () => {
      api.deferred = null;
      api.installed = true;
      changed();
    });
  }

  root.HaisselInstall = api;
}(typeof window !== 'undefined' ? window : globalThis));
