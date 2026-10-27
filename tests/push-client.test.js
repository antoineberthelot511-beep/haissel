/*
 * Abonnement Web Push côté navigateur (frontend/push-client.js) : permission
 * demandée seulement par enable, resynchronisation sans demande, désabonnement.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/push-client.js'), 'utf8');

function load() {
  const sandbox = { Uint8Array, atob: (s) => Buffer.from(s, 'base64').toString('binary'), PushManager: function PushManager() {} };
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.HaisselPush;
}

const P = load();
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPk', auth: 'xyz' } };

function fakeNavigator(existing = null) {
  const calls = { subscribe: 0, unsubscribe: 0 };
  let current = existing;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async () => { calls.subscribe += 1; current = { toJSON: () => SUB, unsubscribe: async () => { calls.unsubscribe += 1; current = null; } }; return current; },
  };
  const reg = { pushManager };
  return { calls, nav: { serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg } } };
}

function fakeApi() {
  const calls = [];
  const api = async (url, options) => { calls.push({ url, ...options }); return {}; };
  return { api, calls };
}

test('clé publique base64url → octets', () => {
  expect(Array.from(P.urlBase64ToUint8Array('AQID_-8'))).toEqual([1, 2, 3, 255, 239]);
});

test('lien de notification → vue', () => {
  expect(P.viewFromHash('#messages')).toBe('messages');
  expect(P.viewFromHash('#profile')).toBe('profile');
  expect(P.viewFromHash('#verify=abc')).toBeNull();
  expect(P.viewFromHash('')).toBeNull();
});

test('onglet mémorisé dans l’adresse et restauré', () => {
  expect(P.hashForView('links')).toBe('#recherche');
  expect(P.hashForView('messages')).toBe('#messages');
  expect(P.hashForView('offer')).toBeNull();
  for (const view of ['home', 'discover', 'messages', 'links', 'profile', 'notifications', 'learn', 'publish']) {
    expect(P.viewFromHash(P.hashForView(view))).toBe(view);
  }
  expect(P.viewFromHash('#recherche')).toBe('links');
  expect(P.viewFromHash('#toString')).toBeNull();
});

test('enable : permission demandée, abonnement, POST', async () => {
  const { nav, calls } = fakeNavigator();
  const { api, calls: apiCalls } = fakeApi();
  let asked = 0;
  const Notif = { permission: 'default', requestPermission: async () => { asked += 1; Notif.permission = 'granted'; return 'granted'; } };
  expect(await P.enable({ nav, Notif, api, publicKey: 'AQID' })).toBe('subscribed');
  expect(asked).toBe(1);
  expect(calls.subscribe).toBe(1);
  expect(apiCalls).toEqual([{ url: '/api/push/subscribe', method: 'POST', body: SUB }]);
});

test('enable : refus → denied, aucun abonnement', async () => {
  const { nav, calls } = fakeNavigator();
  const { api, calls: apiCalls } = fakeApi();
  const Notif = { permission: 'default', requestPermission: async () => 'denied' };
  expect(await P.enable({ nav, Notif, api, publicKey: 'AQID' })).toBe('denied');
  expect(calls.subscribe).toBe(0);
  expect(apiCalls).toEqual([]);
});

test('sync : jamais de demande de permission ; renvoie l’abonnement existant', async () => {
  const { api, calls: apiCalls } = fakeApi();
  const Notif = { permission: 'default', requestPermission: async () => { throw new Error('ne doit pas être appelé'); } };
  expect(await P.sync({ nav: fakeNavigator().nav, Notif, api })).toBe(false);
  const existing = { toJSON: () => SUB };
  expect(await P.sync({ nav: fakeNavigator(existing).nav, Notif: { permission: 'granted' }, api })).toBe(true);
  expect(apiCalls).toEqual([{ url: '/api/push/subscribe', method: 'POST', body: SUB }]);
});

test('disable : désabonne l’appareil puis DELETE', async () => {
  const { nav, calls } = fakeNavigator();
  const { api, calls: apiCalls } = fakeApi();
  await P.enable({ nav, Notif: { permission: 'granted' }, api, publicKey: 'AQID' });
  expect(await P.disable({ nav, api })).toBe('off');
  expect(calls.unsubscribe).toBe(1);
  expect(apiCalls[1]).toEqual({ url: '/api/push/subscribe', method: 'DELETE', body: { endpoint: SUB.endpoint } });
});
