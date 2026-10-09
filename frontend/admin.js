'use strict';

/*
 * Console d'administration HAISSEL.
 *
 * Sécurité : ce script ne décide d'AUCUNE permission. Le serveur vérifie à
 * chaque requête l'origine locale, la session et le rôle ADMIN. Ici, toutes
 * les données sont insérées via textContent (fonction h) : aucune donnée
 * issue de la base n'est interprétée comme du HTML.
 */

const TOKEN_KEY = 'haissel_admin_token';
const PAGE_SIZE = 20;

const state = {
  token: readToken(),
  user: null,
  section: 'dashboard',
  pages: { users: 1, conversions: 1, earnings: 1, clicks: 1 },
  offers: [],
};

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (error) { return ''; }
}

function saveToken(token) {
  state.token = token || '';
  try {
    if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (error) { /* stockage indisponible : session limitée à l'onglet */ }
}

const $ = (id) => document.getElementById(id);

/** Création d'élément sûre : les chaînes deviennent des nœuds texte. */
function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
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
const numberFormatter = new Intl.NumberFormat('fr-FR');

function money(cents) { return moneyFormatter.format(Number(cents || 0) / 100); }
function num(value) { return numberFormatter.format(Number(value || 0)); }
function percent(value) { return `${Number(value || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`; }
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
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
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

const STATUS_LABELS = {
  pending: ['En attente', 'warn'],
  approved: ['Approuvée', 'ok'],
  rejected: ['Rejetée', 'bad'],
  cancelled: ['Annulée', 'muted'],
  paid: ['Payé', 'ok'],
};

function badge(label, kind) {
  return h('span', { className: `badge ${kind}` }, label);
}

function statusBadge(status, overrides = {}) {
  const [label, kind] = overrides[status] || STATUS_LABELS[status] || [status, 'muted'];
  return badge(label, kind);
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

function renderPager(containerId, key, pagination, reload) {
  const container = $(containerId);
  container.replaceChildren();
  const total = Number(pagination?.total || 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return;
  const page = state.pages[key];
  const go = (target) => { state.pages[key] = target; reload(); };
  container.append(
    h('button', { className: 'btn ghost small', type: 'button', disabled: page <= 1, onclick: () => go(page - 1) }, 'Précédent'),
    h('span', { className: 'muted' }, `Page ${page} / ${pages} · ${num(total)} éléments`),
    h('button', { className: 'btn ghost small', type: 'button', disabled: page >= pages, onclick: () => go(page + 1) }, 'Suivant')
  );
}

function handleError(error) {
  if (error.status === 401) return;
  if (error.code === 'ADMIN_LOCAL_ONLY' || error.code === 'FORBIDDEN') {
    showLogin(error.message);
    return;
  }
  toast(error.message, 'error');
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

function showLogin(message) {
  state.user = null;
  saveToken('');
  $('admin-shell').hidden = true;
  $('login-screen').hidden = false;
  showAlert('login-error', message);
  $('login-identifier').focus();
}

function showConsole() {
  $('login-screen').hidden = true;
  $('admin-shell').hidden = false;
  $('admin-name').textContent = state.user.display_name || state.user.username;
  openSection(sectionFromHash());
}

async function revokeCurrentSession() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (error) { /* session déjà invalide */ }
}

/**
 * Vérifie la session ET le rôle ADMIN côté serveur (appel /api/admin/overview).
 */
async function verifyAdminSession() {
  const data = await api('/api/auth/me');
  if (data.user.role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', 'Accès administrateur refusé.');
  }
  await api('/api/admin/overview');
  state.user = data.user;
}

async function handleLogin(event) {
  event.preventDefault();
  const identifier = $('login-identifier').value.trim();
  const password = $('login-password').value;
  if (!identifier || !password) {
    showAlert('login-error', 'Renseignez votre identifiant et votre mot de passe.');
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
    saveToken(data.token);

    try {
      await verifyAdminSession();
    } catch (error) {
      // Compte valide mais pas administrateur : la session est révoquée.
      await revokeCurrentSession();
      saveToken('');
      throw error;
    }

    $('login-password').value = '';
    showConsole();
  } catch (error) {
    showAlert('login-error', error.message);
  } finally {
    submit.disabled = false;
  }
}

async function handleLogout() {
  await revokeCurrentSession();
  showLogin('');
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const SECTIONS = ['dashboard', 'users', 'offers', 'conversions', 'earnings', 'clicks', 'activity'];

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
// Dashboard
// ---------------------------------------------------------------------------

function metricCard(label, value, tone, hint) {
  return h('article', { className: `metric-card ${tone}` },
    h('span', { className: 'metric-label' }, label),
    h('strong', { className: 'metric-value' }, value),
    hint ? h('small', { className: 'metric-hint' }, hint) : null);
}

async function loadDashboard() {
  const data = await api('/api/admin/overview');
  $('overview-cards').replaceChildren(
    metricCard('Utilisateurs', num(data.total_users), 'blue', `${num(data.active_users)} actifs`),
    metricCard('Suspendus / bannis', `${num(data.suspended_users)} / ${num(data.banned_users)}`, 'slate'),
    metricCard('Offres', num(data.total_offers), 'violet', `${num(data.active_offers)} actives`),
    metricCard('Clics totaux', num(data.total_clicks), 'cyan'),
    metricCard('Conversions approuvées', num(data.total_conversions), 'green', `${num(data.pending_conversions)} en attente`),
    metricCard('Taux de conversion', percent(data.conversion_rate), 'indigo', 'Conversions / clics'),
    metricCard('Gains totaux', money(data.total_earnings_cents), 'green', 'Dus + payés'),
    metricCard('Gains à payer', money(data.pending_earnings_cents), 'orange', `${money(data.paid_earnings_cents)} déjà payés`)
  );
}

// ---------------------------------------------------------------------------
// Utilisateurs
// ---------------------------------------------------------------------------

const USER_ACTION_TEXT = {
  suspend: ['Suspendre', 'Suspendre {name} ? Ses sessions seront fermées immédiatement.'],
  activate: ['Réactiver', 'Réactiver le compte de {name} ?'],
  ban: ['Bannir', 'Bannir {name} ? Ses sessions seront fermées et ses liens désactivés.'],
  unban: ['Débannir', 'Lever le bannissement de {name} ?'],
};

async function userAction(user, action) {
  const [label, template] = USER_ACTION_TEXT[action];
  const name = user.display_name || user.username;
  const ok = await confirmAction(`${label} ce compte ?`, template.replace('{name}', name), label);
  if (!ok) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(user.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    });
    toast(`${label} : ${name}`);
    await loadUsers();
  } catch (error) {
    handleError(error);
  }
}

async function loadUsers() {
  const params = new URLSearchParams({
    page: state.pages.users,
    limit: PAGE_SIZE,
    search: $('user-search').value.trim(),
    status: $('user-status').value,
  });
  const data = await api(`/api/admin/users?${params}`);
  const selfId = state.user?.id;

  renderTable('users-table', [
    { label: 'Utilisateur', render: (u) => h('div', { className: 'cell-main' }, h('strong', null, u.display_name || u.username), h('small', null, `@${u.username}`)) },
    { label: 'E-mail', render: (u) => u.email },
    { label: 'Inscription', render: (u) => date(u.created_at) },
    { label: 'Rôle', render: (u) => (u.role === 'ADMIN' ? badge('Admin', 'violet') : badge('Utilisateur', 'muted')) },
    { label: 'Statut', render: (u) => (u.is_active ? badge('Actif', 'ok') : badge('Suspendu', 'warn')) },
    { label: 'Bannissement', render: (u) => (u.is_banned ? badge('Banni', 'bad') : badge('Non', 'muted')) },
    {
      label: 'Actions',
      render: (u) => {
        if (u.id === selfId) return h('span', { className: 'muted' }, 'Vous');
        return h('div', { className: 'actions' },
          h('button', { className: 'btn small ghost', type: 'button', onclick: () => userAction(u, u.is_active ? 'suspend' : 'activate') }, u.is_active ? 'Suspendre' : 'Réactiver'),
          h('button', { className: `btn small ${u.is_banned ? 'ghost' : 'danger-ghost'}`, type: 'button', onclick: () => userAction(u, u.is_banned ? 'unban' : 'ban') }, u.is_banned ? 'Débannir' : 'Bannir'));
      },
    },
  ], data.users, 'Aucun utilisateur trouvé.');

  renderPager('users-pager', 'users', data.pagination, () => loadUsers().catch(handleError));
}

// ---------------------------------------------------------------------------
// Offres
// ---------------------------------------------------------------------------

async function toggleOffer(offer) {
  const activate = !offer.is_active;
  const ok = await confirmAction(
    activate ? "Activer l'offre ?" : "Désactiver l'offre ?",
    activate
      ? `« ${offer.name} » sera de nouveau visible par les utilisateurs.`
      : `« ${offer.name} » ne sera plus proposée et ses liens ne redirigeront plus. L'historique est conservé.`,
    activate ? 'Activer' : 'Désactiver'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/affiliates/${encodeURIComponent(offer.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: activate }),
    });
    toast(activate ? 'Offre activée.' : 'Offre désactivée.');
    await loadOffers();
  } catch (error) {
    handleError(error);
  }
}

async function fetchAllOffers() {
  const data = await api('/api/admin/affiliates?limit=100');
  state.offers = data.items;
  return data.items;
}

async function loadOffers() {
  const offers = await fetchAllOffers();
  renderTable('offers-table', [
    { label: 'Offre', render: (o) => h('div', { className: 'cell-main' }, h('strong', null, o.name), h('small', null, o.description || 'Sans description')) },
    { label: 'Destination', render: (o) => h('code', { className: 'url', title: o.url }, o.url) },
    { label: 'Affiliés', render: (o) => num(o.total_affiliates) },
    { label: 'Clics', render: (o) => num(o.total_clicks) },
    { label: 'Conversions', render: (o) => num(o.total_conversions) },
    { label: 'Gains', render: (o) => money(o.total_earnings_cents) },
    { label: 'Statut', render: (o) => (o.is_active ? badge('Active', 'ok') : badge('Inactive', 'muted')) },
    { label: 'Action', render: (o) => h('button', { className: 'btn small ghost', type: 'button', onclick: () => toggleOffer(o) }, o.is_active ? 'Désactiver' : 'Activer') },
  ], offers, 'Aucune offre. Créez la première ci-dessus.');
}

async function handleOfferSubmit(event) {
  event.preventDefault();
  showAlert('offer-error', '');
  const payload = {
    name: $('offer-name').value.trim(),
    url: $('offer-url').value.trim(),
    description: $('offer-description').value.trim(),
  };
  if (!payload.name || !payload.url) {
    showAlert('offer-error', 'Le nom et l’URL sont obligatoires.');
    return;
  }
  try {
    await api('/api/admin/affiliates', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    toast('Offre créée.');
    await loadOffers();
  } catch (error) {
    if (error.status === 400) showAlert('offer-error', error.message);
    else handleError(error);
  }
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

const CONVERSION_ACTIONS = {
  pending: [['approved', 'Approuver', 'ghost'], ['rejected', 'Rejeter', 'danger-ghost']],
  approved: [['cancelled', 'Annuler', 'danger-ghost']],
};

async function changeConversion(conversion, status, label) {
  const ok = await confirmAction(
    `${label} la conversion #${conversion.id} ?`,
    status === 'approved'
      ? `Un gain de ${money(conversion.amount_cents)} sera crédité à ${conversion.username}.`
      : `Le gain associé éventuel sera annulé. Cette action est journalisée et irréversible.`,
    label
  );
  if (!ok) return;
  try {
    await api(`/api/admin/conversions/${encodeURIComponent(conversion.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    toast(`Conversion #${conversion.id} mise à jour.`);
    await loadConversions();
  } catch (error) {
    handleError(error);
  }
}

async function ensureOfferFilter() {
  const select = $('conv-offer');
  if (select.options.length > 1) return;
  const offers = state.offers.length ? state.offers : await fetchAllOffers();
  select.append(...offers.map((offer) => h('option', { value: offer.id }, offer.name)));
}

async function loadConversions() {
  await ensureOfferFilter();
  const params = new URLSearchParams({ page: state.pages.conversions, limit: PAGE_SIZE });
  const filters = {
    status: $('conv-status').value,
    offer_id: $('conv-offer').value,
    user: $('conv-user').value.trim(),
    from: $('conv-from').value,
    to: $('conv-to').value,
  };
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);

  const data = await api(`/api/admin/conversions?${params}`);
  renderTable('conversions-table', [
    { label: 'ID', render: (c) => `#${c.id}` },
    { label: 'Utilisateur', render: (c) => c.username },
    { label: 'Offre', render: (c) => c.offer_name },
    { label: 'Code', render: (c) => h('code', null, c.code || '—') },
    { label: 'Référence', render: (c) => h('div', { className: 'cell-main' }, h('span', null, c.external_reference || '—'), h('small', null, c.provider)) },
    { label: 'Montant', render: (c) => money(c.amount_cents) },
    { label: 'Devise', render: (c) => c.currency },
    { label: 'Statut', render: (c) => statusBadge(c.status) },
    { label: 'Date', render: (c) => date(c.created_at) },
    {
      label: 'Actions',
      render: (c) => {
        const actions = CONVERSION_ACTIONS[c.status] || [];
        if (c.status === 'approved' && c.earning_status === 'paid') return h('span', { className: 'muted' }, 'Payée');
        if (!actions.length) return h('span', { className: 'muted' }, '—');
        return h('div', { className: 'actions' }, actions.map(([status, label, tone]) => h('button', {
          className: `btn small ${tone}`, type: 'button', onclick: () => changeConversion(c, status, label),
        }, label)));
      },
    },
  ], data.items, 'Aucune conversion pour ces critères.');

  renderPager('conversions-pager', 'conversions', data.pagination, () => loadConversions().catch(handleError));
}

async function handleManualSubmit(event) {
  event.preventDefault();
  showAlert('manual-error', '');
  const amount = Number.parseFloat(String($('manual-amount').value).replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0) {
    showAlert('manual-error', 'Montant invalide.');
    return;
  }
  const payload = {
    code: $('manual-code').value.trim().toUpperCase(),
    external_reference: $('manual-reference').value.trim(),
    amount_cents: Math.round(amount * 100),
    currency: 'EUR',
    status: $('manual-status').value,
  };
  const ok = await confirmAction(
    'Enregistrer cette conversion ?',
    `${payload.code} · ${payload.external_reference} · ${money(payload.amount_cents)} (${payload.status === 'approved' ? 'approuvée' : 'en attente'}). L'opération est journalisée.`,
    'Enregistrer'
  );
  if (!ok) return;
  try {
    const data = await api('/api/admin/conversions', { method: 'POST', body: JSON.stringify(payload) });
    event.target.reset();
    toast(data.created ? 'Conversion enregistrée.' : 'Cette référence existait déjà : aucun doublon créé.', data.created ? 'success' : 'warn');
    await loadConversions();
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403) showAlert('manual-error', error.message);
    else handleError(error);
  }
}

// ---------------------------------------------------------------------------
// Gains
// ---------------------------------------------------------------------------

async function payEarning(earning) {
  const ok = await confirmAction(
    'Marquer comme payé ?',
    `Confirmez le versement de ${money(earning.amount_cents)} à ${earning.username}. La date de paiement sera enregistrée.`,
    'Marquer payé'
  );
  if (!ok) return;
  try {
    await api(`/api/admin/earnings/${encodeURIComponent(earning.id)}/pay`, { method: 'PATCH' });
    toast('Paiement enregistré.');
    await loadEarnings();
  } catch (error) {
    handleError(error);
  }
}

async function loadEarnings() {
  const params = new URLSearchParams({ page: state.pages.earnings, limit: PAGE_SIZE });
  if ($('earning-status').value) params.set('status', $('earning-status').value);
  const data = await api(`/api/admin/earnings?${params}`);

  $('earnings-cards').replaceChildren(
    metricCard('Gains totaux', money(data.summary.total), 'green', 'Dus + payés'),
    metricCard('À payer', money(data.summary.pending), 'orange'),
    metricCard('Payés', money(data.summary.paid), 'blue'),
    metricCard('Annulés', money(data.summary.cancelled), 'slate')
  );

  renderTable('earnings-table', [
    { label: 'ID', render: (e) => `#${e.id}` },
    { label: 'Utilisateur', render: (e) => e.username },
    { label: 'Offre', render: (e) => e.offer_name },
    { label: 'Conversion', render: (e) => (e.conversion_id ? `#${e.conversion_id}` : '—') },
    { label: 'Montant', render: (e) => money(e.amount_cents) },
    { label: 'Statut', render: (e) => statusBadge(e.status, { pending: ['À payer', 'warn'], cancelled: ['Annulé', 'muted'] }) },
    { label: 'Créé le', render: (e) => date(e.created_at) },
    { label: 'Payé le', render: (e) => date(e.paid_at) },
    { label: 'Action', render: (e) => (e.status === 'pending' ? h('button', { className: 'btn small ghost', type: 'button', onclick: () => payEarning(e) }, 'Marquer payé') : h('span', { className: 'muted' }, '—')) },
  ], data.items, 'Aucun gain enregistré.');

  renderPager('earnings-pager', 'earnings', data.pagination, () => loadEarnings().catch(handleError));
}

// ---------------------------------------------------------------------------
// Clics et journal
// ---------------------------------------------------------------------------

async function loadClicks() {
  const data = await api(`/api/admin/clicks?page=${state.pages.clicks}&limit=${PAGE_SIZE}`);
  renderTable('clicks-table', [
    { label: 'Date', render: (c) => date(c.created_at) },
    { label: 'Affilié', render: (c) => c.username || '—' },
    { label: 'Offre', render: (c) => c.offer_name },
    { label: 'Code', render: (c) => h('code', null, c.code || '—') },
    { label: 'IP (anonymisée)', render: (c) => c.ip_address || '—' },
    { label: 'Provenance', render: (c) => h('span', { className: 'truncate', title: c.referrer || '' }, c.referrer || 'Directe') },
  ], data.items, 'Aucun clic enregistré.');
  renderPager('clicks-pager', 'clicks', data.pagination, () => loadClicks().catch(handleError));
}

const ACTION_LABELS = {
  'user.status': 'Statut utilisateur',
  'offer.create': 'Création d’offre',
  'offer.update': 'Modification d’offre',
  'conversion.status': 'Statut de conversion',
  'conversion.manual': 'Conversion manuelle',
  'earning.paid': 'Paiement',
};

async function loadActivity() {
  const data = await api('/api/admin/actions?limit=50');
  renderTable('activity-table', [
    { label: 'Date', render: (a) => date(a.created_at) },
    { label: 'Admin', render: (a) => a.admin_username || '—' },
    { label: 'Action', render: (a) => ACTION_LABELS[a.action] || a.action },
    { label: 'Cible', render: (a) => `${a.target_type} #${a.target_id ?? '—'}` },
    { label: 'Détails', render: (a) => h('code', { className: 'details' }, JSON.stringify(a.details)) },
  ], data.items, 'Aucune action enregistrée.');
}

const LOADERS = {
  dashboard: loadDashboard,
  users: loadUsers,
  offers: loadOffers,
  conversions: loadConversions,
  earnings: loadEarnings,
  clicks: loadClicks,
  activity: loadActivity,
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function bindEvents() {
  $('login-form').addEventListener('submit', handleLogin);
  $('admin-logout').addEventListener('click', handleLogout);
  $('offer-form').addEventListener('submit', handleOfferSubmit);
  $('manual-form').addEventListener('submit', handleManualSubmit);

  $('users-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    state.pages.users = 1;
    loadUsers().catch(handleError);
  });
  $('conversions-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    state.pages.conversions = 1;
    loadConversions().catch(handleError);
  });
  $('earnings-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    state.pages.earnings = 1;
    loadEarnings().catch(handleError);
  });

  $('toggle-manual').addEventListener('click', (event) => {
    const form = $('manual-form');
    form.hidden = !form.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
  });

  document.querySelectorAll('[data-refresh]').forEach((button) => {
    button.addEventListener('click', () => LOADERS[button.dataset.refresh]().catch(handleError));
  });

  window.addEventListener('hashchange', () => {
    if (state.user) openSection(sectionFromHash());
  });
}

async function init() {
  bindEvents();
  if (!state.token) {
    showLogin('');
    return;
  }
  try {
    await verifyAdminSession();
    showConsole();
  } catch (error) {
    if (error.code === 'FORBIDDEN') await revokeCurrentSession();
    showLogin(error.status === 401 ? '' : error.message);
  }
}

document.addEventListener('DOMContentLoaded', init);
