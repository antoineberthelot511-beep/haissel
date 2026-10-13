'use strict';

/*
 * Notifications temps réel de l'espace utilisateur HAISSEL.
 *
 * - Flux Server-Sent Events /api/notifications/stream, authentifié par le
 *   cookie de session HttpOnly (aucun jeton manipulé ici).
 * - Reconnexion avec délai exponentiel et nombre de tentatives limité.
 * - Notifications système uniquement après un clic explicite sur
 *   « Activer les notifications » ; la permission n'est jamais demandée
 *   automatiquement et un refus est respecté.
 * - Le contenu reçu est du texte brut, inséré via textContent : il n'est
 *   jamais interprété comme du HTML ni exécuté.
 */
window.createNotificationCenter = function createNotificationCenter(options) {
  const STREAM_URL = '/api/notifications/stream';
  const MAX_ATTEMPTS = 8;
  const BASE_DELAY_MS = 2000;
  const MAX_DELAY_MS = 60000;
  const SYSTEM_MIN_INTERVAL_MS = 3000;
  const IN_APP_DURATION_MS = 15000;
  const MAX_IN_APP = 3;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Même liste blanche que le serveur : liens internes uniquement.
  const ALLOWED_URL = /^\/(?:app|mes-affilies|go\/\d{1,10})?(?:#[A-Za-z0-9_-]{1,40})?$/;

  const el = {
    stack: document.getElementById('notif-stack'),
    realtime: document.getElementById('realtime-status'),
    permission: document.getElementById('notif-permission-status'),
    help: document.getElementById('notif-permission-help'),
    enable: document.getElementById('notif-enable'),
    enableTop: document.getElementById('notif-enable-top'),
    retry: document.getElementById('realtime-retry'),
    test: document.getElementById('notif-test'),
    result: document.getElementById('notif-last-result'),
    diagnostic: document.getElementById('notif-diagnostic'),
  };

  let source = null;
  let running = false;
  let attempts = 0;
  let retryTimer = null;
  let lastSystemAt = 0;
  const seen = new Set();
  const pendingAcks = new Map(); // id -> affiché dans un onglet masqué, accusé au retour

  // -------------------------------------------------------------------------
  // Statuts affichés
  // -------------------------------------------------------------------------

  function setRealtimeStatus(text, { canRetry = false } = {}) {
    el.realtime.textContent = text;
    el.retry.classList.toggle('hidden', !canRetry);
  }

  function supportsSystemNotifications() {
    return 'Notification' in window;
  }

  function systemNotificationsAllowed() {
    return supportsSystemNotifications() && window.isSecureContext && Notification.permission === 'granted';
  }

  function setLastResult(text, isError = false) {
    el.result.textContent = text;
    el.result.classList.toggle('notif-error', isError);
  }

  function renderPermission() {
    let status;
    let help = '';
    let canAsk = false;

    if (!supportsSystemNotifications()) {
      status = 'Non prises en charge';
      help = 'Ce navigateur ne gère pas les notifications système. Les messages s’affichent seulement dans la page.';
    } else if (!window.isSecureContext) {
      status = 'Indisponibles : HTTPS requis';
      help = `Le navigateur bloque les notifications Windows sur ${window.location.origin} (connexion non sécurisée). `
        + 'Ouvrez Haissel via son adresse https:// (voir l’administrateur). Les messages s’affichent dans la page en attendant.';
    } else if (Notification.permission === 'granted') {
      status = 'Autorisées';
      help = 'Pour les désactiver : icône à gauche de l’adresse du site › Notifications › Bloquer. '
        + 'Si rien n’apparaît, vérifiez aussi Windows : Paramètres › Système › Notifications (navigateur autorisé, mode « Ne pas déranger » désactivé).';
    } else if (Notification.permission === 'denied') {
      status = 'Refusées';
      help = 'Vous avez refusé les notifications. Pour changer d’avis : icône à gauche de l’adresse du site › Notifications › Autoriser, puis rechargez la page.';
    } else {
      status = 'Non configurées';
      canAsk = true;
    }

    el.permission.textContent = status;
    el.help.textContent = help;
    el.diagnostic.textContent = `Adresse : ${window.location.origin} · contexte sécurisé pour le navigateur : `
      + `${window.isSecureContext ? 'oui' : 'non'} · autorisation : `
      + `${supportsSystemNotifications() ? Notification.permission : 'API absente'}`;
    el.enable.disabled = !canAsk;
    el.enable.textContent = canAsk ? 'Activer les notifications Windows' : `Notifications Windows : ${status.toLowerCase()}`;
    el.enableTop.classList.toggle('hidden', !running || !canAsk);
    el.test.classList.toggle('hidden', !systemNotificationsAllowed());
  }

  /**
   * Service worker (secours de new Notification, ex. navigateurs où le
   * constructeur est interdit). Enregistré seulement une fois la permission
   * accordée ; l'enregistrement ne déclenche aucune demande.
   */
  let swRegistration = null;
  async function ensureServiceWorker() {
    if (swRegistration) return swRegistration;
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      swRegistration = await navigator.serviceWorker.ready;
    } catch (error) {
      swRegistration = null;
    }
    return swRegistration;
  }

  /** Appelé UNIQUEMENT depuis un clic de l'utilisateur. */
  async function enableSystemNotifications() {
    if (!supportsSystemNotifications() || !window.isSecureContext) {
      renderPermission();
      return;
    }
    if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      try {
        await Notification.requestPermission();
      } catch (error) {
        setLastResult(`La demande d’autorisation a échoué : ${error.message || error}`, true);
      }
    }
    renderPermission();
    if (Notification.permission === 'granted') ensureServiceWorker();
  }

  /**
   * Bouton « Tester » : crée une VRAIE notification système (jamais un
   * élément de la page) et rend compte du résultat réel.
   */
  async function testSystemNotification() {
    if (!systemNotificationsAllowed()) {
      renderPermission();
      setLastResult('Test impossible : les notifications Windows ne sont pas autorisées pour ce site.', true);
      return;
    }
    setLastResult('Test en cours…');
    try {
      const result = await showSystem({
        id: `test-${Date.now()}`,
        title: 'HAISSEL — Test de notification',
        message: 'Les notifications système fonctionnent correctement.',
        url: null,
      });
      setLastResult(result === 'shown'
        ? `Test ${timeNow()} : Chrome a transmis la notification à Windows. Si aucune bulle n’apparaît en bas à droite de l’écran, `
          + 'les notifications sont masquées par Windows (Paramètres › Système › Notifications, ou « Ne pas déranger »).'
        : `Test ${timeNow()} : notification créée, mais Chrome n’a pas confirmé son affichage. Vérifiez les paramètres de notification de Windows.`,
      result !== 'shown');
    } catch (error) {
      setLastResult(`Test ${timeNow()} : échec, aucune notification n’a été créée (${error.message}).`, true);
    }
  }

  // -------------------------------------------------------------------------
  // Affichage
  // -------------------------------------------------------------------------

  function parseEvent(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (error) { return null; }
    if (!data || typeof data !== 'object') return null;
    if (typeof data.id !== 'string' || !UUID.test(data.id)) return null;
    if (typeof data.title !== 'string' || typeof data.message !== 'string') return null;
    return {
      id: data.id,
      title: data.title.slice(0, 80),
      message: data.message.slice(0, 500),
      url: typeof data.url === 'string' && ALLOWED_URL.test(data.url) ? data.url : null,
      sentAt: typeof data.sent_at === 'string' ? data.sent_at : null,
    };
  }

  function acknowledge(id, mode) {
    pendingAcks.delete(id);
    options.post(`/api/notifications/${id}/ack`, { mode }).catch(() => { /* non bloquant */ });
  }

  function showInApp(notification) {
    while (el.stack.children.length >= MAX_IN_APP) el.stack.firstElementChild.remove();

    const card = document.createElement('article');
    card.className = 'notif-card';
    const title = document.createElement('strong');
    title.className = 'notif-card-title';
    title.textContent = notification.title;
    const message = document.createElement('p');
    message.className = 'notif-card-message';
    message.textContent = notification.message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'notif-card-close';
    close.setAttribute('aria-label', 'Fermer la notification');
    close.textContent = '×';
    close.addEventListener('click', () => card.remove());
    const origin = document.createElement('span');
    origin.className = 'notif-card-origin';
    origin.textContent = 'Message HAISSEL (dans la page)';
    card.append(close, origin, title, message);

    if (notification.url) {
      const link = document.createElement('a');
      link.href = notification.url;
      link.className = 'notif-card-link';
      link.textContent = 'Ouvrir';
      card.append(link);
    }
    if (notification.sentAt) {
      const time = document.createElement('time');
      time.className = 'notif-card-time';
      time.dateTime = notification.sentAt;
      time.textContent = new Date(notification.sentAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      card.append(time);
    }

    el.stack.append(card);
    setTimeout(() => card.remove(), IN_APP_DURATION_MS);
  }

  /**
   * Affiche une vraie notification système. Résout 'shown' (affichage
   * confirmé par le navigateur) ou 'sent' (transmise, non confirmée) ;
   * rejette si l'API échoue. Titre et message sont passés comme texte : le
   * système ne les interprète jamais comme du HTML.
   */
  async function showSystem(notification) {
    const options = {
      body: notification.message,
      // Même tag dans tous les onglets : le système n'affiche qu'une fois.
      tag: `haissel-${notification.id}`,
      data: { url: notification.url },
    };

    let constructorError = null;
    if (typeof window.Notification === 'function') {
      try {
        const systemNotification = new window.Notification(notification.title, options);
        systemNotification.onclick = () => {
          window.focus();
          if (notification.url) window.location.assign(notification.url);
          systemNotification.close();
        };
        return await new Promise((resolve, reject) => {
          systemNotification.onshow = () => resolve('shown');
          systemNotification.onerror = () => reject(new Error('le système a refusé l’affichage'));
          setTimeout(() => resolve('sent'), 4000);
        });
      } catch (error) {
        // Ex. « Illegal constructor » : bascule sur le service worker.
        constructorError = error;
      }
    }

    const registration = await ensureServiceWorker();
    if (registration && typeof registration.showNotification === 'function') {
      await registration.showNotification(notification.title, options);
      const visible = typeof registration.getNotifications === 'function'
        ? await registration.getNotifications({ tag: options.tag }).catch(() => [])
        : [];
      return visible.length ? 'shown' : 'sent';
    }

    throw constructorError || new Error('API de notification indisponible dans ce navigateur');
  }

  /**
   * Exécute fn dans un seul onglet (Web Locks si disponible ; sinon le tag
   * commun évite déjà les doublons côté système).
   */
  function inSingleTab(id, fn) {
    if (!navigator.locks) {
      fn();
      return;
    }
    navigator.locks.request(`haissel-notif-${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await fn();
      // Garde le verrou un instant : les autres onglets le trouvent occupé.
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
    }).catch(() => {});
  }

  function timeNow() {
    return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** Notification HAISSEL dans la page : uniquement en secours. */
  function fallbackInApp(notification) {
    showInApp(notification);
    if (document.visibilityState === 'visible') {
      acknowledge(notification.id, 'in_app');
    } else {
      pendingAcks.set(notification.id, true);
    }
  }

  async function handleNotification(raw) {
    const notification = parseEvent(raw);
    // Identifiant déjà traité (reconnexion, écouteur en double) : ignoré.
    if (!notification || seen.has(notification.id)) return;
    seen.add(notification.id);

    if (!systemNotificationsAllowed()) {
      if (supportsSystemNotifications() && !window.isSecureContext) {
        setLastResult('Message reçu, affiché dans la page : notification Windows impossible sur une connexion non sécurisée.', true);
      }
      fallbackInApp(notification);
      return;
    }
    // Anti-spam : rafale trop rapprochée -> affichage dans la page.
    if (Date.now() - lastSystemAt < SYSTEM_MIN_INTERVAL_MS) {
      fallbackInApp(notification);
      return;
    }

    // Autorisée : vraie notification Windows, dans un seul onglet (verrou +
    // tag commun). Pas d'encadré dans la page en plus : pas de doublon.
    inSingleTab(notification.id, async () => {
      lastSystemAt = Date.now();
      try {
        const result = await showSystem(notification);
        if (result === 'shown') {
          setLastResult(`Notification Windows « ${notification.title} » transmise à ${timeNow()} (affichage confirmé par le navigateur).`);
          acknowledge(notification.id, 'system');
        } else {
          setLastResult(`Notification transmise à Windows à ${timeNow()}, mais le navigateur n’a pas confirmé l’affichage.`, true);
        }
      } catch (error) {
        setLastResult(`Échec de la notification Windows : ${error.message}. Message affiché dans la page à la place.`, true);
        fallbackInApp(notification);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Connexion au flux
  // -------------------------------------------------------------------------

  function closeSource() {
    if (source) {
      source.close();
      source = null;
    }
  }

  function connect() {
    closeSource();
    clearTimeout(retryTimer);
    setRealtimeStatus(attempts ? `Reconnexion (tentative ${attempts}/${MAX_ATTEMPTS})…` : 'Connexion…');

    source = new EventSource(STREAM_URL, { withCredentials: true });
    source.addEventListener('ready', () => {
      attempts = 0;
      setRealtimeStatus('Connecté');
    });
    source.addEventListener('admin-notification', (event) => { handleNotification(event.data); });
    source.addEventListener('session-ended', (event) => {
      let reason = '';
      try { reason = JSON.parse(event.data).reason; } catch (error) { /* ignoré */ }
      closeSource();
      if (reason === 'too_many_connections') {
        setRealtimeStatus('En pause : trop d’onglets ouverts', { canRetry: true });
        return;
      }
      setRealtimeStatus('Hors ligne');
      // Après un changement de mot de passe, la session est remplacée par une
      // nouvelle (nouveau cookie) : on se reconnecte. Sinon, fin de session.
      options.checkSession().then((valid) => {
        if (!running) return;
        if (valid === false) {
          stop();
          options.onSessionEnded();
        } else {
          scheduleReconnect();
        }
      });
    });
    // Le navigateur relancerait lui-même la connexion, parfois en boucle :
    // on ferme et on gère la reconnexion avec un délai croissant.
    source.onerror = () => {
      closeSource();
      scheduleReconnect();
    };
  }

  async function scheduleReconnect() {
    if (!running) return;
    attempts += 1;
    if (attempts > MAX_ATTEMPTS) {
      setRealtimeStatus('Hors ligne', { canRetry: true });
      return;
    }
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1)) * (0.5 + Math.random() * 0.5);
    setRealtimeStatus(`Connexion perdue, nouvel essai dans ${Math.round(delay / 1000)} s`);
    retryTimer = setTimeout(async () => {
      // Session encore valide ? (un 401 déconnecte l'interface : on s'arrête)
      const valid = await options.checkSession();
      if (valid === false) {
        stop();
        options.onSessionEnded();
        return;
      }
      if (running) connect();
    }, delay);
  }

  function retryNow() {
    if (!running) return;
    attempts = 0;
    connect();
  }

  function start() {
    if (running) return;
    running = true;
    attempts = 0;
    connect();
    renderPermission();
  }

  function stop() {
    running = false;
    clearTimeout(retryTimer);
    closeSource();
    setRealtimeStatus('Hors ligne');
    el.stack.replaceChildren();
    pendingAcks.clear();
    renderPermission();
  }

  el.enable.addEventListener('click', enableSystemNotifications);
  el.enableTop.addEventListener('click', enableSystemNotifications);
  el.retry.addEventListener('click', retryNow);
  el.test.addEventListener('click', testSystemNotification);
  window.addEventListener('online', () => { if (running && !source) retryNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Notifications reçues pendant l'absence et désormais visibles dans la page.
    for (const id of [...pendingAcks.keys()]) acknowledge(id, 'in_app');
  });

  renderPermission();
  // Permission déjà accordée lors d'une visite précédente : prépare le secours.
  if (systemNotificationsAllowed()) ensureServiceWorker();
  return { start, stop, retryNow, enableSystemNotifications, testSystemNotification };
};
