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
  usersPage: 1,
  usersSearch: '',
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
/* Ours de la mascotte (mascot.js) ; rien si le script manque. */
function bear(name, size) {
  return window.HaisselMascot ? window.HaisselMascot.mascot(name, { size }) : null;
}

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
/*
 * Notification Web Push de test vers les appareils de l'admin connecté
 * (abonnés depuis Profil › Réglages de l'espace membre, avec ce compte).
 */
async function sendPushTest() {
  const button = $('push-test');
  button.disabled = true;
  try {
    const result = await api('/api/admin/push/test', { method: 'POST', body: '{}' });
    if (!result.devices) toast('Aucun appareil abonné : active les notifications dans Profil › Réglages avec ce compte.', 'error');
    else if (result.timeout) toast('Envoi trop long : réessaie dans un instant.', 'error');
    else {
      const failures = (result.failures || []).map((code) => `HTTP ${code}`).join(', ');
      const text = `Envoyée à ${result.sent} appareil(s) sur ${result.devices}.`;
      if (result.sent < result.devices) {
        toast(`${text} Échec : ${failures || 'pas de réponse du service'}.`, 'error');
      } else {
        toast(text);
      }
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

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

  // Jeton anti-robot exigé par le serveur quand Turnstile est configuré.
  const form = $('login-form');
  const body = { identifier, password };
  if (window.HaisselTurnstile && window.HaisselTurnstile.enabled()) {
    const token = window.HaisselTurnstile.tokenFor(form);
    if (!token) {
      showAlert('login-error', 'Validez la vérification anti-robot avant de vous connecter.');
      return;
    }
    body.cf_turnstile_response = token;
  }

  const submit = $('login-submit');
  submit.disabled = true;
  showAlert('login-error', '');

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
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
    // Un jeton ne sert qu'une fois : nouveau défi avant la tentative suivante.
    if (window.HaisselTurnstile) window.HaisselTurnstile.reset(form);
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

const SECTIONS = ['dashboard', 'links', 'clicks', 'users', 'notifications', 'moderation', 'inbox', 'contact', 'categories',
  'content', 'opportunities', 'referral'];

// « #messages » : lien des notifications Web Push de l'équipe (sw.js).
const SECTION_ALIASES = { messages: 'inbox' };

function sectionFromHash() {
  const raw = window.location.hash.replace('#', '');
  const name = SECTION_ALIASES[raw] || raw;
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
// Utilisateurs
// ---------------------------------------------------------------------------

/*
 * GET /api/admin/users ne renvoie pas (encore) is_adult : le bouton est donc
 * proposé pour tous les comptes. Si le champ apparaît, seuls les comptes
 * déclarés mineurs (is_adult === false) le gardent.
 */
function canResetAdultDeclaration(user) {
  return user.is_adult === undefined || user.is_adult === false;
}

async function resetAdultDeclaration(user) {
  const ok = await confirmAction(
    'Réinitialiser la déclaration d’âge',
    `La question sur l’âge sera reposée à @${user.username} à sa prochaine visite. Continuer ?`,
    'Réinitialiser'
  );
  if (!ok) return;
  try {
    const data = await api(`/api/admin/users/${encodeURIComponent(user.id)}/adult-declaration/reset`, { method: 'POST' });
    toast(data.message || 'Déclaration d’âge réinitialisée.');
    await loadUsers();
  } catch (error) {
    handleError(error);
  }
}

function userStatusBadge(user) {
  if (user.is_banned) return badge('Banni', 'bad');
  if (!user.is_active) return badge('Suspendu', 'warn');
  return badge('Actif', 'ok');
}

async function loadUsers() {
  const params = new URLSearchParams({ page: state.usersPage, limit: PAGE_SIZE });
  if (state.usersSearch) params.set('search', state.usersSearch);
  const data = await api(`/api/admin/users?${params}`);
  renderTable('users-table', [
    { label: 'Pseudo', render: (u) => `@${u.username}` },
    { label: 'Nom', render: (u) => u.display_name || '—' },
    { label: 'E-mail', render: (u) => u.email || '—' },
    { label: 'Inscription', render: (u) => date(u.created_at) },
    { label: 'Statut', render: userStatusBadge },
    {
      label: 'Action',
      render: (u) => (canResetAdultDeclaration(u)
        ? h('button', { className: 'btn small ghost', type: 'button', onclick: () => resetAdultDeclaration(u) }, 'Réinitialiser la déclaration d’âge')
        : '—'),
    },
  ], data.users, state.usersSearch ? 'Aucun utilisateur ne correspond à cette recherche.' : 'Aucun utilisateur.');

  const pager = $('users-pager');
  pager.replaceChildren();
  const pages = Math.max(1, Math.ceil(Number(data.pagination.total || 0) / PAGE_SIZE));
  if (pages > 1) {
    const go = (page) => { state.usersPage = page; loadUsers().catch(handleError); };
    pager.append(
      h('button', { className: 'btn ghost small', type: 'button', disabled: state.usersPage <= 1, onclick: () => go(state.usersPage - 1) }, 'Précédent'),
      h('span', { className: 'muted' }, `Page ${state.usersPage} / ${pages}`),
      h('button', { className: 'btn ghost small', type: 'button', disabled: state.usersPage >= pages, onclick: () => go(state.usersPage + 1) }, 'Suivant')
    );
  }
}

function handleUsersSearch(event) {
  event.preventDefault();
  state.usersSearch = $('users-search').value.trim();
  state.usersPage = 1;
  loadUsers().catch(handleError);
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

/*
 * Canal des notifications, renseigné par /presence : « sse » (flux permanent)
 * ou « poll » (interrogation, Vercel). Les libellés en dépendent.
 */
let realtimeMode = 'sse';

/*
 * En mode interrogation, le nombre d'utilisateurs connectés n'existe pas :
 * plusieurs instances répondent sans mémoire partagée, aucune ne connaît les
 * onglets des autres. On l'indique au lieu d'afficher le compte partiel d'une
 * instance, qui serait faux.
 */
function renderPresence(presence) {
  if (presence.available === false) {
    $('notif-presence').replaceChildren(
      h('strong', {}, 'Comptage indisponible en ligne'),
      ' — le site tourne sur plusieurs instances sans mémoire partagée, aucune ne connaît les onglets ouverts. '
      + `Les notifications sont remises aux membres dont la session est valide, dans un délai de ${num(presence.poll_interval_seconds || 45)} s.`
    );
    return;
  }
  $('notif-presence').replaceChildren(
    h('strong', {}, num(presence.connected_users)),
    ` utilisateur(s) connecté(s) au canal temps réel · ${num(presence.connections)} onglet(s) ouvert(s)`
  );
}

function renderBroadcastResult(broadcast) {
  const [label, tone] = BROADCAST_STATUS[broadcast.status] || [broadcast.status, 'muted'];
  const polling = (broadcast.mode || realtimeMode) === 'poll';
  const lines = polling
    ? [
      `Destinataires enregistrés (sessions valides) : ${num(broadcast.connected_users)}`,
      'Remise à la prochaine actualisation de chaque membre (au plus 45 s).',
    ]
    : [
      `Utilisateurs connectés : ${num(broadcast.connected_users)}`,
      `Utilisateurs ayant reçu la notification : ${num(broadcast.delivered_users)}`,
      `Onglets atteints : ${num(broadcast.delivered_connections)}`,
    ];
  if (!polling && broadcast.failed_connections) lines.push(`Erreurs de distribution : ${num(broadcast.failed_connections)} onglet(s)`);
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
  realtimeMode = presence.mode === 'poll' ? 'poll' : 'sse';
  renderPresence(presence);
  renderTable('notif-history', [
    { label: 'Date', render: (row) => date(row.created_at) },
    { label: 'Titre', render: (row) => row.title },
    { label: 'Message', render: (row) => h('span', { className: 'clamp' }, row.message) },
    { label: 'Statut', render: (row) => badge(...(BROADCAST_STATUS[row.status] || [row.status, 'muted'])) },
    {
      label: realtimeMode === 'poll' ? 'Destinataires' : 'Connectés',
      render: (row) => num(row.connected_users),
    },
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

// ---------------------------------------------------------------------------
// Apprendre : guides, tutoriels, opportunités, parrainage
// ---------------------------------------------------------------------------

const STATUS_BADGES = {
  draft: ['Brouillon', 'muted'],
  published: ['Publié', 'ok'],
  disabled: ['Désactivé', 'bad'],
};

/** Lit les champs [data-field] d'un formulaire ; vide -> null. */
function readForm(form) {
  const values = {};
  form.querySelectorAll('[data-field]').forEach((input) => {
    const name = input.dataset.field;
    if (input.type === 'checkbox') values[name] = input.checked;
    else if (input.type === 'number') values[name] = input.value === '' ? null : Number(input.value);
    else values[name] = input.value.trim() === '' ? null : input.value.trim();
  });
  return values;
}

function fillForm(form, values) {
  form.querySelectorAll('[data-field]').forEach((input) => {
    const value = values[input.dataset.field];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value === null || value === undefined ? '' : String(value);
  });
}

const learnEditors = {
  content: { api: '/api/admin/learn/content', form: 'content-form', table: 'content-table', title: 'content-form-title', error: 'content-error', label: 'contenu', editing: null },
  opportunity: { api: '/api/admin/learn/opportunities', form: 'opportunity-form', table: 'opportunity-table', title: 'opportunity-form-title', error: 'opportunity-error', label: 'opportunité', editing: null },
};

function resetEditor(name) {
  const editor = learnEditors[name];
  editor.editing = null;
  $(editor.form).reset();
  $(editor.title).textContent = name === 'content' ? 'Nouveau contenu' : 'Nouvelle opportunité';
  document.querySelector(`[data-cancel-edit="${name}"]`).hidden = true;
  showAlert(editor.error, '');
}

function startEdit(name, item) {
  const editor = learnEditors[name];
  editor.editing = item.id;
  fillForm($(editor.form), item);
  $(editor.title).textContent = `Modifier : ${item.title || item.name}`;
  document.querySelector(`[data-cancel-edit="${name}"]`).hidden = false;
  showAlert(editor.error, item.status === 'published' ? 'Attention : enregistrer une modification retire la publication jusqu’à une nouvelle vérification.' : '');
  $(editor.form).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function learnAction(name, item, action, body) {
  const editor = learnEditors[name];
  try {
    await api(`${editor.api}/${encodeURIComponent(item.id)}/${action}`, { method: 'POST', body: JSON.stringify(body || {}) });
    toast(action === 'verify' ? 'Vérification enregistrée.' : 'Statut mis à jour.');
    await LOADERS[name === 'content' ? 'content' : 'opportunities']();
  } catch (error) {
    if (error.status === 409 || error.status === 400) toast(error.message, 'error');
    else handleError(error);
  }
}

async function confirmVerify(name, item) {
  const message = name === 'content'
    ? 'Confirmez que ce texte est exact, sans promesse de gain, sans chiffre inventé ni témoignage fictif.'
    : 'Confirmez avoir relu les conditions officielles : action rémunérée, pays, âge minimum, restrictions et méthodes de promotion autorisées.';
  if (await confirmAction('Marquer comme vérifié ?', message, 'Je confirme')) learnAction(name, item, 'verify');
}

function learnActions(name, item) {
  const buttons = [h('button', { className: 'btn small ghost', type: 'button', onclick: () => startEdit(name, item) }, 'Modifier')];
  if (!item.verified_at) {
    buttons.push(h('button', { className: 'btn small ghost', type: 'button', onclick: () => confirmVerify(name, item) }, 'Vérifier'));
  }
  if (item.status !== 'published' && item.verified_at) {
    buttons.push(h('button', { className: 'btn small primary', type: 'button', onclick: () => learnAction(name, item, 'status', { status: 'published' }) }, 'Publier'));
  }
  if (item.status === 'published') {
    buttons.push(h('button', { className: 'btn small ghost', type: 'button', onclick: () => learnAction(name, item, 'status', { status: 'draft' }) }, 'Dépublier'));
  }
  if (item.status !== 'disabled') {
    buttons.push(h('button', { className: 'btn small ghost', type: 'button', onclick: () => learnAction(name, item, 'status', { status: 'disabled' }) }, 'Désactiver'));
  } else {
    buttons.push(h('button', { className: 'btn small ghost', type: 'button', onclick: () => learnAction(name, item, 'status', { status: 'draft' }) }, 'Réactiver (brouillon)'));
  }
  return h('div', { className: 'row-actions' }, buttons);
}

function verificationCell(item) {
  if (item.verified_at) return badge(`Vérifié ${date(item.verified_at)}`, 'ok');
  if (item.missing_for_publication?.length) return h('small', null, `À compléter : ${item.missing_for_publication.join(', ')}`);
  return badge('À vérifier', 'warn');
}

async function loadContent() {
  const data = await api(learnEditors.content.api);
  renderTable('content-table', [
    { label: 'Titre', render: (c) => h('div', { className: 'cell-main' }, h('strong', null, c.title), h('small', null, c.slug)) },
    { label: 'Type', render: (c) => (c.kind === 'guide' ? 'Guide' : 'Tutoriel') },
    { label: 'Statut', render: (c) => badge(...STATUS_BADGES[c.status]) },
    { label: 'Vérification', render: verificationCell },
    { label: 'Actions', render: (c) => learnActions('content', c) },
  ], data.items, 'Aucun contenu.');
}

async function loadOpportunities() {
  const data = await api(learnEditors.opportunity.api);
  renderTable('opportunity-table', [
    { label: 'Offre', render: (o) => h('div', { className: 'cell-main' }, h('strong', null, o.name), h('small', null, [o.network, o.countries].filter(Boolean).join(' · '))) },
    { label: 'Âge min.', render: (o) => (o.min_age ? `${o.min_age} ans` : '—') },
    { label: 'Statut', render: (o) => badge(...STATUS_BADGES[o.status]) },
    { label: 'Vérification', render: verificationCell },
    { label: 'Actions', render: (o) => learnActions('opportunity', o) },
  ], data.items, 'Aucune opportunité. Ajoutez-en une après avoir lu ses conditions officielles.');
}

async function handleLearnSubmit(name, event) {
  event.preventDefault();
  const editor = learnEditors[name];
  showAlert(editor.error, '');
  const values = readForm(event.target);
  try {
    if (editor.editing) {
      await api(`${editor.api}/${encodeURIComponent(editor.editing)}`, { method: 'PATCH', body: JSON.stringify(values) });
      toast(`Modification enregistrée : ce ${editor.label === 'contenu' ? 'contenu' : 'élément'} doit être vérifié à nouveau.`);
    } else {
      await api(editor.api, { method: 'POST', body: JSON.stringify(values) });
      toast('Brouillon créé. Vérifiez-le avant de le publier.');
    }
    resetEditor(name);
    await LOADERS[name === 'content' ? 'content' : 'opportunities']();
  } catch (error) {
    if (error.status === 400 || error.status === 409) showAlert(editor.error, error.message);
    else handleError(error);
  }
}

function renderReferralState(ready) {
  $('referral-state').replaceChildren(ready
    ? h('p', null, badge('Visible', 'ok'), ' Le lien de parrainage est affiché aux membres.')
    : h('p', null, badge('Masqué', 'warn'), ' Remplissez tous les champs pour afficher le lien aux membres.'));
}

async function loadReferral() {
  const data = await api('/api/admin/learn/settings');
  fillForm($('referral-form'), data.settings);
  renderReferralState(data.referral_ready);
}

async function handleReferralSubmit(event) {
  event.preventDefault();
  showAlert('referral-error', '');
  try {
    const data = await api('/api/admin/learn/settings', { method: 'PUT', body: JSON.stringify(readForm(event.target)) });
    fillForm($('referral-form'), data.settings);
    renderReferralState(data.referral_ready);
    toast('Réglages enregistrés.');
  } catch (error) {
    if (error.status === 400) showAlert('referral-error', error.message);
    else handleError(error);
  }
}

// ---------------------------------------------------------------------------
// Modération des offres des membres
// ---------------------------------------------------------------------------

const REPORT_REASON_LABELS = {
  misleading: 'Trompeuse', spam: 'Spam', dangerous: 'Dangereuse', minors: 'Inadaptée aux mineurs', rights: 'Droits', signup_exchange: 'Échange d’inscriptions', other: 'Autre',
};
const MEMBER_STATUS_BADGES = {
  pending: ['En attente', 'warn'], published: ['Publiée', 'ok'], rejected: ['Refusée', 'bad'], removed: ['Retirée', 'muted'],
};
state.moderationFilter = 'pending';

async function moderate(offer, decision) {
  let note = null;
  if (decision !== 'publish') {
    note = window.prompt(decision === 'reject' ? 'Motif du refus (montré à l’auteur) :' : 'Motif du retrait (montré à l’auteur) :');
    if (note === null) return;
    if (!note.trim()) { toast('Un motif est obligatoire.', 'error'); return; }
  } else if (!(await confirmAction('Publier cette offre ?', `« ${offer.title} » sera visible par tous les membres. As-tu vérifié le lien (${offer.domain}), la description, l’âge et les pays ?`, 'Publier'))) {
    return;
  }
  try {
    await api(`/api/admin/community/offers/${encodeURIComponent(offer.id)}/moderate`, {
      method: 'POST', body: JSON.stringify({ decision, note }),
    });
    toast(decision === 'publish' ? 'Offre publiée.' : decision === 'reject' ? 'Offre refusée.' : 'Offre retirée.');
    await loadModeration();
  } catch (error) {
    if (error.status === 400) toast(error.message, 'error');
    else handleError(error);
  }
}

/** Fiche campagne : 24 h de visibilité de plus (journalisé côté serveur). */
async function extendOffer(offer) {
  try {
    await api(`/api/admin/community/offers/${encodeURIComponent(offer.id)}/extend`, { method: 'POST' });
    toast('Fiche prolongée de 24 h.');
    await loadModeration();
  } catch (error) {
    if (error.status === 409) toast(error.message, 'error');
    else handleError(error);
  }
}

function moderationCard(offer) {
  const [label, kind] = MEMBER_STATUS_BADGES[offer.status] || [offer.status, 'muted'];
  const row = (name, value) => (value ? h('li', null, h('span', { className: 'muted' }, `${name} : `), value) : null);
  const actions = [];
  if (offer.status !== 'published') actions.push(h('button', { className: 'btn small primary', type: 'button', onclick: () => moderate(offer, 'publish') }, 'Publier'));
  if (offer.status === 'pending') actions.push(h('button', { className: 'btn small ghost', type: 'button', onclick: () => moderate(offer, 'reject') }, 'Refuser'));
  if (offer.status === 'published' && offer.kind === 'campaign') actions.push(h('button', { className: 'btn small ghost', type: 'button', onclick: () => extendOffer(offer) }, 'Prolonger 24 h'));
  if (offer.status !== 'removed') actions.push(h('button', { className: 'btn small danger', type: 'button', onclick: () => moderate(offer, 'remove') }, 'Retirer'));

  return h('article', { className: 'panel moderation-card' },
    h('div', { className: 'moderation-head' },
      h('strong', null, offer.title),
      badge(label, kind),
      badge(offer.kind === 'affiliate' ? 'Lien affilié' : 'Fiche campagne', offer.kind === 'affiliate' ? 'warn' : 'muted'),
      offer.min_age && offer.min_age >= 18 ? badge(`${offer.min_age} ans et +`, 'bad') : null,
      offer.open_reports ? badge(`${offer.open_reports} signalement${offer.open_reports > 1 ? 's' : ''}`, 'bad') : null),
    h('p', { className: 'muted' }, `@${offer.author.username} · ${offer.category_label} · ${date(offer.updated_at)}`),
    h('p', { className: 'moderation-description' }, offer.description),
    h('ul', { className: 'moderation-meta' },
      row(offer.kind === 'affiliate' ? 'Lien affilié' : 'Page officielle', h('code', { className: 'url' }, offer.url)),
      row('Campagne MyLead', offer.campaign_name),
      row('Visible jusqu’au', offer.expires_at ? `${date(offer.expires_at)}${offer.expired ? ' (expirée)' : ''}` : null),
      row('Conseils', offer.tips),
      row('Domaine', offer.domain),
      row('Action', offer.expected_action),
      row('Pays', offer.countries),
      row('Âge minimum', offer.min_age ? `${offer.min_age} ans` : null),
      row('Rémunération annoncée', offer.payout_text),
      row('Conditions', offer.conditions),
      row('Note', offer.moderation_note)),
    offer.reports?.length ? h('div', { className: 'moderation-reports' },
      h('strong', null, 'Signalements'),
      h('ul', null, offer.reports.map((report) => h('li', null,
        `${REPORT_REASON_LABELS[report.reason] || report.reason} · ${date(report.created_at)}`,
        report.details ? ` — ${report.details}` : '')))) : null,
    h('div', { className: 'row-actions' }, actions));
}

async function loadModeration() {
  document.querySelectorAll('[data-moderation-filter]').forEach((button) => {
    const active = button.dataset.moderationFilter === state.moderationFilter;
    button.classList.toggle('primary', active);
    button.classList.toggle('ghost', !active);
    button.setAttribute('aria-pressed', String(active));
  });
  const data = await api(`/api/admin/community/offers?status=${encodeURIComponent(state.moderationFilter)}`);
  const list = $('moderation-list');
  list.replaceChildren(...(data.items.length
    ? data.items.map(moderationCard)
    : [state.moderationFilter === 'pending'
      ? h('div', { className: 'empty panel mascot-state' }, bear('admin-moderation', 140), h('p', null, 'Tout est traité.'))
      : h('p', { className: 'empty panel' }, 'Aucune offre dans cette liste.')]));
}

// ---------------------------------------------------------------------------
// Catégories des offres
// ---------------------------------------------------------------------------

/*
 * L'identifiant (slug) est immuable : il est inscrit dans chaque offre et dans
 * les liens de recherche partagés. En modification, le champ est donc
 * verrouillé plutôt que masqué, pour qu'on voie toujours de quoi il s'agit.
 */
let editingCategory = null;

function categoryForm() {
  return $('category-form');
}

function resetCategoryForm() {
  editingCategory = null;
  const form = categoryForm();
  form.reset();
  form.querySelector('[data-field="slug"]').readOnly = false;
  form.querySelector('[data-field="position"]').value = '100';
  form.querySelector('[data-field="is_active"]').checked = true;
  $('category-form-title').textContent = 'Nouvelle catégorie';
  $('category-cancel').hidden = true;
  showAlert('category-error', '');
}

function startCategoryEdit(row) {
  editingCategory = row.slug;
  const form = categoryForm();
  fillForm(form, { slug: row.slug, label: row.label, position: row.position, is_active: row.is_active });
  form.querySelector('[data-field="slug"]').readOnly = true;
  $('category-form-title').textContent = `Modifier « ${row.label} »`;
  $('category-cancel').hidden = false;
  showAlert('category-error', '');
  form.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function deleteCategory(row) {
  if (row.offers > 0) {
    toast(`${row.offers} offre(s) utilisent cette catégorie : désactive-la plutôt.`, 'error');
    return;
  }
  const ok = await confirmAction(
    'Supprimer cette catégorie ?',
    `« ${row.label} » disparaîtra des formulaires. Aucune offre ne l'utilise.`,
    'Supprimer'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/community/categories/${encodeURIComponent(row.slug)}`, { method: 'DELETE' });
    toast('Catégorie supprimée.');
    await loadCategories();
  } catch (error) {
    if (error.status === 409) toast(error.message, 'error');
    else handleError(error);
  }
}

async function toggleCategory(row) {
  try {
    await api(`/api/admin/community/categories/${encodeURIComponent(row.slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: row.label, position: row.position, is_active: !row.is_active }),
    });
    toast(row.is_active ? 'Catégorie désactivée.' : 'Catégorie proposée aux membres.');
    await loadCategories();
  } catch (error) {
    handleError(error);
  }
}

async function handleCategorySubmit(event) {
  event.preventDefault();
  showAlert('category-error', '');
  const values = readForm(categoryForm());
  const payload = {
    label: values.label,
    position: values.position === null ? 100 : Number(values.position),
    is_active: categoryForm().querySelector('[data-field="is_active"]').checked,
  };
  try {
    if (editingCategory) {
      await api(`/api/admin/community/categories/${encodeURIComponent(editingCategory)}`, {
        method: 'PATCH', body: JSON.stringify(payload),
      });
      toast('Catégorie modifiée.');
    } else {
      await api('/api/admin/community/categories', {
        method: 'POST', body: JSON.stringify({ ...payload, slug: values.slug }),
      });
      toast('Catégorie créée.');
    }
    resetCategoryForm();
    await loadCategories();
  } catch (error) {
    showAlert('category-error', error.message);
  }
}

async function loadCategories() {
  const data = await api('/api/admin/community/categories');
  renderTable('categories-table', [
    { label: 'Identifiant', render: (row) => h('code', null, row.slug) },
    { label: 'Nom affiché', render: (row) => row.label },
    { label: 'Ordre', render: (row) => num(row.position) },
    { label: 'Offres', render: (row) => num(row.offers) },
    {
      label: 'État',
      render: (row) => (row.is_active ? badge('Proposée', 'ok') : badge('Désactivée', 'muted')),
    },
    {
      label: 'Actions',
      render: (row) => h('div', { className: 'row-actions' },
        h('button', { className: 'btn small ghost', type: 'button', onclick: () => startCategoryEdit(row) }, 'Modifier'),
        h('button', { className: 'btn small ghost', type: 'button', onclick: () => toggleCategory(row) },
          row.is_active ? 'Désactiver' : 'Proposer'),
        // Supprimer n'a de sens que sur une catégorie qu'aucune offre n'utilise.
        row.offers === 0
          ? h('button', { className: 'btn small danger', type: 'button', onclick: () => deleteCategory(row) }, 'Supprimer')
          : null),
    },
  ], data.items, 'Aucune catégorie. Ajoutez-en une ci-dessus.');
}

// ---------------------------------------------------------------------------
// Messages des membres
// ---------------------------------------------------------------------------

/*
 * Boîte de réception de l'équipe. Contenu des membres affiché en texte brut
 * (h() crée des nœuds texte) : aucun lien cliquable, aucun HTML interprété.
 */
state.inboxOpen = null;

/*
 * Bandeau de l'onglet Messages : proposé tant que cet appareil n'a pas
 * d'abonnement Web Push. Même logique que l'espace membre (push-client.js),
 * permission demandée seulement au clic.
 */
const pushApi = (url, { method = 'GET', body } = {}) => api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

async function renderPushBanner() {
  const banner = $('push-banner');
  const Push = window.HaisselPush;
  const supported = Push && 'Notification' in window && Push.canPush(navigator);
  if (!supported) { banner.hidden = true; return; }
  let config;
  try { config = await api('/api/push/config'); } catch (error) { banner.hidden = true; return; }
  if (!config.enabled || await Push.current(navigator)) { banner.hidden = true; return; }
  const denied = window.Notification.permission === 'denied';
  $('push-banner-text').textContent = denied
    ? 'Notifications bloquées pour ce site : autorise-les dans les réglages du navigateur.'
    : 'Active les notifications pour être prévenu des nouveaux messages';
  $('push-banner-button').hidden = denied;
  banner.hidden = false;
}

async function enablePushFromBanner() {
  const button = $('push-banner-button');
  button.disabled = true;
  try {
    const config = await api('/api/push/config');
    const result = await window.HaisselPush.enable({
      nav: navigator, Notif: window.Notification, api: pushApi, publicKey: config.public_key,
    });
    if (result === 'subscribed') toast('Notifications activées sur cet appareil.');
    else if (result === 'error') toast('Activation impossible pour le moment.', 'error');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    await renderPushBanner();
  }
}

async function loadInbox() {
  renderPushBanner().catch(() => {});
  const data = await api('/api/admin/messages');
  const list = $('inbox-list');
  list.replaceChildren(...(data.items.length ? data.items.map((item) => h('li', null,
    h('button', {
      className: `inbox-item${item.unread ? ' unread' : ''}${state.inboxOpen === item.id ? ' active' : ''}`, type: 'button',
      onclick: () => openInboxThread(item.id).catch(handleError),
    },
    h('strong', null, `@${item.username}`),
    item.unread ? badge(`${item.unread} non lu${item.unread > 1 ? 's' : ''}`, 'bad') : null,
    h('span', { className: 'muted' }, `${item.last_from_team ? 'Équipe : ' : ''}${item.preview}`),
    h('small', { className: 'muted' }, date(item.last_message_at)))))
    : [h('li', { className: 'empty mascot-state' }, bear('admin-support', 120), h('p', null, 'Aucune conversation pour le moment.'))]));
  if (state.inboxOpen) await openInboxThread(state.inboxOpen, { refreshList: false });
}

async function openInboxThread(id, { refreshList = true } = {}) {
  state.inboxOpen = id;
  const data = await api(`/api/admin/messages/${encodeURIComponent(id)}`);
  const input = h('textarea', { id: 'inbox-reply', rows: '3', maxlength: '2000', required: true, 'aria-label': 'Réponse' });
  const form = h('form', { className: 'inbox-reply', novalidate: true },
    input,
    h('button', { className: 'btn primary', type: 'submit' }, 'Répondre'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    try {
      await api(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ content }) });
      toast('Réponse envoyée.');
      await loadInbox();
    } catch (error) {
      if (error.status === 400) toast(error.message, 'error');
      else handleError(error);
    }
  });
  const messages = h('div', { className: 'inbox-messages' }, ...data.messages.map((message) => h('div', {
    className: `inbox-bubble ${message.from_team ? 'team' : 'member'}`,
  }, h('p', null, message.content), h('small', { className: 'muted' }, `${message.from_team ? 'Équipe' : `@${data.username}`} · ${date(message.created_at)}`))));
  $('inbox-thread').replaceChildren(h('h2', null, `@${data.username}`), messages, form);
  messages.scrollTop = messages.scrollHeight;
  if (refreshList) await loadInbox();
}

// ---------------------------------------------------------------------------
// Contact : demandes du formulaire /contact (affichées en textContent via h)
// ---------------------------------------------------------------------------
state.contactOpen = null;

async function loadContact() {
  const data = await api('/api/admin/contact');
  state.contactItems = data.items;
  $('contact-list').replaceChildren(...(data.items.length ? data.items.map((item) => h('li', null,
    h('button', {
      className: `inbox-item${item.handled_at ? '' : ' unread'}${state.contactOpen === item.id ? ' active' : ''}`, type: 'button',
      onclick: () => openContact(item.id),
    },
    h('strong', null, item.subject_label),
    item.handled_at ? badge('Traitée', 'ok') : badge('À traiter', 'bad'),
    h('span', { className: 'muted' }, item.message.slice(0, 120)),
    h('small', { className: 'muted' }, date(item.created_at)))))
    : [h('li', { className: 'empty' }, 'Aucune demande pour le moment.')]));
  if (state.contactOpen) openContact(state.contactOpen, { refreshList: false });
}

function openContact(id, { refreshList = true } = {}) {
  state.contactOpen = id;
  const item = (state.contactItems || []).find((row) => row.id === id);
  if (!item) return;
  const from = item.username ? `@${item.username}${item.account_email ? ` (${item.account_email})` : ''}` : 'Visiteur sans compte';
  const button = h('button', { className: 'btn primary', type: 'button', disabled: Boolean(item.handled_at) },
    item.handled_at ? `Traitée le ${date(item.handled_at)}` : 'Marquer comme traité');
  button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/contact/${encodeURIComponent(id)}/handled`, { method: 'POST', body: '{}' });
      toast('Demande marquée comme traitée.');
      await loadContact();
    } catch (error) {
      handleError(error);
    }
  });
  $('contact-detail').replaceChildren(
    h('h2', null, item.subject_label),
    h('p', { className: 'muted' }, `${from} · ${date(item.created_at)}`),
    h('p', null, `Répondre à : ${item.reply_email || (item.username ? 'onglet Messages du membre' : '—')}`),
    h('p', { className: 'contact-message' }, item.message),
    button);
  if (refreshList) loadContact().catch(handleError);
}

const LOADERS = {
  dashboard: loadDashboard,
  links: loadLinks,
  clicks: loadClicks,
  users: loadUsers,
  notifications: loadNotifications,
  content: loadContent,
  opportunities: loadOpportunities,
  referral: loadReferral,
  moderation: loadModeration,
  inbox: loadInbox,
  contact: loadContact,
  categories: loadCategories,
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function bindEvents() {
  $('category-form').addEventListener('submit', handleCategorySubmit);
  $('category-cancel').addEventListener('click', resetCategoryForm);
  $('login-form').addEventListener('submit', handleLogin);
  $('mfa-form').addEventListener('submit', handleMfa);
  $('mfa-cancel').addEventListener('click', handleLogout);
  $('setup-start-form').addEventListener('submit', handleSetupStart);
  $('setup-confirm-form').addEventListener('submit', handleSetupConfirm);
  $('setup-continue').addEventListener('click', () => routeAfterAuth().catch((error) => showLogin(error.message)));
  $('setup-logout').addEventListener('click', handleLogout);
  $('admin-logout').addEventListener('click', handleLogout);
  $('push-test').addEventListener('click', sendPushTest);
  $('push-banner-button').addEventListener('click', enablePushFromBanner);
  $('link-form').addEventListener('submit', handleLinkSubmit);
  $('users-search-form').addEventListener('submit', handleUsersSearch);
  $('notif-form').addEventListener('submit', handleNotifSubmit);
  $('content-form').addEventListener('submit', (event) => handleLearnSubmit('content', event));
  $('opportunity-form').addEventListener('submit', (event) => handleLearnSubmit('opportunity', event));
  $('referral-form').addEventListener('submit', handleReferralSubmit);
  document.querySelectorAll('[data-moderation-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.moderationFilter = button.dataset.moderationFilter;
      loadModeration().catch(handleError);
    });
  });
  document.querySelectorAll('[data-cancel-edit]').forEach((button) => {
    button.addEventListener('click', () => resetEditor(button.dataset.cancelEdit));
  });
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
  // Widget anti-robot : clé PUBLIQUE de /api/auth/config ; sans clé, rien ne change.
  try {
    const config = await api('/api/auth/config');
    if (window.HaisselTurnstile) window.HaisselTurnstile.init(config.turnstile_site_key);
  } catch (error) { /* configuration indisponible : connexion sans widget */ }
  try {
    await routeAfterAuth();
  } catch (error) {
    if (error.code === 'FORBIDDEN') await revokeCurrentSession();
    showLogin(error.status === 401 ? '' : error.message);
  }
}

document.addEventListener('DOMContentLoaded', init);
