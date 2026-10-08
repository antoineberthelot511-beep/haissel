
const STORAGE_TOKEN_KEY = 'haissel_token';
const STORAGE_USER_KEY = 'haissel_user';

const state = {
  token: localStorage.getItem(STORAGE_TOKEN_KEY) || '',
  user: readStoredUser(),
  offers: [],
  stats: null,
  activeView: 'dashboard',
};

const ui = {};

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_USER_KEY) || 'null');
  } catch (error) {
    localStorage.removeItem(STORAGE_USER_KEY);
    return null;
  }
}

function setStoredSession(token, user) {
  state.token = token || '';
  state.user = user || null;
  if (state.token) {
    localStorage.setItem(STORAGE_TOKEN_KEY, state.token);
  } else {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
  }
  if (state.user) {
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(state.user));
  } else {
    localStorage.removeItem(STORAGE_USER_KEY);
  }
}

function getAuthHeaders(extraHeaders = {}) {
  return {
    ...extraHeaders,
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || 'La requête a échoué.');
  return payload;
}

function setAuthError(message) {
  if (!ui.authError) return;
  if (!message) {
    ui.authError.textContent = '';
    ui.authError.classList.add('hidden');
    return;
  }
  ui.authError.textContent = message;
  ui.authError.classList.remove('hidden');
}

function initialsFromName(name) {
  const value = String(name || '').trim();
  if (!value) return 'H';
  const parts = value.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0].toUpperCase()).join('').slice(0, 2) || 'H';
}

function formatMoney(cents) {
  const total = Number(cents || 0) / 100;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(total);
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)} %`;
}

function updateUserSummary() {
  const displayName = state.user?.display_name || state.user?.username || 'Utilisateur';
  const email = state.user?.email || 'Utilisateur';
  const initial = initialsFromName(displayName);
  ui.sidebarName.textContent = displayName;
  ui.sidebarEmail.textContent = email;
  ui.welcomeName.textContent = displayName.split(' ')[0] || displayName;
  ui.profileDisplayName.textContent = displayName;
  ui.profileUsername.textContent = `@${state.user?.username || 'user'}`;
  ui.profileEmail.textContent = email;
  ui.profileFullName.textContent = state.user?.display_name || '—';
  ui.profileCreatedAt.textContent = state.user?.created_at ? new Date(state.user.created_at).toLocaleDateString('fr-FR') : '—';
  ui.sidebarAvatar.textContent = initial;
  ui.profileAvatar.textContent = initial;

  if (state.user) {
    ui.statusBadge.textContent = 'En ligne';
    ui.statusBadge.classList.remove('offline');
    ui.logoutButton.classList.remove('hidden');
  } else {
    ui.statusBadge.textContent = 'Connexion';
    ui.statusBadge.classList.add('offline');
    ui.logoutButton.classList.add('hidden');
  }
}

function setActiveView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `${viewName}-view`);
  });
}

function toggleAuthForm(formName) {
  const isLogin = formName === 'login';
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.form === formName);
  });
  ui.loginForm.classList.toggle('hidden', !isLogin);
  ui.registerForm.classList.toggle('hidden', isLogin);
  setAuthError('');
}

function renderLoggedOut() {
  setStoredSession('', null);
  ui.authScreen.classList.remove('hidden');
  ui.appScreen.classList.add('hidden');
  updateUserSummary();
  setActiveView('dashboard');
  ui.sidebarName.textContent = 'Bonjour';
  ui.sidebarEmail.textContent = 'Connectez-vous';
  ui.miniClicks.textContent = '0';
  ui.miniConversions.textContent = '0';
  ui.miniEarnings.textContent = '0 €';
}

function renderLoggedIn() {
  ui.authScreen.classList.add('hidden');
  ui.appScreen.classList.remove('hidden');
  updateUserSummary();
  setActiveView(state.activeView || 'dashboard');
}

function renderDashboardStats(stats) {
  const totalClicks = Number(stats?.total_clicks || 0);
  const totalConversions = Number(stats?.total_conversions || 0);
  const totalEarnings = Number(stats?.total_earnings || 0);
  const conversionRate = totalClicks > 0 ? (totalConversions / totalClicks) * 100 : 0;

  ui.metricClicks.textContent = totalClicks.toString();
  ui.metricConversions.textContent = totalConversions.toString();
  ui.metricEarnings.textContent = formatMoney(totalEarnings);
  ui.metricRate.textContent = formatPercent(conversionRate);

  ui.miniClicks.textContent = totalClicks.toString();
  ui.miniConversions.textContent = totalConversions.toString();
  ui.miniEarnings.textContent = formatMoney(totalEarnings);

  ui.metricClicksDelta.textContent = 'Cumul enregistré';
  ui.metricConversionsDelta.textContent = 'Conversions enregistrées';
  ui.metricEarningsDelta.textContent = 'Gains cumulés';
  ui.metricRateDelta.textContent = 'Conversions / clics';

  ui.statsClicks.textContent = totalClicks.toString();
  ui.statsConversions.textContent = totalConversions.toString();
  ui.statsEarnings.textContent = formatMoney(totalEarnings);
  ui.statsRate.textContent = formatPercent(conversionRate);
}

function renderOfferCards() {
  const items = state.offers.slice(0, 3);
  if (!items.length) {
    ui.dashboardOffers.innerHTML = '<div class="panel-card">Aucune offre disponible pour le moment.</div>';
    return;
  }
  ui.dashboardOffers.innerHTML = items.map((offer) => {
    const logo = (offer.name || 'H').charAt(0).toUpperCase();
    return `
      <article class="offer-card">
        <div class="offer-logo">${logo}</div>
        <div class="offer-body">
          <div class="offer-header-line">
            <h4>${offer.name}</h4>
            <span class="pill">${offer.code || 'code'}</span>
          </div>
          <div class="offer-meta">
            <span>${offer.description || 'Offre active'}</span>
          </div>
          <div class="offer-footer">
            <strong>${offer.total_amount_cents ? formatMoney(offer.total_amount_cents) : 'Gains'}</strong>
            <button class="offer-link-button" type="button" data-offer-id="${offer.id}">Obtenir mon lien</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  ui.dashboardOffers.querySelectorAll('[data-offer-id]').forEach((button) => {
    button.addEventListener('click', () => selectOfferFromId(Number(button.dataset.offerId)));
  });
}

function renderOffersList() {
  if (!state.offers.length) {
    ui.offersList.innerHTML = '<div class="panel-card">Aucune offre n’est disponible pour le moment.</div>';
    return;
  }

  ui.offersList.innerHTML = state.offers.map((offer) => {
    const logo = (offer.name || 'H').charAt(0).toUpperCase();
    return `
      <article class="offer-card">
        <div class="offer-logo">${logo}</div>
        <div class="offer-body">
          <div class="offer-header-line">
            <h4>${offer.name}</h4>
            <span class="pill">${offer.code || 'code'}</span>
          </div>
          <p>${offer.description || 'Offre active'}</p>
          <div class="offer-meta">
            <span>Gains estimés</span>
            <strong>${offer.total_amount_cents ? formatMoney(offer.total_amount_cents) : 'À confirmer'}</strong>
          </div>
          <div class="offer-footer">
            <span>${offer.total_conversions || 0} conversions</span>
            <button class="offer-link-button" type="button" data-offer-id="${offer.id}">Obtenir mon lien</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  ui.offersList.querySelectorAll('[data-offer-id]').forEach((button) => {
    button.addEventListener('click', () => selectOfferFromId(Number(button.dataset.offerId)));
  });
}

function renderOfferSelector() {
  if (!state.offers.length) {
    ui.affiliateOfferSelect.innerHTML = '<option value="">Aucune offre</option>';
    ui.affiliateLinkInput.value = '';
    return;
  }

  ui.affiliateOfferSelect.innerHTML = state.offers.map((offer) => `
    <option value="${offer.id}">${offer.name}</option>
  `).join('');

  const firstOffer = state.offers[0];
  ui.affiliateOfferSelect.value = String(firstOffer.id);
  renderAffiliateLink(firstOffer.id);
}

function selectOfferFromId(offerId) {
  state.activeView = 'link';
  setActiveView('link');
  ui.affiliateOfferSelect.value = String(offerId);
  renderAffiliateLink(offerId);
}

function renderAffiliateLink(offerId) {
  const offer = state.offers.find((entry) => Number(entry.id) === Number(offerId));
  if (!offer) return;
  const target = `${window.location.origin}/api/affiliate/${offer.code || ''}`.replace(/\/$/, '');
  ui.affiliateLinkInput.value = target;
}

function renderStatsTable() {
  const rows = state.stats?.codes || [];
  if (!rows.length) {
    ui.statsTableWrap.innerHTML = '<p>Aucune donnée statistique pour le moment.</p>';
    return;
  }

  ui.statsTableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Offre</th>
          <th>Code</th>
          <th>Clics</th>
          <th>Conversions</th>
          <th>Gains</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${row.offer_name || 'Offre'}</td>
            <td><span class='code-pill'>${row.code || 'N/A'}</span></td>
            <td>${row.total_clicks || 0}</td>
            <td>${row.total_conversions || 0}</td>
            <td>${formatMoney(row.total_amount_cents || 0)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function loadDashboardData() {
  try {
    const [offersResponse, statsResponse] = await Promise.all([
      fetchJson('/api/affiliate'),
      fetchJson('/api/affiliate/stats'),
    ]);

    state.offers = offersResponse.data?.items || [];
    state.stats = statsResponse.data || {};

    renderDashboardStats(state.stats);
    renderOfferCards();
    renderOffersList();
    renderOfferSelector();
    renderStatsTable();
  } catch (error) {
    console.error('Error loading dashboard data', error);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const identifier = document.getElementById('login-identifier').value.trim();
  const password = document.getElementById('login-password').value;

  if (!identifier || !password) {
    setAuthError('Remplissez tous les champs.');
    return;
  }

  try {
    setAuthError('');
    const response = await fetchJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    });
    setStoredSession(response.data.token, response.data.user);
    renderLoggedIn();
    await loadDashboardData();
  } catch (error) {
    setAuthError(error.message);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const payload = {
    first_name: document.getElementById('register-first-name').value.trim(),
    last_name: document.getElementById('register-last-name').value.trim(),
    username: document.getElementById('register-username').value.trim(),
    email: document.getElementById('register-email').value.trim(),
    password: document.getElementById('register-password').value,
    confirm_password: document.getElementById('register-confirm-password').value,
  };

  if (!payload.first_name || !payload.last_name || !payload.username || !payload.email || !payload.password || !payload.confirm_password) {
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
    const response = await fetchJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStoredSession(response.data.token, response.data.user);
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
    console.warn('Logout ignored:', error.message);
  }
  setStoredSession('', null);
  renderLoggedOut();
}

async function copyAffiliateLink() {
  try {
    const value = ui.affiliateLinkInput.value;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    ui.copyLinkButton.textContent = 'Lien copié';
    setTimeout(() => { ui.copyLinkButton.textContent = 'Copier le lien'; }, 1200);
  } catch (error) {
    ui.affiliateLinkInput.focus();
    ui.affiliateLinkInput.select();
  }
}

async function hydrateSession() {
  if (!state.token) {
    renderLoggedOut();
    return;
  }
  try {
    const response = await fetchJson('/api/auth/me');
    state.user = response.data.user;
    setStoredSession(state.token, state.user);
    renderLoggedIn();
    await loadDashboardData();
  } catch (error) {
    console.error('Session invalid', error);
    setStoredSession('', null);
    renderLoggedOut();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  ui.statusBadge = document.getElementById('status-badge');
  ui.logoutButton = document.getElementById('logout-button');
  ui.authScreen = document.getElementById('auth-screen');
  ui.appScreen = document.getElementById('app-screen');
  ui.authError = document.getElementById('auth-error');
  ui.loginForm = document.getElementById('login-form');
  ui.registerForm = document.getElementById('register-form');
  ui.sidebarName = document.getElementById('sidebar-name');
  ui.sidebarEmail = document.getElementById('sidebar-email');
  ui.sidebarAvatar = document.getElementById('sidebar-avatar');
  ui.welcomeName = document.getElementById('welcome-name');
  ui.profileDisplayName = document.getElementById('profile-display-name');
  ui.profileUsername = document.getElementById('profile-username');
  ui.profileEmail = document.getElementById('profile-email');
  ui.profileFullName = document.getElementById('profile-full-name');
  ui.profileCreatedAt = document.getElementById('profile-created-at');
  ui.profileAvatar = document.getElementById('profile-avatar');
  ui.metricClicks = document.getElementById('metric-clicks');
  ui.metricConversions = document.getElementById('metric-conversions');
  ui.metricEarnings = document.getElementById('metric-earnings');
  ui.metricRate = document.getElementById('metric-rate');
  ui.metricClicksDelta = document.getElementById('metric-clicks-delta');
  ui.metricConversionsDelta = document.getElementById('metric-conversions-delta');
  ui.metricEarningsDelta = document.getElementById('metric-earnings-delta');
  ui.metricRateDelta = document.getElementById('metric-rate-delta');
  ui.dashboardOffers = document.getElementById('dashboard-offers');
  ui.offersList = document.getElementById('offers-list');
  ui.affiliateOfferSelect = document.getElementById('affiliate-offer-select');
  ui.affiliateLinkInput = document.getElementById('affiliate-link-input');
  ui.copyLinkButton = document.getElementById('copy-link-button');
  ui.statsTableWrap = document.getElementById('stats-table-wrap');
  ui.miniClicks = document.getElementById('mini-clicks');
  ui.miniConversions = document.getElementById('mini-conversions');
  ui.miniEarnings = document.getElementById('mini-earnings');
  ui.statsClicks = document.getElementById('stats-clicks');
  ui.statsConversions = document.getElementById('stats-conversions');
  ui.statsEarnings = document.getElementById('stats-earnings');
  ui.statsRate = document.getElementById('stats-rate');
  ui.profileLogout = document.getElementById('profile-logout');

  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => toggleAuthForm(button.dataset.form));
  });

  document.querySelectorAll('.nav-button').forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.view));
  });

  ui.loginForm.addEventListener('submit', handleLogin);
  ui.registerForm.addEventListener('submit', handleRegister);
  ui.logoutButton.addEventListener('click', handleLogout);
  ui.profileLogout.addEventListener('click', handleLogout);
  ui.copyLinkButton.addEventListener('click', copyAffiliateLink);
  ui.affiliateOfferSelect.addEventListener('change', () => renderAffiliateLink(ui.affiliateOfferSelect.value));

  hydrateSession();
});
