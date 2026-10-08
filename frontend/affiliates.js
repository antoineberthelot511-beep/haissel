const token = localStorage.getItem('lycee_token') || '';

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Requête impossible.');
  }
  return payload;
}

function renderStats(stats) {
  const box = document.getElementById('stats-box');
  box.innerHTML = `
    <div class="stat"><div class="muted">Clics</div><h3>${stats.total_clicks || 0}</h3></div>
    <div class="stat"><div class="muted">Conversions</div><h3>${stats.total_conversions || 0}</h3></div>
    <div class="stat"><div class="muted">Gains</div><h3>${(stats.total_earnings || 0) / 100} €</h3></div>
  `;
}

function renderCodes(codes) {
  const box = document.getElementById('codes-box');
  if (!codes.length) {
    box.innerHTML = '<p class="muted">Aucun code affilié pour le moment.</p>';
    return;
  }

  box.innerHTML = `
    <table>
      <thead>
        <tr><th>Offre</th><th>Code</th><th>Clics</th><th>Conversions</th><th>Montant</th></tr>
      </thead>
      <tbody>
        ${codes.map((code) => `
          <tr>
            <td>${code.offer_name}</td>
            <td><span class="code">${code.code}</span></td>
            <td>${code.total_clicks || 0}</td>
            <td>${code.total_conversions || 0}</td>
            <td>${((code.total_amount_cents || 0) / 100).toFixed(2)} €</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderOffers(items) {
  const box = document.getElementById('offers-box');
  if (!items.length) {
    box.innerHTML = '<p class="muted">Aucune offre disponible.</p>';
    return;
  }

  box.innerHTML = `
    <table>
      <thead>
        <tr><th>Nom</th><th>URL</th><th>Code</th></tr>
      </thead>
      <tbody>
        ${items.map((item) => `
          <tr>
            <td>${item.name}</td>
            <td><a class="link" href="${item.url}" target="_blank" rel="noreferrer">Voir l’offre</a></td>
            <td>${item.code ? `<span class="code">${item.code}</span>` : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

(async function init() {
  if (!token) {
    document.body.innerHTML = '<div style="padding:32px 24px;color:#8a2a2a;">Veuillez vous reconnecter pour accéder à vos affiliés.</div>';
    setTimeout(() => {
      window.location.href = '/';
    }, 1200);
    return;
  }

  try {
    const [statsResponse, offersResponse] = await Promise.all([
      fetchJson('/api/affiliates/stats'),
      fetchJson('/api/affiliates'),
    ]);

    renderStats({
      total_clicks: statsResponse.data.total_clicks || 0,
      total_conversions: statsResponse.data.total_conversions || 0,
      total_earnings: statsResponse.data.total_earnings || 0,
    });
    renderCodes(statsResponse.data.codes || []);
    renderOffers(offersResponse.data.items || []);
  } catch (error) {
    document.body.innerHTML = `<div style="padding:24px;color:#c33;">${error.message}</div>`;
  }
})();