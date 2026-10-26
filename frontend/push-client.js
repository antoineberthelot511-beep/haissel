/*
 * Abonnement Web Push de cet appareil, sans DOM : testé par
 * tests/push-client.test.js, utilisé par app.js (Profil › Réglages).
 *
 * - enable : appelé UNIQUEMENT au toucher de l'interrupteur (permission,
 *   service worker, pushManager.subscribe, POST /api/push/subscribe) ;
 * - disable : désabonne l'appareil puis DELETE /api/push/subscribe ;
 * - sync : au chargement, renvoie l'abonnement existant au serveur, sans
 *   jamais demander la permission.
 * Les dépendances (navigator, Notification, api) sont injectées.
 */
(function attach(root) {
  function urlBase64ToUint8Array(value) {
    const base64 = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
    const raw = root.atob(base64);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }

  /** Lien d'une notification (« /app#messages ») → vue de l'application. */
  function viewFromHash(hash) {
    const name = String(hash || '').replace(/^#/, '');
    return ['messages', 'profile', 'notifications', 'home', 'discover'].includes(name) ? name : null;
  }

  function subscriptionBody(subscription) {
    const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
    return { endpoint: json.endpoint, keys: { p256dh: json.keys && json.keys.p256dh, auth: json.keys && json.keys.auth } };
  }

  function canPush(nav) {
    return Boolean(nav && nav.serviceWorker && root.PushManager);
  }

  async function registration(nav) {
    await nav.serviceWorker.register('/sw.js', { scope: '/' });
    return nav.serviceWorker.ready;
  }

  /** 'subscribed' | 'denied' | 'default' | 'unsupported' | 'error'. */
  async function enable({ nav, Notif, api, publicKey }) {
    if (!canPush(nav) || !Notif || !publicKey) return 'unsupported';
    let permission = Notif.permission;
    if (permission === 'default') permission = await Notif.requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'default';
    try {
      const reg = await registration(nav);
      const existing = await reg.pushManager.getSubscription();
      const subscription = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api('/api/push/subscribe', { method: 'POST', body: subscriptionBody(subscription) });
      return 'subscribed';
    } catch (error) {
      return 'error';
    }
  }

  async function disable({ nav, api }) {
    if (!canPush(nav)) return 'unsupported';
    const reg = await nav.serviceWorker.getRegistration('/');
    const subscription = reg && await reg.pushManager.getSubscription();
    if (!subscription) return 'off';
    const { endpoint } = subscriptionBody(subscription);
    try { await subscription.unsubscribe(); } catch (error) { /* déjà retiré */ }
    try { await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint } }); } catch (error) { /* le serveur le retirera au prochain 410 */ }
    return 'off';
  }

  /** Abonnement présent sur l'appareil ? (sans aucune demande). */
  async function current(nav) {
    if (!canPush(nav)) return null;
    try {
      const reg = await nav.serviceWorker.getRegistration('/');
      return reg ? await reg.pushManager.getSubscription() : null;
    } catch (error) {
      return null;
    }
  }

  async function sync({ nav, Notif, api }) {
    if (!Notif || Notif.permission !== 'granted') return false;
    const subscription = await current(nav);
    if (!subscription) return false;
    try {
      await api('/api/push/subscribe', { method: 'POST', body: subscriptionBody(subscription) });
      return true;
    } catch (error) {
      return false;
    }
  }

  root.HaisselPush = { urlBase64ToUint8Array, viewFromHash, subscriptionBody, canPush, enable, disable, current, sync };
}(typeof window !== 'undefined' ? window : globalThis));
