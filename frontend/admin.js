'use strict';

/*
 * Console d'administration HAISSEL : publication de liens et suivi des clics.
 *
 * Sécurité : ce script ne décide d'AUCUNE permission. Le serveur vérifie à
 * chaque requête l'origine locale, la session et le rôle ADMIN. Toutes les
 * données sont insérées via textContent (fonction h) : rien n'est interprété
 * comme du HTML.
 */

const PAGE_SIZE = 25;

/*
 * La session repose sur un cookie HttpOnly posé par le serveur : ce script
 * ne stocke aucun jeton. Seul le jeton CSRF (lié à la session) est gardé en
 * mémoire pour l'en-tête X-CSRF-Token.
 */
const state = {
  csrf: '',
  user: null,
  section: 'dashboard',
  clicksPage: 1,
};

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function purgeLegacyStorage() {
  try {
    for (const key of ['haissel_admin_token', 'haissel_token', 'haissel_user', 'lycee_token']) localStorage.removeItem(key);
  } catch (error) { /* stockage indisponible */ }
}

const $ = (id) => document.getElementById(id);

/** Création d'élément sûre : les chaînes deviennent des nœuds texte. */
function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') element.className = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const numberFormatter = new Intl.NumberFormat('fr-FR');
function num(value) { return numberFormatter.format(Number(value || 0)); }
function date(value) {
  return value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(url, options = {}) {
  let response;
  try {
    const method = options.method || 'GET';
    response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(method !== 'GET' && state.csrf ? { 'X-CSRF-Token': state.csrf } : {}),
      },
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK', 'Serveur injoignable.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new ApiError(
      response.status,
      payload.error?.code || 'ERROR',
      typeof payload.error?.message === 'string' ? payload.error.message : 'Une erreur est survenue.'
    );
    if (response.status === 401 && state.user) {
      showLogin('Votre session a expiré. Veuillez vous reconnecter.');
    }
    throw error;
  }
  if (payload.data?.csrf_token) state.csrf = payload.data.csrf_token;
  return payload.data;
}

let toastTimer;
function toast(message, kind = 'success') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

function confirmAction(title, message, confirmLabel = 'Oui') {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = confirmLabel;

  if (typeof dialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function showAlert(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.hidden = !message;
}

function badge(label, kind) {
  return h('span', { className: `badge ${kind}` }, label);
}

/** Tableau générique : columns = [{ label, render(row) }]. */
function renderTable(containerId, columns, rows, emptyMessage) {
  const container = $(containerId);
  container.replaceChildren();
  if (!rows.length) {
    container.append(h('p', { className: 'empty' }, emptyMessage));
    return;
  }
  container.append(h('table', null,
    h('thead', null, h('tr', null, columns.map((col) => h('th', { scope: 'col' }, col.label)))),
    h('tbody', null, rows.map((row) => h('tr', null, columns.map((col) => h('td', { 'data-label': col.label }, col.render(row))))))
  ));
}

function handleError(error) {
  if (error.status === 401) return;
  if (error.code === 'MFA_SETUP_REQUIRED') {
    showMfaSetup();
    return;
  }
  if (error.code === 'ADMIN_LOCAL_ONLY' || error.code === 'FORBIDDEN') {
    showLogin(error.message);
    return;
  }
  toast(error.message, 'error');
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

const SCREENS = ['login-screen', 'mfa-setup-screen', 'admin-shell'];

function showScreen(id) {
  for (const screen of SCREENS) $(screen).hidden = screen !== id;
}

function showLogin(message) {
  state.user = null;
  state.csrf = '';
  showScreen('login-screen');
  $('login-form').hidden = false;
  $('mfa-form').hidden = true;
  showAlert('login-error', message);
  $('login-identifier').focus();
}

function showMfaStep() {
  showScreen('login-screen');
  $('login-form').hidden = true;
  $('mfa-form').hidden = false;
  showAlert('mfa-error', '');
  $('mfa-code').value = '';
  $('mfa-code').focus();
}

function showMfaSetup() {
  showScreen('mfa-setup-screen');
  $('setup-start-form').hidden = false;
  $('setup-confirm-form').hidden = true;
  $('setup-done').hidden = true;
  showAlert('setup-error', '');
  $('setup-password').focus();
}

function showConsole() {
  showScreen('admin-shell');
  $('admin-name').textContent = state.user.display_name || state.user.username;
  openSection(sectionFromHash());
  startNetworkRefresh();
}

async function revokeCurrentSession() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (error) { /* session déjà invalide */ }
  state.csrf = '';
}

/**
 * Vérifie côté serveur : session, rôle ADMIN et double authentification.
 * Retourne l'écran à afficher.
 */
async function resolveAdminSession() {
  const data = await api('/api/auth/me');
  if (data.mfa_pending) return 'mfa';
  if (data.user.role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', 'Accès administrateur refusé.');
  }
  state.user = data.user;
  try {
    await api('/api/admin/overview');
  } catch (error) {
    if (error.code === 'MFA_SETUP_REQUIRED') return 'setup';
    throw error;
  }
  return 'console';
}

async function routeAfterAuth() {
  const next = await resolveAdminSession();
  if (next === 'mfa') showMfaStep();
  else if (next === 'setup') showMfaSetup();
  else showConsole();
}

async function handleLogin(event) {
  event.preventDefault();
  const identifier = $('login-identifier').value.trim();
  const password = $('login-password').value;
  if (!identifier || !password) {
    showAlert('login-error', 'Renseignez votre adresse e-mail ou pseudo et votre mot de passe.');
    return;
  }

  const submit = $('login-submit');
  submit.disabled = true;
  showAlert('login-error', '');

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    });
    $('login-password').value = '';
    if (data.mfa_required) {
      showMfaStep();
      return;
    }
    try {
      await routeAfterAuth();
    } catch (error) {
      // Compte valide mais pas administrateur : la session est révoquée.
      await revokeCurrentSession();
      throw error;
    }
  } catch (error) {
    showAlert('login-error', error.message);
  } finally {
    submit.disabled = false;
  }
}

async function handleMfa(event) {
  event.preventDefault();
  const value = $('mfa-code').value.trim();
  const body = /^\d{6}$/.test(value) ? { code: value } : { recovery_code: value };
  try {
    await api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify(body) });
    await routeAfterAuth();
  } catch (error) {
    if (error.code === 'MFA_LOCKED' || error.status === 401 && error.code !== 'INVALID_MFA_CODE') {
      showLogin(error.message);
      return;
    }
    if (error.code === 'FORBIDDEN') {
      await revokeCurrentSession();
      showLogin(error.message);
      return;
    }
    showAlert('mfa-error', error.message);
  }
}

async function handleSetupStart(event) {
  event.preventDefault();
  showAlert('setup-error', '');
  try {
    const data = await api('/api/auth/mfa/setup', {
      method: 'POST',
      body: JSON.stringify({ password: $('setup-password').value }),
    });
    $('setup-password').value = '';
    $('setup-secret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
    $('setup-uri').setAttribute('href', data.otpauth_uri);
    $('setup-start-form').hidden = true;
    $('setup-confirm-form').hidden = false;
    $('setup-code').focus();
  } catch (error) {
    showAlert('setup-error', error.message);
  }
}

async function handleSetupConfirm(event) {
  event.preventDefault();
  showAlert('setup-error', '');
  try {
    const data = await api('/api/auth/mfa/enable', {
      method: 'POST',
      body: JSON.stringify({ code: $('setup-code').value.trim() }),
    });
    $('setup-code').value = '';
    $('recovery-codes').replaceChildren(...data.recovery_codes.map((code) => h('li', null, code)));
    $('setup-confirm-form').hidden = true;
    $('setup-done').hidden = false;
  } catch (error) {
    showAlert('setup-error', error.message);
  }
}

async function handleLogout() {
  clearInterval(networkTimer);
  await revokeCurrentSession();
  showLogin('');
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const SECTIONS = ['dashboard', 'links', 'clicks', 'notifications'];

function sectionFromHash() {
  const name = window.location.hash.replace('#', '');
  return SECTIONS.includes(name) ? name : 'dashboard';
}

function openSection(name) {
  state.section = name;
  for (const section of SECTIONS) {
    $(`section-${section}`).hidden = section !== name;
  }
  document.querySelectorAll('.nav a').forEach((link) => {
    if (link.dataset.section === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  LOADERS[name]().catch(handleError);
}

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

function metricCard(label, value, tone, hint) {
  return h('article', { className: `metric-card ${tone}` },
    h('span', { className: 'metric-label' }, label),
    h('strong', { className: 'metric-value' }, value),
    hint ? h('small', { className: 'metric-hint' }, hint) : null);
}

async function fetchLinks() {
  const data = await api('/api/admin/affiliates?limit=100');
  return data.items;
}

// ---------------------------------------------------------------------------
// Lien à donner aux utilisateurs (suit les changements de Wi-Fi)
// ---------------------------------------------------------------------------

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Lien copié.');
  } catch (error) {
    toast('Copie impossible : sélectionnez le lien et faites Ctrl+C.', 'error');
  }
}

async function loadNetwork() {
  const data = await api('/api/admin/network');
  const box = $('share-box');
  const [main, ...others] = data.addresses;

  if (!main) {
    box.replaceChildren(
      h('p', { className: 'eyebrow' }, 'Lien pour les utilisateurs'),
      h('p', { className: 'share-empty' }, 'Aucun réseau détecté. Connectez ce PC à un Wi-Fi : le lien apparaîtra ici automatiquement.')
    );
    return;
  }

  box.replaceChildren(
    h('p', { className: 'eyebrow' }, `Lien pour les utilisateurs · ${main.interface}`),
    h('div', { className: 'share-row' },
      h('a', { className: 'share-url', href: main.url, target: '_blank', rel: 'noopener noreferrer' }, main.url),
      h('button', { className: 'btn primary', type: 'button', onclick: () => copyToClipboard(main.url) }, 'Copier')),
    h('p', { className: 'hint' }, 'À partager avec les appareils connectés au même Wi-Fi que ce PC. Mis à jour automatiquement si vous changez de réseau.'),
    others.length ? h('p', { className: 'hint' }, `Autres adresses : ${others.map((o) => `${o.url} (${o.interface})`).join(' · ')}`) : null
  );
}

let networkTimer;
function startNetworkRefresh() {
  clearInterval(networkTimer);
  networkTimer = setInterval(() => {
    if (state.user && state.section === 'dashboard' && document.visibilityState === 'visible') {
      loadNetwork().catch(() => {});
    }
  }, 15000);
}

async function loadDashboard() {
  loadNetwork().catch(handleError);
  const [overview, links] = await Promise.all([api('/api/admin/overview'), fetchLinks()]);
  $('overview-cards').replaceChildren(
    metricCard('Clics au total', num(overview.total_clicks), 'indigo'),
    metricCard("Clics aujourd'hui", num(overview.clicks_today), 'cyan'),
    metricCard('Liens publiés', num(overview.active_offers), 'violet', `${num(overview.total_offers)} au total`),
    metricCard('Comptes utilisateurs', num(overview.total_users), 'blue')
  );

  const sorted = [...links].sort((a, b) => b.total_clicks - a.total_clicks);
  renderTable('dashboard-links', [
    { label: 'Lien', render: (l) => l.name },
    { label: 'Clics', render: (l) => h('strong', null, num(l.total_clicks)) },
    { label: 'Personnes', render: (l) => num(l.unique_clickers) },
    { label: 'Dernier clic', render: (l) => date(l.last_click_at) },
    { label: 'Statut', render: (l) => (l.is_active ? badge('Visible', 'ok') : badge('Masqué', 'muted')) },
  ], sorted, 'Aucun lien publié. Ajoutez-en un dans la section « Liens ».');
}

// ---------------------------------------------------------------------------
// Liens
// ---------------------------------------------------------------------------

async function toggleLink(link) {
  const show = !link.is_active;
  const ok = await confirmAction(
    show ? 'Afficher ce lien ?' : 'Masquer ce lien ?',
    show
      ? `« ${link.name} » sera de nouveau visible par les utilisateurs.`
      : `« ${link.name} » ne sera plus visible ni cliquable. Ses clics sont conservés.`,
    show ? 'Afficher' : 'Masquer'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/affiliates/${encodeURIComponent(link.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: show }),
    });
    toast(show ? 'Lien visible.' : 'Lien masqué.');
    await loadLinks();
  } catch (error) {
    handleError(error);
  }
}

async function loadLinks() {
  const links = await fetchLinks();
  renderTable('links-table', [
    { label: 'Titre', render: (l) => h('div', { className: 'cell-main' }, h('strong', null, l.name), l.description ? h('small', null, l.description) : null) },
    { label: 'Adresse', render: (l) => h('code', { className: 'url', title: l.url }, l.url) },
    { label: 'Clics', render: (l) => h('strong', null, num(l.total_clicks)) },
    { label: 'Personnes', render: (l) => num(l.unique_clickers) },
    { label: 'Statut', render: (l) => (l.is_active ? badge('Visible', 'ok') : badge('Masqué', 'muted')) },
    { label: 'Action', render: (l) => h('button', { className: 'btn small ghost', type: 'button', onclick: () => toggleLink(l) }, l.is_active ? 'Masquer' : 'Afficher') },
  ], links, 'Aucun lien pour le moment.');
}

async function handleLinkSubmit(event) {
  event.preventDefault();
  showAlert('link-error', '');
  const payload = {
    name: $('link-name').value.trim(),
    url: $('link-url').value.trim(),
    description: $('link-description').value.trim(),
  };
  if (!payload.name || !payload.url) {
    showAlert('link-error', 'Le titre et l’adresse sont obligatoires.');
    return;
  }
  try {
    await api('/api/admin/affiliates', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    toast('Lien publié : il est visible par les utilisateurs.');
    await loadLinks();
  } catch (error) {
    if (error.status === 400) showAlert('link-error', error.message);
    else handleError(error);
  }
}

// ---------------------------------------------------------------------------
// Clics
// ---------------------------------------------------------------------------

async function loadClicks() {
  const data = await api(`/api/admin/clicks?page=${state.clicksPage}&limit=${PAGE_SIZE}`);
  renderTable('clicks-table', [
    { label: 'Date', render: (c) => date(c.created_at) },
    { label: 'Utilisateur', render: (c) => c.username || '—' },
    { label: 'Lien', render: (c) => c.offer_name },
  ], data.items, 'Aucun clic pour le moment.');

  const pager = $('clicks-pager');
  pager.replaceChildren();
  const pages = Math.max(1, Math.ceil(Number(data.pagination.total || 0) / PAGE_SIZE));
  if (pages > 1) {
    const go = (page) => { state.clicksPage = page; loadClicks().catch(handleError); };
    pager.append(
      h('button', { className: 'btn ghost small', type: 'button', disabled: state.clicksPage <= 1, onclick: () => go(state.clicksPage - 1) }, 'Précédent'),
      h('span', { className: 'muted' }, `Page ${state.clicksPage} / ${pages}`),
      h('button', { className: 'btn ghost small', type: 'button', disabled: state.clicksPage >= pages, onclick: () => go(state.clicksPage + 1) }, 'Suivant')
    );
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const NOTIF_LIMITS = { title: 80, message: 500 };
const BROADCAST_STATUS = {
  delivered: ['Distribuée', 'ok'],
  partial: ['Partielle', 'warn'],
  no_recipients: ['Aucun destinataire', 'muted'],
  failed: ['Échec', 'bad'],
  pending: ['En cours', 'muted'],
};

function updateNotifPreview() {
  const title = $('notif-title').value;
  const message = $('notif-message').value;
  const url = $('notif-url').value;
  $('notif-title-count').textContent = `${[...title].length} / ${NOTIF_LIMITS.title}`;
  $('notif-message-count').textContent = `${[...message].length} / ${NOTIF_LIMITS.message}`;
  // textContent : le contenu saisi n'est jamais interprété comme du HTML.
  $('notif-preview-title').textContent = title.trim() || 'Titre';
  $('notif-preview-message').textContent = message.trim() || 'Message';
  $('notif-preview-url').textContent = url ? `Ouvre : ${url}` : '';
}

function renderPresence(presence) {
  $('notif-presence').replaceChildren(
    h('strong', {}, num(presence.connected_users)),
    ` utilisateur(s) connecté(s) au canal temps réel · ${num(presence.connections)} onglet(s) ouvert(s)`
  );
}

function renderBroadcastResult(broadcast) {
  const [label, tone] = BROADCAST_STATUS[broadcast.status] || [broadcast.status, 'muted'];
  const lines = [
    `Utilisateurs connectés : ${num(broadcast.connected_users)}`,
    `Utilisateurs ayant reçu la notification : ${num(broadcast.delivered_users)}`,
    `Onglets atteints : ${num(broadcast.delivered_connections)}`,
  ];
  if (broadcast.failed_connections) lines.push(`Erreurs de distribution : ${num(broadcast.failed_connections)} onglet(s)`);
  const kind = tone === 'ok' ? 'success' : (tone === 'bad' ? 'error' : 'info');
  $('notif-result').replaceChildren(
    h('div', { className: `alert ${kind}` }, h('strong', {}, label), h('ul', {}, lines.map((line) => h('li', {}, line))))
  );
}

async function loadNotifications() {
  const [presence, history] = await Promise.all([
    api('/api/admin/notifications/presence'),
    api('/api/admin/notifications?limit=20'),
  ]);
  renderPresence(presence);
  renderTable('notif-history', [
    { label: 'Date', render: (row) => date(row.created_at) },
    { label: 'Titre', render: (row) => row.title },
    { label: 'Message', render: (row) => h('span', { className: 'clamp' }, row.message) },
    { label: 'Statut', render: (row) => badge(...(BROADCAST_STATUS[row.status] || [row.status, 'muted'])) },
    { label: 'Connectés', render: (row) => num(row.connected_users) },
    { label: 'Distribuées', render: (row) => num(row.delivered_users) },
    { label: 'Affichées', render: (row) => num(row.displayed_users) },
    { label: 'Par', render: (row) => row.admin_username || '—' },
  ], history.items, 'Aucune notification envoyée pour le moment.');
}

async function handleNotifSubmit(event) {
  event.preventDefault();
  showAlert('notif-error', '');
  const payload = {
    title: $('notif-title').value.trim(),
    message: $('notif-message').value.trim(),
    target: $('notif-target').value,
    url: $('notif-url').value || null,
  };
  if (!payload.title || !payload.message) {
    showAlert('notif-error', 'Le titre et le message sont obligatoires.');
    return;
  }
  if ([...payload.title].length > NOTIF_LIMITS.title || [...payload.message].length > NOTIF_LIMITS.message) {
    showAlert('notif-error', 'Le titre ou le message est trop long.');
    return;
  }

  const confirmed = await confirmAction(
    'Envoyer la notification ?',
    `« ${payload.title} » sera envoyée à tous les utilisateurs actuellement connectés.`,
    'Envoyer'
  );
  if (!confirmed) return;

  const button = $('notif-send');
  button.disabled = true;
  $('notif-loading').hidden = false;
  $('notif-result').replaceChildren();
  try {
    const data = await api('/api/admin/notifications', { method: 'POST', body: JSON.stringify(payload) });
    renderBroadcastResult(data.broadcast);
    const reached = data.broadcast.delivered_users > 0;
    toast(reached ? 'Notification envoyée.' : 'Aucun utilisateur connecté : rien n’a été distribué.', reached ? 'success' : 'error');
    await loadNotifications();
  } catch (error) {
    showAlert('notif-error', error.message);
  } finally {
    button.disabled = false;
    $('notif-loading').hidden = true;
  }
}

const LOADERS = {
  dashboard: loadDashboard,
  links: loadLinks,
  clicks: loadClicks,
  notifications: loadNotifications,
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function bindEvents() {
  $('login-form').addEventListener('submit', handleLogin);
  $('mfa-form').addEventListener('submit', handleMfa);
  $('mfa-cancel').addEventListener('click', handleLogout);
  $('setup-start-form').addEventListener('submit', handleSetupStart);
  $('setup-confirm-form').addEventListener('submit', handleSetupConfirm);
  $('setup-continue').addEventListener('click', () => routeAfterAuth().catch((error) => showLogin(error.message)));
  $('setup-logout').addEventListener('click', handleLogout);
  $('admin-logout').addEventListener('click', handleLogout);
  $('link-form').addEventListener('submit', handleLinkSubmit);
  $('notif-form').addEventListener('submit', handleNotifSubmit);
  for (const id of ['notif-title', 'notif-message', 'notif-url']) {
    $(id).addEventListener('input', updateNotifPreview);
  }
  updateNotifPreview();

  document.querySelectorAll('[data-refresh]').forEach((button) => {
    button.addEventListener('click', () => LOADERS[button.dataset.refresh]().catch(handleError));
  });

  window.addEventListener('hashchange', () => {
    if (state.user) openSection(sectionFromHash());
  });
}

async function init() {
  bindEvents();
  purgeLegacyStorage();
  try {
    await routeAfterAuth();
  } catch (error) {
    if (error.code === 'FORBIDDEN') await revokeCurrentSession();
    showLogin(error.status === 401 ? '' : error.message);
  }
}

document.addEventListener('DOMContentLoaded', init);
