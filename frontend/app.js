'use strict';

/*
 * Espace utilisateur HAISSEL.
 *
 * Toutes les données venant du serveur sont insérées via textContent
 * (fonction h) : aucune n'est interprétée comme du HTML.
 * Les statistiques affichées proviennent exclusivement de l'API.
 */

const STORAGE_TOKEN_KEY = 'haissel_token';
const STORAGE_USER_KEY = 'haissel_user';
const LEGACY_TOKEN_KEY = 'lycee_token';

const state = {
  token: storageGet(STORAGE_TOKEN_KEY) || '',
  user: readStoredUser(),
  offers: [],
  stats: null,
  conversions: [],
  activeView: 'dashboard',
};

const ui = {};

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}

function storageSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (error) { /* stockage indisponible */ }
}

function readStoredUser() {
  try {
    return JSON.parse(storageGet(STORAGE_USER_KEY) || 'null');
  } catch (error) {
    storageSet(STORAGE_USER_KEY, '');
    return null;
  }
}

function setStoredSession(token, user) {
  state.token = token || '';
  state.user = user || null;
  storageSet(STORAGE_TOKEN_KEY, state.token);
  storageSet(STORAGE_USER_KEY, state.user ? JSON.stringify(state.user) : '');
  storageSet(LEGACY_TOKEN_KEY, '');
}

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

const moneyFormatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

function formatMoney(cents) {
  return moneyFormatter.format(Number(cents || 0) / 100);
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('fr-FR') : '—';
}

function initialsFromName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0].toUpperCase()).join('') || 'H';
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK', 'Serveur injoignable. Vérifiez votre connexion.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error?.message === 'string' ? payload.error.message : 'Une erreur est survenue.';
    const error = new ApiError(response.status, payload.error?.code || 'ERROR', message);
    // Session expirée ou révoquée (compte suspendu, déconnexion ailleurs…)
    if (response.status === 401 && state.user && !url.startsWith('/api/auth/')) {
      renderLoggedOut();
      setAuthError('Votre session a expiré. Veuillez vous reconnecter.');
    }
    throw error;
  }
  return payload.data;
}

function setAuthError(message) {
  ui.authError.textContent = message || '';
  ui.authError.classList.toggle('hidden', !message);
}

function setLinkFeedback(message) {
  ui.linkFeedback.textContent = message || '';
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function updateUserSummary() {
  const displayName = state.user?.display_name || state.user?.username || 'Utilisateur';
  const initials = initialsFromName(displayName);

  ui.sidebarName.textContent = state.user ? displayName : 'Bonjour';
  ui.sidebarEmail.textContent = state.user?.email || 'Connectez-vous';
  ui.welcomeName.textContent = displayName.split(' ')[0];
  ui.profileDisplayName.textContent = displayName;
  ui.profileUsername.textContent = `@${state.user?.username || ''}`;
  ui.profileEmail.textContent = state.user?.email || '—';
  ui.profileFullName.textContent = state.user?.display_name || '—';
  ui.profileCreatedAt.textContent = formatDate(state.user?.created_at);
  ui.sidebarAvatar.textContent = initials;
  ui.profileAvatar.textContent = initials;

  ui.statusBadge.textContent = state.user ? 'En ligne' : 'Connexion';
  ui.statusBadge.classList.toggle('offline', !state.user);
  ui.logoutButton.classList.toggle('hidden', !state.user);
}

function setActiveView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.nav-button').forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `${viewName}-view`);
  });
}

function toggleAuthForm(formName) {
  const isLogin = formName === 'login';
  document.querySelectorAll('.tab-button').forEach((button) => {
    const active = button.dataset.form === formName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  ui.loginForm.classList.toggle('hidden', !isLogin);
  ui.registerForm.classList.toggle('hidden', isLogin);
  setAuthError('');
}

function renderLoggedOut() {
  setStoredSession('', null);
  state.offers = [];
  state.stats = null;
  state.conversions = [];
  ui.authScreen.classList.remove('hidden');
  ui.appScreen.classList.add('hidden');
  updateUserSummary();
  setActiveView('dashboard');
  renderStats();
}

function renderLoggedIn() {
  ui.authScreen.classList.add('hidden');
  ui.appScreen.classList.remove('hidden');
  updateUserSummary();
  setActiveView(state.activeView || 'dashboard');
}

function renderStats() {
  const stats = state.stats || {};
  const clicks = Number(stats.total_clicks || 0);
  const conversions = Number(stats.total_conversions || 0);
  const earnings = Number(stats.total_earnings || 0);
  const rate = Number(stats.conversion_rate || 0);

  for (const node of [ui.metricClicks, ui.statsClicks, ui.miniClicks]) node.textContent = clicks.toLocaleString('fr-FR');
  for (const node of [ui.metricConversions, ui.statsConversions, ui.miniConversions]) node.textContent = conversions.toLocaleString('fr-FR');
  for (const node of [ui.metricEarnings, ui.statsEarnings, ui.miniEarnings]) node.textContent = formatMoney(earnings);
  for (const node of [ui.metricRate, ui.statsRate]) node.textContent = formatPercent(rate);

  ui.metricClicksDelta.textContent = 'Visites de vos liens';
  ui.metricConversionsDelta.textContent = stats.pending_conversions
    ? `${stats.pending_conversions} en attente de confirmation`
    : 'Confirmées par les partenaires';
  ui.metricEarningsDelta.textContent = `dont ${formatMoney(stats.paid_earnings || 0)} versés`;
  ui.metricRateDelta.textContent = 'Conversions / clics';
}

function offerCard(offer, { compact = false } = {}) {
  const hasCode = Boolean(offer.code);
  return h('article', { className: 'offer-card' },
    h('div', { className: 'offer-logo', 'aria-hidden': 'true' }, (offer.name || 'H').charAt(0).toUpperCase()),
    h('div', { className: 'offer-body' },
      h('div', { className: 'offer-header-line' },
        h('h4', null, offer.name),
        h('span', { className: 'pill' }, hasCode ? offer.code : 'Active')),
      compact ? null : h('p', null, offer.description || 'Aucune description.'),
      h('div', { className: 'offer-meta' },
        h('span', null, `${offer.total_clicks} clic${offer.total_clicks > 1 ? 's' : ''}`),
        h('span', null, `${offer.total_conversions} conversion${offer.total_conversions > 1 ? 's' : ''}`),
        h('strong', null, formatMoney(offer.total_amount_cents))),
      h('div', { className: 'offer-footer' },
        h('button', {
          className: 'offer-link-button',
          type: 'button',
          onclick: () => selectOffer(offer.id, { generate: true }),
        }, hasCode ? 'Voir mon lien' : 'Obtenir mon lien'),
        hasCode ? h('button', {
          className: 'secondary-button',
          type: 'button',
          onclick: () => copyText(buildAffiliateLink(offer.code)),
        }, 'Copier le lien') : null)));
}

function renderOffers() {
  const emptyMessage = 'Aucune offre n’est disponible pour le moment.';

  ui.dashboardOffers.replaceChildren(...(state.offers.length
    ? state.offers.slice(0, 3).map((offer) => offerCard(offer, { compact: true }))
    : [h('div', { className: 'panel-card' }, emptyMessage)]));

  ui.offersList.replaceChildren(...(state.offers.length
    ? state.offers.map((offer) => offerCard(offer))
    : [h('div', { className: 'panel-card' }, emptyMessage)]));

  const previous = ui.affiliateOfferSelect.value;
  ui.affiliateOfferSelect.replaceChildren(...(state.offers.length
    ? state.offers.map((offer) => h('option', { value: offer.id }, offer.name))
    : [h('option', { value: '' }, 'Aucune offre')]));
  if (state.offers.some((offer) => String(offer.id) === previous)) {
    ui.affiliateOfferSelect.value = previous;
  }
  renderAffiliateLink();
}

function buildAffiliateLink(code) {
  // L'origine courante est utilisée : le lien fonctionne quel que soit
  // le réseau / l'adresse IP du serveur.
  return `${window.location.origin}/r/${encodeURIComponent(code)}`;
}

function currentOffer() {
  return state.offers.find((offer) => String(offer.id) === ui.affiliateOfferSelect.value) || null;
}

function renderAffiliateLink() {
  const offer = currentOffer();
  const hasCode = Boolean(offer?.code);
  ui.affiliateLinkInput.value = hasCode ? buildAffiliateLink(offer.code) : '';
  ui.copyLinkButton.disabled = !hasCode;
  ui.generateLinkButton.classList.toggle('hidden', !offer || hasCode);
  setLinkFeedback('');
}

function renderTable(container, columns, rows, emptyMessage) {
  if (!rows.length) {
    container.replaceChildren(h('p', { className: 'empty-text' }, emptyMessage));
    return;
  }
  container.replaceChildren(h('table', null,
    h('thead', null, h('tr', null, columns.map((col) => h('th', { scope: 'col' }, col.label)))),
    h('tbody', null, rows.map((row) => h('tr', null, columns.map((col) => h('td', { 'data-label': col.label }, col.render(row))))))));
}

const CONVERSION_LABELS = {
  pending: 'En attente',
  approved: 'Confirmée',
  rejected: 'Refusée',
  cancelled: 'Annulée',
};

function renderStatsTables() {
  renderTable(ui.statsTableWrap, [
    { label: 'Offre', render: (row) => (row.offer_active ? row.offer_name : `${row.offer_name} (inactive)`) },
    { label: 'Code', render: (row) => h('span', { className: 'code-pill' }, row.code) },
    { label: 'Clics', render: (row) => row.total_clicks },
    { label: 'Conversions', render: (row) => row.total_conversions },
    { label: 'Taux', render: (row) => formatPercent(row.conversion_rate) },
    { label: 'Gains', render: (row) => formatMoney(row.total_amount_cents) },
  ], state.stats?.codes || [], 'Aucune donnée pour le moment. Obtenez un lien depuis la page Offres.');

  renderTable(ui.conversionsTableWrap, [
    { label: 'Date', render: (row) => formatDate(row.created_at) },
    { label: 'Offre', render: (row) => row.offer_name },
    { label: 'Montant', render: (row) => formatMoney(row.amount_cents) },
    { label: 'Statut', render: (row) => h('span', { className: `status-tag ${row.status}` }, CONVERSION_LABELS[row.status] || row.status) },
  ], state.conversions, 'Aucune conversion pour le moment.');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function loadDashboardData() {
  try {
    const [offers, stats, conversions] = await Promise.all([
      fetchJson('/api/affiliate/offers?limit=50'),
      fetchJson('/api/affiliate/stats'),
      fetchJson('/api/affiliate/conversions?limit=20'),
    ]);
    state.offers = offers.items || [];
    state.stats = stats || {};
    state.conversions = conversions.items || [];
    renderStats();
    renderOffers();
    renderStatsTables();
  } catch (error) {
    if (error.status !== 401) {
      ui.offersList.replaceChildren(h('div', { className: 'panel-card' }, `Impossible de charger vos données : ${error.message}`));
    }
  }
}

async function selectOffer(offerId, { generate = false } = {}) {
  setActiveView('link');
  ui.affiliateOfferSelect.value = String(offerId);
  renderAffiliateLink();
  if (generate && !currentOffer()?.code) await generateLink();
}

async function generateLink() {
  const offer = currentOffer();
  if (!offer) return;
  ui.generateLinkButton.disabled = true;
  try {
    const data = await fetchJson(`/api/affiliate/offers/${encodeURIComponent(offer.id)}/link`, { method: 'POST' });
    offer.code = data.code;
    offer.code_id = data.code_id;
    renderOffers();
    ui.affiliateOfferSelect.value = String(offer.id);
    renderAffiliateLink();
    setLinkFeedback('Votre lien personnel est prêt.');
  } catch (error) {
    setLinkFeedback(error.message);
    if (error.code === 'OFFER_NOT_AVAILABLE') await loadDashboardData();
  } finally {
    ui.generateLinkButton.disabled = false;
  }
}

async function copyText(value) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setLinkFeedback('Lien copié dans le presse-papiers.');
  } catch (error) {
    // navigator.clipboard est indisponible en HTTP hors localhost : sélection manuelle.
    ui.affiliateLinkInput.value = value;
    setActiveView('link');
    ui.affiliateLinkInput.focus();
    ui.affiliateLinkInput.select();
    try {
      document.execCommand('copy');
      setLinkFeedback('Lien copié dans le presse-papiers.');
    } catch (fallbackError) {
      setLinkFeedback('Copie automatique impossible : le lien est sélectionné, utilisez Ctrl+C.');
    }
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const identifier = ui.loginIdentifier.value.trim();
  const password = ui.loginPassword.value;
  if (!identifier || !password) {
    setAuthError('Remplissez tous les champs.');
    return;
  }

  try {
    setAuthError('');
    const data = await fetchJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    });
    ui.loginPassword.value = '';
    setStoredSession(data.token, data.user);
    renderLoggedIn();
    await loadDashboardData();
  } catch (error) {
    setAuthError(error.message);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const value = (id) => document.getElementById(id).value;
  const payload = {
    first_name: value('register-first-name').trim(),
    last_name: value('register-last-name').trim(),
    username: value('register-username').trim(),
    email: value('register-email').trim(),
    password: value('register-password'),
    confirm_password: value('register-confirm-password'),
  };

  if (Object.values(payload).some((field) => !field)) {
    setAuthError('Tous les champs sont obligatoires.');
    return;
  }
  if (payload.password.length < 8) {
    setAuthError('Le mot de passe doit contenir au moins 8 caractères.');
    return;
  }
  if (payload.password !== payload.confirm_password) {
    setAuthError('La confirmation ne correspond pas.');
    return;
  }

  try {
    setAuthError('');
    const data = await fetchJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    ui.registerForm.reset();
    setStoredSession(data.token, data.user);
    renderLoggedIn();
    await loadDashboardData();
  } catch (error) {
    setAuthError(error.message);
  }
}

async function handleLogout() {
  try {
    await fetchJson('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    // Session déjà invalide côté serveur : on nettoie quand même.
  }
  renderLoggedOut();
}

async function hydrateSession() {
  if (!state.token) {
    renderLoggedOut();
    return;
  }
  try {
    const data = await fetchJson('/api/auth/me');
    setStoredSession(state.token, data.user);
    renderLoggedIn();
    await loadDashboardData();
  } catch (error) {
    renderLoggedOut();
    if (error.status !== 401) setAuthError(error.message);
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const ids = {
    statusBadge: 'status-badge', logoutButton: 'logout-button', authScreen: 'auth-screen',
    appScreen: 'app-screen', authError: 'auth-error', loginForm: 'login-form',
    registerForm: 'register-form', loginIdentifier: 'login-identifier', loginPassword: 'login-password',
    sidebarName: 'sidebar-name', sidebarEmail: 'sidebar-email', sidebarAvatar: 'sidebar-avatar',
    welcomeName: 'welcome-name', profileDisplayName: 'profile-display-name', profileUsername: 'profile-username',
    profileEmail: 'profile-email', profileFullName: 'profile-full-name', profileCreatedAt: 'profile-created-at',
    profileAvatar: 'profile-avatar', metricClicks: 'metric-clicks', metricConversions: 'metric-conversions',
    metricEarnings: 'metric-earnings', metricRate: 'metric-rate', metricClicksDelta: 'metric-clicks-delta',
    metricConversionsDelta: 'metric-conversions-delta', metricEarningsDelta: 'metric-earnings-delta',
    metricRateDelta: 'metric-rate-delta', dashboardOffers: 'dashboard-offers', offersList: 'offers-list',
    affiliateOfferSelect: 'affiliate-offer-select', affiliateLinkInput: 'affiliate-link-input',
    copyLinkButton: 'copy-link-button', generateLinkButton: 'generate-link-button', linkFeedback: 'link-feedback',
    statsTableWrap: 'stats-table-wrap', conversionsTableWrap: 'conversions-table-wrap',
    miniClicks: 'mini-clicks', miniConversions: 'mini-conversions', miniEarnings: 'mini-earnings',
    statsClicks: 'stats-clicks', statsConversions: 'stats-conversions', statsEarnings: 'stats-earnings',
    statsRate: 'stats-rate', profileLogout: 'profile-logout',
  };
  for (const [key, id] of Object.entries(ids)) ui[key] = document.getElementById(id);

  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => toggleAuthForm(button.dataset.form));
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.view));
  });

  ui.loginForm.addEventListener('submit', handleLogin);
  ui.registerForm.addEventListener('submit', handleRegister);
  ui.logoutButton.addEventListener('click', handleLogout);
  ui.profileLogout.addEventListener('click', handleLogout);
  ui.generateLinkButton.addEventListener('click', generateLink);
  ui.copyLinkButton.addEventListener('click', () => copyText(ui.affiliateLinkInput.value));
  ui.affiliateOfferSelect.addEventListener('change', renderAffiliateLink);

  hydrateSession();
});
