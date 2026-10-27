'use strict';

/*
 * Notifications temps réel de l'espace utilisateur HAISSEL.
 *
 * DEUX CANAUX, choisis par options.mode (valeur realtime_mode de
 * /api/auth/config) :
 *  - « sse » (défaut, npm start et Docker) : flux Server-Sent Events
 *    /api/notifications/stream, authentifié par le cookie de session
 *    HttpOnly (aucun jeton manipulé ici), reconnexion à délai exponentiel ;
 *  - « poll » (Vercel) : interrogation de /api/notifications/poll toutes les
 *    45 s, uniquement quand l'onglet est visible. Un flux permanent est
 *    impossible là-bas : plusieurs instances répondent sans mémoire partagée,
 *    donc l'instance qui tient le flux n'est pas celle qui reçoit la diffusion.
 *
 * L'affichage, la déduplication et les accusés sont communs aux deux canaux.
 * - Reconnexion avec délai exponentiel et nombre de tentatives limité.
 * - Notifications système uniquement après un clic explicite sur
 *   l'interrupteur de Profil › Réglages (app.js) ; la permission n'est jamais
 *   demandée automatiquement et un refus est respecté.
 * - Aucun texte technique dans la page du membre : l'état du canal est
 *   seulement exposé par status() (débogage), jamais affiché.
 * - Le contenu reçu est du texte brut, inséré via textContent : il n'est
 *   jamais interprété comme du HTML ni exécuté.
 */
window.createNotificationCenter = function createNotificationCenter(options) {
  const STREAM_URL = '/api/notifications/stream';
  const POLL_URL = '/api/notifications/poll';
  const POLL_INTERVAL_MS = 45000;
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
  };
  // État interne, lisible par status() pour le débogage ; jamais affiché au membre.
  const debug = { channel: 'Hors ligne', canRetry: false, lastResult: '', lastError: false };

  let source = null;
  let running = false;
  let attempts = 0;
  let retryTimer = null;
  let pollTimer = null;
  // null = curseur pas encore établi : le premier appel ne rapporte aucun
  // élément, il fixe seulement le point de départ (pas d'historique d'un coup).
  let pollCursor = null;
  let lastSystemAt = 0;
  const seen = new Set();
  const pendingAcks = new Map(); // id -> affiché dans un onglet masqué, accusé au retour

  // -------------------------------------------------------------------------
  // Statuts affichés
  // -------------------------------------------------------------------------

  /* Lu à l'appel : /api/auth/config est chargé après la construction. */
  function currentMode() {
    const value = typeof options.mode === 'function' ? options.mode() : options.mode;
    return value === 'poll' ? 'poll' : 'sse';
  }

  function setRealtimeStatus(text, { canRetry = false } = {}) {
    debug.channel = text;
    debug.canRetry = canRetry;
  }

  function supportsSystemNotifications() {
    return 'Notification' in window;
  }

  function systemNotificationsAllowed() {
    return supportsSystemNotifications() && window.isSecureContext && Notification.permission === 'granted';
  }

  function setLastResult(text, isError = false) {
    debug.lastResult = text;
    debug.lastError = isError;
  }

  /** 'granted' | 'denied' | 'default' | 'unsupported' (API absente ou connexion non sécurisée). */
  function permission() {
    if (!supportsSystemNotifications() || !window.isSecureContext) return 'unsupported';
    return Notification.permission;
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

  /** Appelé UNIQUEMENT depuis un clic de l'utilisateur. Renvoie la permission obtenue. */
  async function enableSystemNotifications() {
    if (permission() === 'unsupported') return 'unsupported';
    if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      try {
        await Notification.requestPermission();
      } catch (error) {
        setLastResult(`La demande d’autorisation a échoué : ${error.message || error}`, true);
      }
    }
    if (Notification.permission === 'granted') ensureServiceWorker();
    return permission();
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
    card.className = 'notif-card lg-glass lg-pill';
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
    // La page « Activité » et la pastille de la cloche se mettent à jour.
    if (typeof options.onNotification === 'function') options.onNotification(notification);

    if (!systemNotificationsAllowed()) {
      if (supportsSystemNotifications() && !window.isSecureContext) {
        setLastResult('Message reçu, affiché dans la page : notification système impossible sur une connexion non sécurisée.', true);
      }
      fallbackInApp(notification);
      return;
    }
    // Anti-spam : rafale trop rapprochée -> affichage dans la page.
    if (Date.now() - lastSystemAt < SYSTEM_MIN_INTERVAL_MS) {
      fallbackInApp(notification);
      return;
    }

    // Autorisée : vraie notification système, dans un seul onglet (verrou +
    // tag commun). Pas d'encadré dans la page en plus : pas de doublon.
    inSingleTab(notification.id, async () => {
      lastSystemAt = Date.now();
      try {
        const result = await showSystem(notification);
        if (result === 'shown') {
          setLastResult(`Notification système « ${notification.title} » transmise à ${timeNow()} (affichage confirmé par le navigateur).`);
          acknowledge(notification.id, 'system');
        } else {
          setLastResult(`Notification transmise au système à ${timeNow()}, mais le navigateur n’a pas confirmé l’affichage.`, true);
        }
      } catch (error) {
        setLastResult(`Échec de la notification système : ${error.message}. Message affiché dans la page à la place.`, true);
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

  // -------------------------------------------------------------------------
  // Interrogation régulière (Vercel)
  // -------------------------------------------------------------------------

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  /*
   * Pas de nouvel appel quand l'onglet est masqué : inutile, puisque les
   * notifications système sont de toute façon affichées au retour, et cela
   * évite des requêtes en continu sur des onglets oubliés.
   */
  function schedulePoll() {
    stopPolling();
    if (!running) return;
    if (document.visibilityState !== 'visible') {
      setRealtimeStatus('En pause : onglet en arrière-plan');
      return;
    }
    pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }

  async function pollOnce() {
    if (!running) return;
    // Premier appel sans « since » : fixe le curseur sans rien afficher.
    const query = pollCursor === null ? '' : `?since=${encodeURIComponent(pollCursor)}`;

    let data;
    try {
      data = await options.get(`${POLL_URL}${query}`);
    } catch (error) {
      if (error && error.status === 401) {
        stop();
        options.onSessionEnded();
        return;
      }
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        setRealtimeStatus('Hors ligne', { canRetry: true });
        return;
      }
      setRealtimeStatus(`Actualisation impossible, nouvel essai dans ${Math.round(POLL_INTERVAL_MS / 1000)} s`);
      schedulePoll();
      return;
    }

    attempts = 0;
    if (typeof data.cursor === 'number') pollCursor = data.cursor;
    setRealtimeStatus(`Connecté · actualisation toutes les ${Math.round(POLL_INTERVAL_MS / 1000)} s`);

    // Même traitement que les événements SSE : handleNotification applique la
    // validation, la déduplication, la permission et l'accusé d'affichage.
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      await handleNotification(JSON.stringify(item));
    }

    schedulePoll();
  }

  function startPolling() {
    pollCursor = null;
    setRealtimeStatus('Connexion…');
    pollOnce();
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  function retryNow() {
    if (!running) return;
    attempts = 0;
    if (currentMode() === 'poll') {
      pollOnce();
      return;
    }
    connect();
  }

  function start() {
    if (running) return;
    running = true;
    attempts = 0;
    if (currentMode() === 'poll') startPolling(); else connect();
  }

  function stop() {
    running = false;
    clearTimeout(retryTimer);
    stopPolling();
    pollCursor = null;
    closeSource();
    setRealtimeStatus('Hors ligne');
    el.stack.replaceChildren();
    pendingAcks.clear();
  }

  window.addEventListener('online', () => { if (running && !source) retryNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      // Onglet masqué : la boucle d'interrogation s'arrête là.
      if (running && currentMode() === 'poll') schedulePoll();
      return;
    }
    // Notifications reçues pendant l'absence et désormais visibles dans la page.
    for (const id of [...pendingAcks.keys()]) acknowledge(id, 'in_app');
    // Retour sur l'onglet : on rattrape immédiatement, sans attendre 45 s.
    if (running && currentMode() === 'poll') pollOnce();
  });

  // Permission déjà accordée lors d'une visite précédente : prépare le secours.
  if (systemNotificationsAllowed()) ensureServiceWorker();
  return { start, stop, retryNow, enableSystemNotifications, permission, status: () => ({ ...debug }) };
};
