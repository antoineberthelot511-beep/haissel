'use strict';

/*
 * Espace utilisateur HAISSEL.
 *
 * Sessions : cookie HttpOnly posé par le serveur. Ce script ne voit et ne
 * stocke AUCUN identifiant de session (rien dans localStorage /
 * sessionStorage). Il garde seulement en mémoire le jeton CSRF lié à la
 * session, envoyé dans l'en-tête X-CSRF-Token des requêtes qui modifient
 * des données.
 *
 * Toutes les données venant du serveur sont insérées via textContent (h()).
 */

const LEGACY_STORAGE_KEYS = ['haissel_token', 'haissel_user', 'lycee_token'];

const state = {
  csrf: '',
  user: null,
  config: { email_enabled: false, email_verification_required: false, password_min_length: 10 },
  links: [],
  loadedAt: 0,
  resetToken: '',
  learn: { loaded: false, opportunities: [] },
};

const ui = {};
let notificationCenter = null;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/** Supprime les jetons laissés par les anciennes versions du site. */
function purgeLegacyStorage() {
  try {
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
  } catch (error) { /* stockage indisponible */ }
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

async function api(url, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && state.csrf ? { 'X-CSRF-Token': state.csrf } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK', 'Serveur injoignable. Vérifiez votre connexion.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error?.message === 'string' ? payload.error.message : 'Une erreur est survenue.';
    const error = new ApiError(response.status, payload.error?.code || 'ERROR', message);
    const sessionLost = response.status === 401 && state.user && !url.startsWith('/api/auth/');
    if (sessionLost || (response.status === 403 && error.code === 'ADMIN_LOCAL_ONLY' && state.user)) {
      showLoggedOut();
      setMessage('error', response.status === 401 ? 'Votre session a expiré. Veuillez vous reconnecter.' : message);
    }
    throw error;
  }
  if (payload.data?.csrf_token) state.csrf = payload.data.csrf_token;
  return payload.data || {};
}

function setMessage(kind, message) {
  const error = kind === 'error' ? message : '';
  const info = kind === 'info' ? message : '';
  ui.authError.textContent = error;
  ui.authError.classList.toggle('hidden', !error);
  ui.authInfo.textContent = info;
  ui.authInfo.classList.toggle('hidden', !info);
}

function setBusy(form, busy) {
  form.querySelectorAll('button[type="submit"]').forEach((button) => {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  });
}

// ---------------------------------------------------------------------------
// Écrans
// ---------------------------------------------------------------------------

const AUTH_FORMS = ['login-form', 'register-form', 'mfa-form', 'forgot-form', 'reset-form'];

function showAuthForm(id, { keepMessage = false } = {}) {
  for (const formId of AUTH_FORMS) document.getElementById(formId).classList.toggle('hidden', formId !== id);
  const tabbed = id === 'login-form' || id === 'register-form';
  ui.authTabs.classList.toggle('hidden', !tabbed);
  document.querySelectorAll('.tab-button').forEach((button) => {
    const active = `${button.dataset.form}-form` === id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  ui.forgotLink.classList.toggle('hidden', !state.config.email_enabled);
  if (!keepMessage) setMessage('', '');
  const firstInput = document.getElementById(id).querySelector('input');
  if (firstInput && id !== 'login-form') firstInput.focus();
}

function updateUserSummary() {
  const displayName = state.user?.display_name || state.user?.username || 'Utilisateur';
  const initials = initialsFromName(displayName);

  ui.sidebarName.textContent = state.user ? displayName : 'Bonjour';
  ui.sidebarEmail.textContent = state.user?.email || 'Connectez-vous';
  ui.welcomeName.textContent = state.user?.first_name || displayName.split(' ')[0];
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
  // Barre principale et raccourcis de la colonne latérale.
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `${viewName}-view`);
  });
  if (viewName === 'learn' && state.user && !state.learn.loaded) loadLearn();
}

function showLoggedOut() {
  if (notificationCenter) notificationCenter.stop();
  state.user = null;
  state.links = [];
  state.learn = { loaded: false, opportunities: [] };
  ui.authScreen.classList.remove('hidden');
  ui.appScreen.classList.add('hidden');
  updateUserSummary();
  setActiveView('links');
}

function showLoggedIn(user) {
  state.user = user;
  ui.authScreen.classList.add('hidden');
  ui.appScreen.classList.remove('hidden');
  updateUserSummary();
  setActiveView('links');
  loadLinks();
  if (notificationCenter) notificationCenter.start();
}

function linkCard(link) {
  return h('article', { className: 'offer-card' },
    h('div', { className: 'offer-logo', 'aria-hidden': 'true' }, (link.name || 'H').charAt(0).toUpperCase()),
    h('div', { className: 'offer-body' },
      h('div', { className: 'offer-header-line' },
        h('h3', null, link.name),
        // Transparence commerciale (Code de la consommation L. 121-1, loi du 9 juin 2023).
        h('span', { className: 'pill ad', title: 'Lien affilié : HAISSEL peut percevoir une commission si vous utilisez ce lien.' }, 'Publicité')),
      link.description ? h('p', null, link.description) : null,
      h('div', { className: 'offer-footer' },
        h('span', { className: 'offer-domain' }, link.domain ? `Site partenaire : ${link.domain}` : 'Site partenaire'),
        h('a', {
          className: 'offer-link-button',
          href: link.go_url,
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': `Ouvrir « ${link.name} » sur le site partenaire (nouvel onglet)`,
        }, 'Ouvrir ↗'))));
}

function renderLinks() {
  ui.linksList.setAttribute('aria-busy', 'false');
  ui.linksList.replaceChildren(...(state.links.length
    ? state.links.map(linkCard)
    : [h('div', { className: 'panel-card' }, 'Aucun lien publié pour le moment. Revenez plus tard !')]));
}

function renderLinksLoading() {
  ui.linksList.setAttribute('aria-busy', 'true');
  if (state.links.length) return; // on garde la liste affichée pendant l'actualisation
  ui.linksList.replaceChildren(
    h('div', { className: 'panel-card' }, 'Chargement des liens…'),
    h('div', { className: 'offer-card skeleton', 'aria-hidden': 'true' }),
    h('div', { className: 'offer-card skeleton', 'aria-hidden': 'true' }));
}

// ---------------------------------------------------------------------------
// Apprendre (guides, opportunités, tutoriels, parrainage)
// ---------------------------------------------------------------------------

/** Texte rédigé par l'admin : « ## titre », « - point », « 1. étape », paragraphes. Jamais de HTML. */
function renderRichText(text) {
  const nodes = [];
  let list = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const item = /^(-|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      const tag = item[1] === '-' ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag, { className: 'learn-points' });
        nodes.push(list);
      }
      list.append(h('li', null, item[2]));
      continue;
    }
    list = null;
    if (!line) continue;
    nodes.push(line.startsWith('## ') ? h('h4', null, line.slice(3)) : h('p', null, line));
  }
  return nodes;
}

function contentCard(item) {
  return h('details', { className: 'learn-card' },
    h('summary', null,
      h('span', { className: 'learn-card-title' }, item.title),
      item.summary ? h('span', { className: 'learn-card-summary' }, item.summary) : null),
    h('div', { className: 'learn-card-body' }, renderRichText(item.body)));
}

function splitCountries(value) {
  return String(value || '').toUpperCase().split(/[\s,;/]+/).filter(Boolean);
}

function opportunityCard(item, { age, country }) {
  const tooYoung = Number.isInteger(age) && age < item.min_age;
  const countries = splitCountries(item.countries);
  const wrongCountry = country && countries.length && !countries.includes(country)
    && !countries.some((code) => ['MONDE', 'WORLD', 'ALL', 'TOUS'].includes(code));
  const row = (label, value) => (value ? h('li', null, h('span', null, label), h('strong', null, value)) : null);

  let action;
  if (!item.url) action = null;
  else if (tooYoung) action = h('p', { className: 'learn-warning' }, `Réservé aux ${item.min_age} ans et plus : lien masqué selon l'âge indiqué.`);
  else if (wrongCountry) action = h('p', { className: 'learn-warning' }, 'Votre pays ne fait pas partie des pays acceptés : lien masqué.');
  else {
    action = h('a', {
      className: 'offer-link-button',
      href: item.url,
      target: '_blank',
      rel: item.is_affiliate ? 'sponsored noopener noreferrer' : 'noopener noreferrer',
      'aria-label': `Ouvrir « ${item.name} » (nouvel onglet)`,
    }, 'Voir l’offre ↗');
  }

  return h('article', { className: 'learn-card opportunity-card' },
    h('div', { className: 'offer-header-line' },
      h('h3', null, item.name),
      item.is_affiliate ? h('span', { className: 'pill ad', title: 'Lien affilié : HAISSEL peut percevoir une commission.' }, 'Publicité') : null,
      h('span', { className: 'pill' }, `${item.min_age} ans et +`)),
    h('ul', { className: 'profile-list' },
      row('Annonceur', item.advertiser),
      row('Plateforme', item.network),
      row('Action rémunérée', item.paid_action),
      row('Rémunération annoncée', item.payout_text ? `${item.payout_text} (non garantie)` : null),
      row('Pays acceptés', item.countries),
      row('Conditions vérifiées le', formatDate(item.conditions_checked_at))),
    h('h4', null, 'Restrictions'),
    renderRichText(item.restrictions),
    item.allowed_channels ? [h('h4', null, 'Canaux autorisés'), renderRichText(item.allowed_channels)] : null,
    item.forbidden_methods ? [h('h4', null, 'Méthodes interdites'), renderRichText(item.forbidden_methods)] : null,
    h('div', { className: 'offer-footer' },
      item.terms_url ? h('a', { href: item.terms_url, target: '_blank', rel: 'noopener noreferrer' }, 'Conditions officielles ↗') : h('span'),
      action));
}

function renderLearnList(container, items, render, emptyMessage) {
  container.setAttribute('aria-busy', 'false');
  container.replaceChildren(...(items.length ? items.map(render) : [h('div', { className: 'panel-card' }, emptyMessage)]));
}

function renderOpportunities() {
  const ageValue = Number.parseInt(ui.oppAge.value, 10);
  const filters = {
    age: Number.isInteger(ageValue) ? ageValue : null,
    country: ui.oppCountry.value.trim().toUpperCase(),
  };
  renderLearnList(ui.learnOpportunitiesList, state.learn.opportunities, (item) => opportunityCard(item, filters),
    'Aucune opportunité publiée pour le moment. Chaque offre est vérifiée avant d’apparaître ici.');
}

function renderReferral(referral) {
  if (referral.rate_text) ui.referralRate.textContent = referral.rate_text;
  if (referral.available) {
    ui.referralAge.textContent = `${referral.min_age} ans minimum selon les conditions vérifiées le ${formatDate(referral.terms_checked_at)}. Les conditions officielles font foi.`;
    ui.referralBox.replaceChildren(
      h('div', { className: 'offer-footer' },
        h('a', { href: referral.terms_url, target: '_blank', rel: 'noopener noreferrer' }, 'Conditions officielles du programme ↗'),
        h('a', {
          className: 'offer-link-button', href: referral.url, target: '_blank', rel: 'sponsored noopener noreferrer',
        }, 'S’inscrire avec le lien de parrainage ↗')),
      h('p', { className: 'security-note' }, 'Lien de parrainage de l’éditeur de HAISSEL (lien affilié).'));
  } else {
    ui.referralBox.replaceChildren(h('div', { className: 'panel-card' },
      'Le lien de parrainage sera disponible après la vérification des conditions officielles du programme.'));
  }
}

async function loadLearn() {
  const lists = [ui.learnGuidesList, ui.learnTutorialsList, ui.learnOpportunitiesList];
  for (const list of lists) {
    list.setAttribute('aria-busy', 'true');
    if (!list.childElementCount) list.replaceChildren(h('div', { className: 'panel-card' }, 'Chargement…'));
  }
  try {
    const [content, opportunities, referral] = await Promise.all([
      api('/api/learn/content'), api('/api/learn/opportunities'), api('/api/learn/referral'),
    ]);
    const items = content.items || [];
    state.learn = { loaded: true, opportunities: opportunities.items || [] };
    renderLearnList(ui.learnGuidesList, items.filter((item) => item.kind === 'guide'), contentCard,
      'Les guides sont en cours de relecture. Revenez bientôt !');
    renderLearnList(ui.learnTutorialsList, items.filter((item) => item.kind === 'tutorial'), contentCard,
      'Les tutoriels sont en cours de relecture. Revenez bientôt !');
    renderOpportunities();
    renderReferral(referral);
  } catch (error) {
    if (error.status === 401 || error.status === 403) return;
    for (const list of lists) {
      list.setAttribute('aria-busy', 'false');
      list.replaceChildren(h('div', { className: 'panel-card is-error', role: 'alert' },
        h('p', null, `Impossible de charger le contenu : ${error.message}`),
        h('button', { className: 'secondary-button', type: 'button', onclick: loadLearn }, 'Réessayer')));
    }
  }
}

function setLearnTab(name) {
  document.querySelectorAll('.learn-tab').forEach((tab) => {
    const active = tab.dataset.learnTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.learn-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `learn-${name}`);
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function loadLinks() {
  renderLinksLoading();
  try {
    const data = await api('/api/links');
    state.links = data.items || [];
    state.loadedAt = Date.now();
    renderLinks();
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) {
      ui.linksList.setAttribute('aria-busy', 'false');
      ui.linksList.replaceChildren(h('div', { className: 'panel-card is-error', role: 'alert' },
        h('p', null, `Impossible de charger les liens : ${error.message}`),
        h('button', { className: 'secondary-button', type: 'button', onclick: loadLinks }, 'Réessayer')));
    }
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const identifier = ui.loginIdentifier.value.trim();
  const password = ui.loginPassword.value;
  if (!identifier || !password) {
    setMessage('error', 'Remplissez tous les champs.');
    return;
  }

  setBusy(form, true);
  try {
    setMessage('', '');
    const data = await api('/api/auth/login', { method: 'POST', body: { identifier, password } });
    ui.loginPassword.value = '';
    if (data.mfa_required) {
      showAuthForm('mfa-form');
      return;
    }
    showLoggedIn(data.user);
  } catch (error) {
    setMessage('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

async function handleMfa(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const useRecovery = !ui.mfaRecoveryField.classList.contains('hidden');
  const body = useRecovery ? { recovery_code: ui.mfaRecovery.value.trim() } : { code: ui.mfaCode.value.trim() };

  setBusy(form, true);
  try {
    const data = await api('/api/auth/mfa/verify', { method: 'POST', body });
    ui.mfaCode.value = '';
    ui.mfaRecovery.value = '';
    showLoggedIn(data.user);
  } catch (error) {
    if (error.code === 'MFA_LOCKED' || error.code === 'UNAUTHORIZED') {
      showAuthForm('login-form', { keepMessage: true });
    }
    setMessage('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = (id) => document.getElementById(id).value;
  const body = {
    first_name: value('register-first-name').trim(),
    last_name: value('register-last-name').trim(),
    username: value('register-username').trim().toLowerCase(),
    email: value('register-email').trim(),
    password: value('register-password'),
    confirm_password: value('register-confirm-password'),
  };

  // Contrôles de confort uniquement : le serveur revérifie tout.
  if (Object.values(body).some((field) => !field)) {
    setMessage('error', 'Tous les champs sont obligatoires.');
    return;
  }
  if ([...body.password].length < state.config.password_min_length) {
    setMessage('error', `Le mot de passe doit contenir au moins ${state.config.password_min_length} caractères.`);
    return;
  }
  if (body.password !== body.confirm_password) {
    setMessage('error', 'La confirmation ne correspond pas.');
    return;
  }

  setBusy(form, true);
  try {
    const data = await api('/api/auth/register', { method: 'POST', body });
    form.reset();
    if (data.verification_required) {
      showAuthForm('login-form');
      setMessage('info', 'Compte presque prêt : ouvrez le lien envoyé à votre adresse e-mail pour l’activer, puis connectez-vous.');
      return;
    }
    showLoggedIn(data.user);
  } catch (error) {
    setMessage('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

async function handleForgot(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = ui.forgotEmail.value.trim();
  if (!email) {
    setMessage('error', 'Indiquez votre adresse e-mail.');
    return;
  }
  setBusy(form, true);
  try {
    const data = await api('/api/auth/password/forgot', { method: 'POST', body: { email } });
    form.reset();
    showAuthForm('login-form');
    setMessage('info', data.message);
  } catch (error) {
    setMessage('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

async function handleReset(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const password = ui.resetPassword.value;
  const confirm = ui.resetConfirmPassword.value;
  if (password !== confirm) {
    setMessage('error', 'La confirmation ne correspond pas.');
    return;
  }
  setBusy(form, true);
  try {
    const data = await api('/api/auth/password/reset', {
      method: 'POST',
      body: { token: state.resetToken, password, confirm_password: confirm },
    });
    state.resetToken = '';
    form.reset();
    showAuthForm('login-form');
    setMessage('info', data.message);
  } catch (error) {
    setMessage('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = (kind, message) => {
    ui.passwordFeedback.textContent = kind === 'info' ? message : '';
    ui.passwordFeedback.classList.toggle('hidden', kind !== 'info');
    ui.passwordError.textContent = kind === 'error' ? message : '';
    ui.passwordError.classList.toggle('hidden', kind !== 'error');
  };
  setBusy(form, true);
  try {
    await api('/api/auth/password/change', {
      method: 'POST',
      body: {
        current_password: document.getElementById('current-password').value,
        new_password: document.getElementById('new-password').value,
        confirm_password: document.getElementById('new-confirm-password').value,
      },
    });
    form.reset();
    feedback('info', 'Mot de passe modifié. Vos autres sessions ont été fermées.');
  } catch (error) {
    feedback('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

async function handleLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    // Session déjà invalide côté serveur.
  }
  state.csrf = '';
  showLoggedOut();
  showAuthForm('login-form');
}

async function handleLogoutAll() {
  try {
    await api('/api/auth/logout-all', { method: 'POST' });
  } catch (error) {
    // Session déjà invalide côté serveur.
  }
  state.csrf = '';
  showLoggedOut();
  showAuthForm('login-form');
  setMessage('info', 'Toutes vos sessions ont été fermées.');
}

async function handleDeleteAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = document.getElementById('delete-account-error');
  const password = document.getElementById('delete-account-password').value;
  const confirm = document.getElementById('delete-account-confirm').value.trim();
  errorBox.classList.add('hidden');
  if (confirm !== 'SUPPRIMER') {
    errorBox.textContent = 'Tapez SUPPRIMER pour confirmer.';
    errorBox.classList.remove('hidden');
    return;
  }
  setBusy(form, true);
  try {
    await api('/api/auth/me/delete', { method: 'POST', body: { password, confirm } });
    form.reset();
    state.csrf = '';
    showLoggedOut();
    showAuthForm('login-form');
    setMessage('info', 'Votre compte et vos données ont été supprimés.');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  } finally {
    setBusy(form, false);
  }
}

/** Liens reçus par e-mail : le jeton est dans le fragment (#), jamais envoyé en GET. */
async function handleEmailLinks() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const verifyToken = params.get('verify');
  const resetToken = params.get('reset');
  if (!verifyToken && !resetToken) return false;

  // Retire immédiatement le jeton de la barre d'adresse et de l'historique.
  history.replaceState(null, '', window.location.pathname);

  if (verifyToken) {
    try {
      const data = await api('/api/auth/email/verify', { method: 'POST', body: { token: verifyToken } });
      showAuthForm('login-form');
      setMessage('info', data.message);
    } catch (error) {
      showAuthForm('login-form');
      setMessage('error', error.message);
    }
    return true;
  }

  state.resetToken = resetToken;
  showAuthForm('reset-form');
  return true;
}

async function init() {
  purgeLegacyStorage();
  try {
    state.config = await api('/api/auth/config');
  } catch (error) { /* valeurs par défaut */ }

  showLoggedOut();
  showAuthForm('login-form');
  if (await handleEmailLinks()) return;

  try {
    const data = await api('/api/auth/me');
    if (data.mfa_pending) {
      showAuthForm('mfa-form');
      return;
    }
    showLoggedIn(data.user);
  } catch (error) {
    if (error.status !== 401) setMessage('error', error.message);
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const ids = {
    statusBadge: 'status-badge', logoutButton: 'logout-button', authScreen: 'auth-screen',
    appScreen: 'app-screen', authError: 'auth-error', authInfo: 'auth-info', loginForm: 'login-form',
    registerForm: 'register-form', loginIdentifier: 'login-identifier', loginPassword: 'login-password',
    sidebarName: 'sidebar-name', sidebarEmail: 'sidebar-email', sidebarAvatar: 'sidebar-avatar',
    welcomeName: 'welcome-name', profileDisplayName: 'profile-display-name', profileUsername: 'profile-username',
    profileEmail: 'profile-email', profileFullName: 'profile-full-name', profileCreatedAt: 'profile-created-at',
    profileAvatar: 'profile-avatar', linksList: 'links-list', refreshLinks: 'refresh-links',
    profileLogout: 'profile-logout', forgotLink: 'forgot-link', forgotEmail: 'forgot-email',
    resetPassword: 'reset-password', resetConfirmPassword: 'reset-confirm-password',
    mfaCode: 'mfa-code', mfaRecovery: 'mfa-recovery', mfaRecoveryField: 'mfa-recovery-field',
    mfaCodeField: 'mfa-code-field', mfaToggleRecovery: 'mfa-toggle-recovery',
    learnGuidesList: 'learn-guides-list', learnTutorialsList: 'learn-tutorials-list',
    learnOpportunitiesList: 'learn-opportunities-list', oppAge: 'opp-age', oppCountry: 'opp-country',
    referralRate: 'referral-rate', referralAge: 'referral-age', referralBox: 'referral-box',
    passwordFeedback: 'password-feedback', passwordError: 'password-error', logoutAllButton: 'logout-all-button',
  };
  for (const [key, id] of Object.entries(ids)) ui[key] = document.getElementById(id);
  ui.authTabs = document.querySelector('.auth-tabs');

  notificationCenter = window.createNotificationCenter({
    post: (url, body) => api(url, { method: 'POST', body }),
    // false = session invalide ; null = serveur injoignable (on réessaiera).
    checkSession: async () => {
      try {
        await api('/api/auth/me');
        return true;
      } catch (error) {
        return error.status === 401 ? false : null;
      }
    },
    // Session révoquée / expirée : retour à l'écran de connexion.
    onSessionEnded: () => {
      if (!state.user) return;
      state.csrf = '';
      showLoggedOut();
      showAuthForm('login-form');
      setMessage('error', 'Votre session a pris fin. Veuillez vous reconnecter.');
    },
  });

  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => showAuthForm(`${button.dataset.form}-form`));
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.view));
  });
  document.querySelectorAll('[data-back-to-login]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!document.getElementById('mfa-form').classList.contains('hidden')) await handleLogout();
      showAuthForm('login-form');
    });
  });

  ui.loginForm.addEventListener('submit', handleLogin);
  ui.registerForm.addEventListener('submit', handleRegister);
  document.getElementById('mfa-form').addEventListener('submit', handleMfa);
  document.getElementById('forgot-form').addEventListener('submit', handleForgot);
  document.getElementById('reset-form').addEventListener('submit', handleReset);
  document.getElementById('password-form').addEventListener('submit', handlePasswordChange);
  document.getElementById('delete-account-form').addEventListener('submit', handleDeleteAccount);
  ui.forgotLink.addEventListener('click', () => showAuthForm('forgot-form'));
  ui.logoutButton.addEventListener('click', handleLogout);
  ui.profileLogout.addEventListener('click', handleLogout);
  ui.logoutAllButton.addEventListener('click', handleLogoutAll);
  ui.refreshLinks.addEventListener('click', loadLinks);
  document.querySelectorAll('.learn-tab').forEach((tab) => {
    tab.addEventListener('click', () => setLearnTab(tab.dataset.learnTab));
  });
  ui.oppAge.addEventListener('input', renderOpportunities);
  ui.oppCountry.addEventListener('input', renderOpportunities);
  ui.mfaToggleRecovery.addEventListener('click', () => {
    const recovery = ui.mfaRecoveryField.classList.toggle('hidden') === false;
    ui.mfaCodeField.classList.toggle('hidden', recovery);
    ui.mfaToggleRecovery.textContent = recovery ? 'Utiliser le code de l’application' : 'Utiliser un code de récupération';
  });

  document.getElementById('register-show-password').addEventListener('change', (event) => {
    const type = event.target.checked ? 'text' : 'password';
    document.getElementById('register-password').type = type;
    document.getElementById('register-confirm-password').type = type;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && Date.now() - state.loadedAt > 60 * 60 * 1000) {
      loadLinks();
    }
  });

  init();
});
