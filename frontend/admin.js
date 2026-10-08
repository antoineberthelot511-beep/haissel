
const STORAGE_TOKEN_KEY = 'haissel_token';
const ADMIN_TOKEN_FALLBACK_KEY = 'lycee_token';
const state = { token: localStorage.getItem(STORAGE_TOKEN_KEY) || localStorage.getItem(ADMIN_TOKEN_FALLBACK_KEY) || '' };

function getHeaders(extraHeaders = {}) {
  return {
    'Content-Type': 'application/json',
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...(extraHeaders || {}),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: getHeaders(options.headers) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || 'Requête impossible.');
  return payload;
}

function formatMoney(cents) {
  const value = Number(cents || 0) / 100;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(value);
}

function renderOverview(data) {
  document.getElementById('metric-users').textContent = data?.total_users || 0;
  document.getElementById('metric-active-users').textContent = data?.active_users || 0;
  document.getElementById('metric-total-clicks').textContent = data?.total_clicks || 0;
  document.getElementById('metric-total-earnings').textContent = formatMoney(data?.total_amount_cents || 0);
}

function renderUsers(rows) {
  const wrap = document.getElementById('users-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<p class="muted">Aucun utilisateur trouvé.</p>';
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Utilisateur</th><th>Email</th><th>Statut</th><th>Bannissement</th><th>Action</th></tr></thead>
      <tbody>
        ${rows.map((user) => `
          <tr>
            <td>${user.display_name || user.username}</td>
            <td>${user.email}</td>
            <td>${user.is_active ? '<span class="status success">Actif</span>' : '<span class="status danger">Inactif</span>'}</td>
            <td>${user.is_banned ? '<span class="status danger">Banni</span>' : '<span class="status success">OK</span>'}</td>
            <td><button type="button" class="small-action" data-user-id="${user.id}" data-action="toggle-active">${user.is_active ? 'Suspendre' : 'Réactiver'}</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-action="toggle-active"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = Number(button.dataset.userId);
      const user = rows.find((entry) => Number(entry.id) === userId);
      if (!user) return;
      await fetchJson(`/api/admin/users/${userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !user.is_active }),
      });
      await loadUsers();
      await loadOverview();
    });
  });
}

function renderOffers(rows) {
  const wrap = document.getElementById('offers-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<p class="muted">Aucune offre disponible.</p>';
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Nom</th><th>URL</th><th>Description</th><th>Statut</th></tr></thead>
      <tbody>
        ${rows.map((offer) => `
          <tr>
            <td>${offer.name}</td>
            <td><a href="${offer.url}" target="_blank" rel="noopener noreferrer">${offer.url}</a></td>
            <td>${offer.description || '—'}</td>
            <td>${offer.is_active ? '<span class="status success">Active</span>' : '<span class="status danger">Inactive</span>'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderStatsSummary(data) {
  const summary = document.getElementById('stats-summary');
  summary.innerHTML = `
    <div class='stats-grid'>
      <div class='metric-card blue'><span>Utilisateurs actifs</span><strong>${data.active_users || 0}</strong></div>
      <div class='metric-card violet'><span>Clics</span><strong>${data.total_clicks || 0}</strong></div>
      <div class='metric-card green'><span>Conversions</span><strong>${data.total_conversions || 0}</strong></div>
      <div class='metric-card orange'><span>Gains</span><strong>${formatMoney(data.total_amount_cents || 0)}</strong></div>
    </div>
  `;
}

async function loadOverview() {
  const data = await fetchJson('/api/admin/stats');
  renderOverview(data.data || {});
}

async function loadUsers() {
  const search = document.getElementById('user-search').value.trim();
  const query = search ? `?search=${encodeURIComponent(search)}&limit=20&page=1` : '?limit=20&page=1';
  const data = await fetchJson(`/api/admin/users${query}`);
  renderUsers(data.data.users || []);
}

async function loadOffers() {
  const data = await fetchJson('/api/admin/affiliates?limit=20&page=1');
  renderOffers(data.data.items || []);
}

async function loadStats() {
  const data = await fetchJson('/api/admin/stats');
  renderStatsSummary(data.data || {});
}

document.getElementById('search-users').addEventListener('click', loadUsers);

document.getElementById('offer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    name: document.getElementById('offer-name').value.trim(),
    url: document.getElementById('offer-url').value.trim(),
    description: document.getElementById('offer-description').value.trim(),
  };
  if (!payload.name || !payload.url) return;
  await fetchJson('/api/admin/affiliates', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  event.target.reset();
  await loadOffers();
  await loadOverview();
});

document.getElementById('admin-logout').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(ADMIN_TOKEN_FALLBACK_KEY);
  window.location.href = '/';
});

(async function initAdmin() {
  if (!state.token) {
    document.body.innerHTML = '<div class="auth-denied">Vous devez être connecté en tant qu’admin pour ouvrir cette page.</div>';
    setTimeout(() => { window.location.href = '/'; }, 1200);
    return;
  }
  try {
    await Promise.all([loadOverview(), loadUsers(), loadOffers(), loadStats()]);
  } catch (error) {
    document.body.innerHTML = `<div class="auth-denied">${error.message}</div>`;
  }
})();
