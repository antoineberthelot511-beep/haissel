/*
 * Logique navigateur des notifications (frontend/notifications.js), exécutée
 * dans un DOM minimal simulé : permission, consentement explicite, affichage
 * en texte brut, reconnexion bornée.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/notifications.js'), 'utf8');

function fakeElement(tag = 'div') {
  const listeners = {};
  const classes = new Set();
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    textContent: '',
    disabled: false,
    attributes: {},
    classList: {
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    click: () => Promise.all((listeners.click || []).map((fn) => fn())),
    setAttribute: (name, value) => { element.attributes[name] = value; },
    append: (...nodes) => { element.children.push(...nodes); },
    replaceChildren: () => { element.children = []; },
    remove: () => {},
    get firstElementChild() { return element.children[0]; },
    set innerHTML(value) { throw new Error(`innerHTML interdit : ${value}`); },
  };
  return element;
}

function setup({
  permission = 'default', secure = true, supported = true, visible = 'visible', focused = true,
  sessionValid = true, grantOnRequest = false, systemBehavior = 'show', serviceWorker = false,
} = {}) {
  const ids = ['notif-stack', 'realtime-status', 'notif-permission-status', 'notif-permission-help',
    'notif-enable', 'notif-enable-top', 'realtime-retry', 'notif-test', 'notif-last-result', 'notif-diagnostic'];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement()]));
  const sources = [];
  const shown = [];
  const posts = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.closed = false;
      sources.push(this);
    }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    emit(type, data) { this.listeners[type]({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }

  // Simule le comportement du système : affichage ('show'), refus ('error')
  // ou constructeur interdit ('throw', ex. « Illegal constructor »).
  const Notification = function Notification(title, options) {
    if (systemBehavior === 'throw') throw new TypeError('Illegal constructor');
    shown.push({ title, ...options });
    queueMicrotask(() => {
      if (systemBehavior === 'show' && this.onshow) this.onshow();
      if (systemBehavior === 'error' && this.onerror) this.onerror();
    });
  };
  Notification.permission = permission;
  Notification.requestPermission = jest.fn(async () => {
    Notification.permission = grantOnRequest ? 'granted' : 'denied';
    return Notification.permission;
  });

  const swShown = [];
  const registration = {
    showNotification: jest.fn(async (title, options) => { swShown.push({ title, ...options }); }),
    getNotifications: async ({ tag }) => swShown.filter((item) => item.tag === tag),
  };
  const navigator = serviceWorker
    ? { serviceWorker: { register: jest.fn(async () => registration), ready: Promise.resolve(registration) } }
    : {};

  const window = {
    isSecureContext: secure,
    addEventListener: () => {},
    focus: () => {},
    location: { assign: jest.fn() },
  };
  if (supported) window.Notification = Notification;

  const context = {
    window,
    document: {
      visibilityState: visible,
      hasFocus: () => focused,
      getElementById: (id) => elements[id],
      createElement: (tag) => fakeElement(tag),
      addEventListener: () => {},
    },
    navigator,
    queueMicrotask,
    EventSource: FakeEventSource,
    Notification,
    JSON,
    Math,
    Date,
    Promise,
    setTimeout: (fn) => { context.pending.push(fn); return context.pending.length; },
    clearTimeout: () => {},
    pending: [],
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  const onSessionEnded = jest.fn();
  const center = window.createNotificationCenter({
    post: async (url, body) => { posts.push({ url, body }); },
    checkSession: async () => sessionValid,
    onSessionEnded,
  });
  return { center, elements, sources, shown, swShown, registration, posts, Notification, context, onSessionEnded };
}

const ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';

describe('consentement aux notifications système', () => {
  test('la permission n’est jamais demandée automatiquement', () => {
    const { center, Notification, elements } = setup();
    center.start();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(elements['notif-permission-status'].textContent).toBe('Non configurées');
  });

  test('demandée uniquement au clic ; un refus est affiché et respecté', async () => {
    const { center, Notification, elements } = setup();
    center.start();
    await elements['notif-enable'].click();
    expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(elements['notif-permission-status'].textContent).toBe('Refusées');
    expect(elements['notif-permission-help'].textContent).toMatch(/Autoriser/);
    expect(elements['notif-enable'].disabled).toBe(true);

    await elements['notif-enable'].click();
    expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
  });

  test('refus préalable : aucune notification système, affichage dans la page', async () => {
    const { center, sources, shown, elements } = setup({ permission: 'denied', visible: 'hidden' });
    center.start();
    sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M', url: null });
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(shown).toHaveLength(0);
    expect(elements['notif-stack'].children).toHaveLength(1);
  });

  test('origine HTTP non sécurisée : indisponible, aucune demande', async () => {
    const { center, Notification, elements } = setup({ secure: false });
    center.start();
    await elements['notif-enable'].click();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(elements['notif-permission-status'].textContent).toMatch(/HTTPS requis/);
  });

  test('navigateur sans API Notification', () => {
    const { center, elements } = setup({ supported: false });
    center.start();
    expect(elements['notif-permission-status'].textContent).toBe('Non prises en charge');
  });
});

describe('réception', () => {
  test('HTML / JavaScript affichés en texte brut, URL externe ignorée', () => {
    const { center, sources, elements, posts } = setup({ permission: 'denied' });
    center.start();
    const payload = '<img src=x onerror="alert(1)">';
    sources[0].emit('admin-notification', { id: ID, title: '<b>x</b>', message: payload, url: 'javascript:alert(1)' });

    const card = elements['notif-stack'].children[0];
    const texts = card.children.map((child) => child.textContent);
    expect(texts).toContain(payload);
    expect(texts).toContain('<b>x</b>');
    expect(card.children.some((child) => child.tagName === 'A')).toBe(false);
    // L'encadré est explicitement présenté comme un message de la page.
    expect(texts).toContain('Message HAISSEL (dans la page)');
    // Onglet visible : notification dans la page + accusé « in_app ».
    expect(posts).toEqual([{ url: `/api/notifications/${ID}/ack`, body: { mode: 'in_app' } }]);
  });

  test('doublon (même identifiant) ignoré', () => {
    const { center, sources, elements } = setup();
    center.start();
    sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    expect(elements['notif-stack'].children).toHaveLength(1);
  });

  test('événement malformé ignoré', () => {
    const { center, sources, elements } = setup();
    center.start();
    sources[0].emit('admin-notification', { id: 'pas-un-uuid', title: 'T', message: 'M' });
    sources[0].emit('admin-notification', { id: ID, title: { evil: true }, message: 'M' });
    expect(elements['notif-stack'].children).toHaveLength(0);
  });
});

describe('reconnexion', () => {
  test('délai croissant puis arrêt après un nombre limité de tentatives', async () => {
    const { center, sources, context, elements } = setup();
    center.start();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      sources.at(-1).onerror();
      expect(context.pending).toHaveLength(1);
      await context.pending.shift()();
    }
    expect(sources).toHaveLength(9);
    sources.at(-1).onerror();
    expect(context.pending).toHaveLength(0);
    expect(elements['realtime-status'].textContent).toBe('Hors ligne');
    expect(elements['realtime-retry'].classList.contains('hidden')).toBe(false);

    center.retryNow();
    expect(sources).toHaveLength(10);
  });

  test('session révoquée pendant le flux : arrêt, retour à la connexion, aucune nouvelle tentative', async () => {
    const { center, sources, context, onSessionEnded } = setup({ sessionValid: false });
    center.start();
    sources[0].emit('session-ended', { reason: 'logout' });
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(sources[0].closed).toBe(true);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(context.pending).toHaveLength(0);
    expect(sources).toHaveLength(1);
  });

  test('session remplacée (changement de mot de passe) : reconnexion', async () => {
    const { center, sources, context, onSessionEnded } = setup({ sessionValid: true });
    center.start();
    sources[0].emit('session-ended', { reason: 'password_changed' });
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(onSessionEnded).not.toHaveBeenCalled();
    await context.pending.shift()();
    expect(sources).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Notifications Windows (API système réelle)
// ---------------------------------------------------------------------------

/** Exécute les minuteries en attente (délai anti-doublon entre onglets). */
async function flush(context) {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
    const pending = context.pending.splice(0);
    pending.forEach((fn) => fn());
  }
  await new Promise((resolve) => { setImmediate(resolve); });
}

describe('notification système Windows', () => {
  test('clic sur le bouton : permission accordée, bouton de test proposé', async () => {
    const { center, elements, Notification } = setup({ grantOnRequest: true });
    center.start();
    expect(elements['notif-enable'].textContent).toBe('Activer les notifications Windows');
    await elements['notif-enable'].click();
    expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(elements['notif-permission-status'].textContent).toBe('Autorisées');
    expect(elements['notif-test'].classList.contains('hidden')).toBe(false);
  });

  test('onglet en arrière-plan : vraie notification système (titre, body en texte), accusé « system »', async () => {
    const env = setup({ permission: 'granted', visible: 'hidden', focused: false });
    env.center.start();
    const message = '<script>alert(1)</script>';
    env.sources[0].emit('admin-notification', { id: ID, title: 'Je personnalise', message, url: '/app' });
    await flush(env.context);
    expect(env.shown).toEqual([expect.objectContaining({ title: 'Je personnalise', body: message, tag: `haissel-${ID}` })]);
    expect(env.posts).toEqual([{ url: `/api/notifications/${ID}/ack`, body: { mode: 'system' } }]);
    expect(env.elements['notif-last-result'].textContent).toMatch(/transmise .* confirmé par le navigateur/);
  });

  test('fenêtre visible mais sans le focus (autre application au premier plan) : notification système', async () => {
    const env = setup({ permission: 'granted', visible: 'visible', focused: false });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.shown).toHaveLength(1);
  });

  test('page active et autorisation accordée : vraie notification Windows, sans encadré en double', async () => {
    const env = setup({ permission: 'granted', visible: 'visible', focused: true });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.shown).toEqual([expect.objectContaining({ title: 'T', body: 'M' })]);
    expect(env.elements['notif-stack'].children).toHaveLength(0);
    expect(env.posts).toEqual([{ url: `/api/notifications/${ID}/ack`, body: { mode: 'system' } }]);
  });

  test('même notification reçue deux fois (reconnexion) : une seule notification Windows', async () => {
    const env = setup({ permission: 'granted' });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    env.center.retryNow();
    env.sources.at(-1).emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.shown).toHaveLength(1);
  });

  test('autorisation « default » : message dans la page, aucune demande ni notification système', async () => {
    const env = setup({ permission: 'default' });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.Notification.requestPermission).not.toHaveBeenCalled();
    expect(env.shown).toHaveLength(0);
    expect(env.elements['notif-stack'].children).toHaveLength(1);
  });

  test('constructeur indisponible : secours par service worker (showNotification)', async () => {
    const env = setup({ permission: 'granted', visible: 'hidden', focused: false, systemBehavior: 'throw', serviceWorker: true });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.registration.showNotification).toHaveBeenCalledWith('T', expect.objectContaining({ body: 'M', tag: `haissel-${ID}` }));
    expect(env.posts[0].body).toEqual({ mode: 'system' });
  });

  test('échec de l’API : erreur affichée, aucun accusé « system »', async () => {
    const env = setup({ permission: 'granted', visible: 'hidden', focused: false, systemBehavior: 'throw' });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.posts).toHaveLength(0);
    // Secours : le message reste lisible dans la page.
    expect(env.elements['notif-stack'].children).toHaveLength(1);
    expect(env.elements['notif-last-result'].textContent).toMatch(/Échec de la notification Windows/);
    expect(env.elements['notif-last-result'].classList.contains('notif-error')).toBe(true);
  });

  test('le système refuse l’affichage (onerror) : erreur, pas de réussite simulée', async () => {
    const env = setup({ permission: 'granted', visible: 'hidden', focused: false, systemBehavior: 'error' });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.posts).toHaveLength(0);
    expect(env.elements['notif-last-result'].textContent).toMatch(/refusé/);
  });

  test('HTTP sur le réseau local : aucune tentative, explication HTTPS', async () => {
    const env = setup({ permission: 'granted', secure: false, visible: 'hidden', focused: false });
    env.center.start();
    env.sources[0].emit('admin-notification', { id: ID, title: 'T', message: 'M' });
    await flush(env.context);
    expect(env.shown).toHaveLength(0);
    expect(env.elements['notif-last-result'].textContent).toMatch(/non sécurisée/);
    expect(env.elements['notif-stack'].children).toHaveLength(1);
  });

  test('bouton de test : vraie notification système, jamais un encadré de la page', async () => {
    const env = setup({ permission: 'granted' });
    env.center.start();
    await env.elements['notif-test'].click();
    expect(env.shown).toEqual([expect.objectContaining({
      title: 'HAISSEL — Test de notification', body: 'Les notifications système fonctionnent correctement.',
    })]);
    expect(env.elements['notif-stack'].children).toHaveLength(0);
    expect(env.elements['notif-last-result'].textContent).toMatch(/transmis la notification à Windows/);
  });

  test('bouton de test sans autorisation : aucune notification, erreur claire', async () => {
    const env = setup({ permission: 'denied' });
    env.center.start();
    await env.elements['notif-test'].click();
    expect(env.shown).toHaveLength(0);
    expect(env.elements['notif-last-result'].textContent).toMatch(/Test impossible/);
  });

  test('bouton de test : échec de création signalé, pas de réussite simulée', async () => {
    const env = setup({ permission: 'granted', systemBehavior: 'throw' });
    env.center.start();
    await env.elements['notif-test'].click();
    expect(env.elements['notif-last-result'].textContent).toMatch(/échec, aucune notification n’a été créée/);
    expect(env.elements['notif-last-result'].classList.contains('notif-error')).toBe(true);
  });

  test('diagnostic : contexte sécurisé réel du navigateur affiché', () => {
    const env = setup({ permission: 'granted', secure: false });
    env.center.start();
    expect(env.elements['notif-diagnostic'].textContent).toMatch(/contexte sécurisé pour le navigateur : non/);
  });
});
