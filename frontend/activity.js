/*
 * Logique pure de la page « Activité » et du réglage des notifications, sans
 * DOM : testée par tests/activity-client.test.js, utilisée par app.js.
 *
 * - deviceSupport : quel texte et quel interrupteur montrer (Notification
 *   disponible, iPhone hors écran d'accueil, navigateur sans support) ;
 * - sectionOf / relativeTime : « Aujourd’hui », « Cette semaine », « Plus ancien »
 *   et « il y a 2 h » ;
 * - describe : icône et phrase courte de chaque type d'événement (types
 *   fournis par GET /api/messages/activity, aucun autre) ;
 * - unreadCount : éléments plus récents que la dernière visite.
 */
(function attach(root) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Sans visite enregistrée sur cet appareil : seules les dernières 24 h comptent comme nouvelles.
  const FIRST_VISIT_WINDOW_MS = DAY_MS;

  function isAppleMobile({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
    // iPadOS se présente comme un Mac : on le reconnaît à l'écran tactile.
    return /iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  }

  /**
   * 'available'   : l'API existe (interrupteur actif, permission au clic) ;
   * 'ios-install' : iPhone/iPad dans le navigateur, pas depuis l'écran d'accueil ;
   * 'unsupported' : tout le reste.
   */
  function deviceSupport(env = {}) {
    if (env.hasNotification && env.isSecureContext !== false) return 'available';
    if (isAppleMobile(env) && !env.standalone && !env.displayModeStandalone) return 'ios-install';
    return 'unsupported';
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function sectionOf(value, now = new Date()) {
    const date = new Date(value);
    const today = startOfDay(now);
    if (date >= today) return 'today';
    if (date >= new Date(today.getTime() - 6 * DAY_MS)) return 'week';
    return 'older';
  }

  const SECTIONS = [
    ['today', 'Aujourd’hui'],
    ['week', 'Cette semaine'],
    ['older', 'Plus ancien'],
  ];

  function groupBySection(items, now = new Date()) {
    return SECTIONS
      .map(([key, label]) => ({ key, label, items: items.filter((item) => sectionOf(item.at, now) === key) }))
      .filter((section) => section.items.length);
  }

  function relativeTime(value, now = new Date()) {
    const minutes = Math.floor((now.getTime() - new Date(value).getTime()) / 60000);
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 1) return 'à l’instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `il y a ${days} j`;
    return `il y a ${Math.floor(days / 7)} sem.`;
  }

  /** Icône (symbole du sprite), ton de la pastille, phrase. Texte brut : affiché via textContent. */
  function describe(item) {
    const title = item.title || 'ta fiche';
    switch (item.type) {
      case 'offer_published':
        return { icon: 'i-check-circle', tone: 'ok', text: `Ta fiche « ${title} » est validée : elle est visible 24 h.` };
      case 'offer_rejected':
        return { icon: 'i-alert', tone: 'bad', text: `Ta fiche « ${title} » n’a pas été validée.` };
      case 'offer_removed':
        return { icon: 'i-trash', tone: 'bad', text: `Ta fiche « ${title} » a été retirée par l’équipe.` };
      case 'story_extended':
        return { icon: 'i-clock', tone: 'ok', text: `L’équipe a prolongé ta story « ${title} » de 24 h.` };
      case 'story_expired':
        return { icon: 'i-clock', tone: 'muted', text: `Ta story « ${title} » a expiré. Tu peux la republier.` };
      case 'team_message':
        return { icon: 'i-send', tone: 'info', text: `L’équipe Haissel t’a répondu : « ${item.detail || ''} »` };
      case 'announcement':
        return { icon: 'i-bell', tone: 'info', text: item.detail ? `${item.title} : ${item.detail}` : String(item.title || '') };
      default:
        return null;
    }
  }

  function isUnread(item, seenAt, now = new Date()) {
    const at = new Date(item.at).getTime();
    const since = seenAt ? new Date(seenAt).getTime() : now.getTime() - FIRST_VISIT_WINDOW_MS;
    return at > since;
  }

  function unreadCount(items, seenAt, now = new Date()) {
    return items.filter((item) => describe(item) && isUnread(item, seenAt, now)).length;
  }

  /*
   * Date de la dernière ouverture d'Activité sur cet appareil, par compte.
   * Seule donnée gardée localement (aucun jeton) ; sans stockage, tout
   * fonctionne, avec la règle « dernières 24 h ».
   */
  const SEEN_PREFIX = 'haissel.activity.seen.';

  function readSeen(userId, storage = root.localStorage) {
    try { return storage ? storage.getItem(SEEN_PREFIX + userId) : null; } catch (error) { return null; }
  }

  function markSeen(userId, latestAt, storage = root.localStorage, now = new Date()) {
    const value = latestAt && latestAt > now.toISOString() ? latestAt : now.toISOString();
    try { if (storage) storage.setItem(SEEN_PREFIX + userId, value); } catch (error) { /* stockage bloqué : sans conséquence */ }
    return value;
  }

  root.HaisselActivity = {
    readSeen, markSeen, SEEN_PREFIX,
    isAppleMobile, deviceSupport, sectionOf, groupBySection, relativeTime, describe, isUnread, unreadCount, SECTIONS,
  };
}(typeof window !== 'undefined' ? window : globalThis));
