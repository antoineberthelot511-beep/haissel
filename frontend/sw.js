'use strict';

/*
 * Service worker HAISSEL : uniquement l'affichage et le clic des
 * notifications système (secours de new Notification). Aucun cache, aucune
 * interception réseau, aucun abonnement push.
 */

// Même liste blanche que le serveur : liens internes uniquement.
const ALLOWED_URL = /^\/(?:app|mes-affilies|go\/\d{1,10})?(?:#[A-Za-z0-9_-]{1,40})?$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const target = typeof raw === 'string' && ALLOWED_URL.test(raw) ? raw : null;

  event.waitUntil((async () => {
    if (target) return self.clients.openWindow(target);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length) return windows[0].focus();
    return self.clients.openWindow('/');
  })());
});
