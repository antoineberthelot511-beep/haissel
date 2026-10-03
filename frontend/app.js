function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('lycee_user') || 'null');
  } catch {
    localStorage.removeItem('lycee_user');
    return null;
  }
}

const state = {
  token: localStorage.getItem('lycee_token') || '',
  user: readStoredUser(),
  activeTab: 'login',
};

const backendStatusEl = document.getElementById('backend-status');
const authPanel = document.getElementById('auth-panel');
const composerPanel = document.getElementById('composer-panel');
const feedEl = document.getElementById('feed');
const notificationsList = document.getElementById('notifications-list');
const messagesList = document.getElementById('messages-list');
const profileName = document.getElementById('profile-name');
const profileEmail = document.getElementById('profile-email');
const logoutButton = document.getElementById('logout-button');
const statsFollowers = document.getElementById('stats-followers');
const statsFollowing = document.getElementById('stats-following');
const statsPosts = document.getElementById('stats-posts');

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function setLoggedInState(user) {
  state.user = user;
  localStorage.setItem('lycee_user', JSON.stringify(user || null));

  if (user) {
    profileName.textContent = user.display_name || user.username;
    profileEmail.textContent = user.email || user.username;
    authPanel.classList.add('hidden');
    composerPanel.classList.remove('hidden');
    logoutButton.classList.remove('hidden');
    statsFollowers.textContent = '0';
    statsFollowing.textContent = '0';
    statsPosts.textContent = '0';
  } else {
    profileName.textContent = 'Bienvenue';
    profileEmail.textContent = 'Connectez-vous pour commencer';
    authPanel.classList.remove('hidden');
    composerPanel.classList.add('hidden');
    logoutButton.classList.add('hidden');
    statsFollowers.textContent = '0';
    statsFollowing.textContent = '0';
    statsPosts.textContent = '0';
  }
}

function renderPosts(posts) {
  if (!posts || posts.length === 0) {
    feedEl.innerHTML = '<div class="card"><p>Aucune publication pour le moment.</p></div>';
    return;
  }

  feedEl.innerHTML = posts
    .map((post) => {
      const author = post.author || { username: 'inconnu', display_name: 'Utilisateur' };
      const initials = (author.display_name || author.username || 'U')
        .split(' ')
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

      return `
        <article class="post-card">
          <div class="post-header">
            <div class="post-user">
              <div class="avatar">${escapeHTML(initials)}</div>
              <div>
                <strong>${escapeHTML(author.display_name || author.username)}</strong>
                <span>@${escapeHTML(author.username)}</span>
              </div>
            </div>
            <span>${escapeHTML(new Date(post.created_at || Date.now()).toLocaleDateString('fr-FR'))}</span>
          </div>
          <div class="post-body">${escapeHTML(post.content)}</div>
          <div class="post-actions">
            <div>
              <button type="button">♥ ${post.likes_count || 0}</button>
              <button type="button">💬 ${post.comments_count || 0}</button>
            </div>
            <button type="button">Partager</button>
          </div>
        </article>
      `;
    })
    .join('');
}

async function checkBackend() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const data = await response.json();

    if (response.ok && data.status === 'ok') {
      backendStatusEl.textContent = 'Backend OK';
      backendStatusEl.classList.remove('offline');
      return true;
    }

    backendStatusEl.textContent = 'Backend lent';
    backendStatusEl.classList.add('offline');
    return false;
  } catch (error) {
    backendStatusEl.textContent = 'Backend OFF';
    backendStatusEl.classList.add('offline');
    return false;
  }
}

function showEmptyState(message) {
  feedEl.replaceChildren();
  const card = document.createElement('div');
  card.className = 'card';
  const text = document.createElement('p');
  text.textContent = message;
  card.append(text);
  feedEl.append(card);
}

async function loadPosts() {
  try {
    const response = await fetch('/api/posts', { cache: 'no-store' });
    if (!response.ok) {
      showEmptyState('Impossible de charger le fil. Réessayez dans un instant.');
      return;
    }

    const json = await response.json();
    if (json && json.data && json.data.posts) {
      renderPosts(json.data.posts);
      return;
    }

    showEmptyState('Le serveur a renvoyé une réponse inattendue.');
  } catch (error) {
    showEmptyState('Connexion au serveur impossible.');
  }
}

function bindTabs() {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach((tab) => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.auth-form').forEach((form) => form.classList.toggle('active', form.id === `${button.dataset.tab}-form`));
      state.activeTab = button.dataset.tab;
    });
  });
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  const identifier = document.getElementById('login-identifier').value;
  const password = document.getElementById('login-password').value;

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });

    const json = await response.json();

    if (!response.ok || !json.data || !json.data.token) {
      alert(json.error?.message || 'Connexion impossible.');
      return;
    }

    state.token = json.data.token;
    localStorage.setItem('lycee_token', state.token);
    setLoggedInState(json.data.user);
    await loadPosts();
  } catch (error) {
    alert('Le backend n’est pas disponible pour l’authentification.');
  }
}

async function handleRegisterSubmit(event) {
  event.preventDefault();

  const username = document.getElementById('register-username').value;
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;

  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    });

    const json = await response.json();

    if (!response.ok || !json.data || !json.data.token) {
      alert(json.error?.message || 'Inscription impossible.');
      return;
    }

    state.token = json.data.token;
    localStorage.setItem('lycee_token', state.token);
    setLoggedInState(json.data.user);
    await loadPosts();
  } catch (error) {
    alert('Le backend n’est pas disponible pour l’inscription.');
  }
}

async function handlePublish() {
  const content = document.getElementById('post-content').value.trim();
  if (!content) {
    alert('Rédigez un message avant de publier.');
    return;
  }

  try {
    const response = await fetch('/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      alert('Publication impossible. Vérifiez votre connexion.');
      return;
    }

    document.getElementById('post-content').value = '';
    await loadPosts();
  } catch (error) {
    alert('Connexion au serveur impossible. Votre publication n’a pas été enregistrée.');
  }
}

async function restoreSession() {
  if (!state.token) {
    return;
  }

  try {
    const response = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${state.token}` },
      cache: 'no-store',
    });
    const json = await response.json();

    if (!response.ok || !json.data?.user) {
      throw new Error('Stored session is no longer valid.');
    }

    setLoggedInState(json.data.user);
  } catch {
    state.token = '';
    localStorage.removeItem('lycee_token');
    localStorage.removeItem('lycee_user');
    setLoggedInState(null);
  }
}

function bindForms() {
  document.getElementById('login-form').addEventListener('submit', handleLoginSubmit);
  document.getElementById('register-form').addEventListener('submit', handleRegisterSubmit);
  document.getElementById('publish-button').addEventListener('click', handlePublish);
  logoutButton.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
      });
    } catch {
      alert('La session sera supprimée de cet appareil, mais sa révocation côté serveur a échoué.');
    } finally {
      state.token = '';
      localStorage.removeItem('lycee_token');
      localStorage.removeItem('lycee_user');
      setLoggedInState(null);
      showEmptyState('Connectez-vous pour voir le fil des publications.');
    }
  });
}

async function init() {
  bindTabs();
  bindForms();
  await restoreSession();

  const backendAvailable = await checkBackend();
  if (!backendAvailable) {
    showEmptyState('Le serveur est indisponible. Réessayez plus tard.');
    return;
  }

  notificationsList.replaceChildren();
  messagesList.replaceChildren();
  const notificationsEmpty = document.createElement('li');
  notificationsEmpty.textContent = 'Aucune notification chargée.';
  const messagesEmpty = document.createElement('li');
  messagesEmpty.textContent = 'Aucune conversation chargée.';
  notificationsList.append(notificationsEmpty);
  messagesList.append(messagesEmpty);
  await loadPosts();
}

init();
