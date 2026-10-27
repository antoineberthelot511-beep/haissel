'use strict';

/*
 * Service worker HAISSEL (scope « / ») : UNIQUEMENT les notifications.
 *  - push : affiche la notification envoyée par le serveur (Web Push) ;
 *  - notificationclick : ramène sur HAISSEL, à un lien interne.
 * Aucune mise en cache, aucune interception réseau (pas de « fetch ») :
 * chaque déploiement est visible immédiatement.
 */

// Même liste blanche que le serveur : liens internes uniquement.
const ALLOWED_URL = /^\/(?:app|admin|mes-affilies|go\/\d{1,10})?(?:#[A-Za-z0-9_-]{1,40})?$/;

function internalUrl(raw) {
  return typeof raw === 'string' && ALLOWED_URL.test(raw) ? raw : '/app';
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 60) : 'HAISSEL';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body.slice(0, 120) : '',
    tag: typeof data.tag === 'string' ? data.tag.slice(0, 40) : 'haissel',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: internalUrl(data.url) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(internalUrl(event.notification.data && event.notification.data.url), self.location.origin);

  event.waitUntil((async () => {
    if (target.origin !== self.location.origin) return undefined;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      return open.navigate ? open.navigate(target.href) : undefined;
    }
    return self.clients.openWindow(target.href);
  })());
});
