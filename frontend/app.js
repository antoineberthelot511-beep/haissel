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
  posts: [],
};

const backendStatusEl = document.getElementById('backend-status');
const authPanel = document.getElementById('auth-panel');
const composerPanel = document.getElementById('composer-panel');
const feedEl = document.getElementById('feed');
const notificationsList = document.getElementById('notifications-list');
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

function formatRelativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'à l’instant';
  }

  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'il y a moins d’une minute';
  if (minutes < 60) return `il y a ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;

  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

function getAuthHeaders(extraHeaders = {}) {
  return {
    ...extraHeaders,
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };
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

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', ''].includes(normalized)) return false;
  }
  return Boolean(value);
}

function normalizePost(post) {
  return {
    ...post,
    likes_count: Number(post.likes_count || 0),
    comments_count: Number(post.comments_count || 0),
    liked_by_me: parseBooleanFlag(post.liked_by_me),
  };
}

function attachPostInteractions() {
  document.querySelectorAll('.like-toggle').forEach((button) => {
    button.addEventListener('click', async () => {
      const postId = Number(button.dataset.postId);
      if (!state.token || !state.user) {
        alert('Connectez-vous pour aimer une publication.');
        return;
      }

      const isLiked = button.dataset.liked === 'true';
      const method = isLiked ? 'DELETE' : 'POST';

      try {
        const response = await fetch(`/api/posts/${postId}/like`, {
          method,
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        });

        if (!response.ok) {
          const json = await response.json().catch(() => ({}));
          alert(json.error?.message || 'Impossible de mettre à jour le like.');
          return;
        }

        const target = state.posts.find((post) => Number(post.id) === postId);
        if (target) {
          const nextLiked = !isLiked;
          target.liked_by_me = nextLiked;
          target.likes_count = Math.max(0, target.likes_count + (nextLiked ? 1 : -1));
        }

        const nextCount = target ? target.likes_count : 0;
        const nextLikedState = target ? target.liked_by_me : false;
        const icon = button.querySelector('.icon');
        const count = button.querySelector('.count');
        if (icon) icon.textContent = nextLikedState ? '♥' : '♡';
        if (count) count.textContent = String(nextCount);
        button.dataset.liked = String(nextLikedState);
        button.classList.toggle('liked', nextLikedState);
      } catch (error) {
        alert('Le like n’a pas pu être enregistré.');
      }
    });
  });

  document.querySelectorAll('.comment-toggle').forEach((button) => {
    button.addEventListener('click', async () => {
      const postId = Number(button.dataset.postId);
      const panel = document.querySelector(`.comments-panel[data-panel="${postId}"]`);
      if (!panel) return;

      const isHidden = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !isHidden);

      if (isHidden) {
        await loadComments(postId);
      }
    });
  });

  document.querySelectorAll('.comment-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const postId = Number(form.dataset.postId);

      if (!state.token || !state.user) {
        alert('Connectez-vous pour laisser un commentaire.');
        return;
      }

      const textarea = form.querySelector('textarea');
      const content = textarea.value.trim();
      if (!content) {
        alert('Rédigez un commentaire avant de l’envoyer.');
        return;
      }

      try {
        const response = await fetch(`/api/posts/${postId}/comments`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ content }),
        });

        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          alert(json.error?.message || 'Le commentaire n’a pas pu être publié.');
          return;
        }

        textarea.value = '';
        const target = state.posts.find((post) => Number(post.id) === postId);
        if (target) {
          target.comments_count = Number(target.comments_count || 0) + 1;
        }

        const commentCount = document.querySelector(`.comment-toggle[data-post-id="${postId}"] .count`);
        if (commentCount) {
          commentCount.textContent = String(target ? target.comments_count : 0);
        }

        await loadComments(postId);
      } catch (error) {
        alert('Le commentaire n’a pas pu être enregistré.');
      }
    });
  });

  document.querySelectorAll('.comment-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      const commentId = Number(button.dataset.commentId);
      const postId = Number(button.dataset.postId);

      if (!state.token || !state.user) {
        alert('Vous devez être connecté pour supprimer un commentaire.');
        return;
      }

      try {
        const response = await fetch(`/api/comments/${commentId}`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
        });

        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          alert(json.error?.message || 'Suppression impossible.');
          return;
        }

        const target = state.posts.find((post) => Number(post.id) === postId);
        if (target && target.comments_count > 0) {
          target.comments_count -= 1;
        }

        const commentCount = document.querySelector(`.comment-toggle[data-post-id="${postId}"] .count`);
        if (commentCount) {
          commentCount.textContent = String(target ? target.comments_count : 0);
        }

        await loadComments(postId);
      } catch (error) {
        alert('Le commentaire n’a pas pu être supprimé.');
      }
    });
  });
}

function renderPosts(posts) {
  state.posts = (posts || []).map(normalizePost);

  if (!state.posts.length) {
    feedEl.innerHTML = '<div class="card"><p>Aucune publication pour le moment.</p></div>';
    return;
  }

  feedEl.innerHTML = state.posts
    .map((post) => {
      const author = post.author || { username: 'inconnu', display_name: 'Utilisateur' };
      const initials = (author.display_name || author.username || 'U')
        .split(' ')
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

      return `
        <article class="post-card" data-post-id="${post.id}">
          <div class="post-header">
            <div class="post-user">
              <div class="avatar">${escapeHTML(initials)}</div>
              <div>
                <strong>${escapeHTML(author.display_name || author.username)}</strong>
                <span>@${escapeHTML(author.username)} · ${escapeHTML(formatRelativeTime(post.created_at))}</span>
              </div>
            </div>
          </div>
          <div class="post-body">${escapeHTML(post.content)}</div>
          <div class="post-actions">
            <button
              type="button"
              class="action-button like-toggle ${post.liked_by_me ? 'liked' : ''}"
              data-post-id="${post.id}"
              data-liked="${String(parseBooleanFlag(post.liked_by_me))}"
            >
              <span class="icon">${parseBooleanFlag(post.liked_by_me) ? '♥' : '♡'}</span>
              <span class="count">${Number(post.likes_count || 0)}</span>
            </button>
            <button type="button" class="action-button comment-toggle" data-post-id="${post.id}">
              <span>💬</span>
              <span class="count">${Number(post.comments_count || 0)}</span>
            </button>
          </div>
          <div class="comments-panel hidden" data-panel="${post.id}">
            <div class="comment-list"></div>
            <form class="comment-form" data-post-id="${post.id}">
              <textarea
                rows="2"
                placeholder="${state.user ? 'Écrire un commentaire…' : 'Connectez-vous pour commenter'}"
                ${state.user ? '' : 'disabled'}
              ></textarea>
              <button type="submit" ${state.user ? '' : 'disabled'}>Publier</button>
            </form>
          </div>
        </article>
      `;
    })
    .join('');

  attachPostInteractions();
}

async function loadComments(postId) {
  const panel = document.querySelector(`.comments-panel[data-panel="${postId}"]`);
  if (!panel) return;

  const list = panel.querySelector('.comment-list');
  if (!list) return;

  list.innerHTML = '<div class="comment-loading">Chargement…</div>';

  try {
    const response = await fetch(`/api/posts/${postId}/comments`, {
      cache: 'no-store',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      list.innerHTML = '<div class="comment-empty">Impossible de charger les commentaires.</div>';
      return;
    }

    const json = await response.json().catch(() => ({}));
    const comments = Array.isArray(json?.data?.comments) ? json.data.comments : [];

    if (!comments.length) {
      list.innerHTML = '<div class="comment-empty">Aucun commentaire pour le moment.</div>';
      return;
    }

    list.innerHTML = comments
      .map((comment) => {
        const isMine = String(comment.user_id) === String(state.user?.id || '');
        return `
          <div class="comment-item">
            <div class="comment-header">
              <strong>${escapeHTML(comment.author_display_name || comment.author_username || 'Utilisateur')}</strong>
              <span>${escapeHTML(comment.author_username ? `@${comment.author_username}` : '')}</span>
              ${isMine ? `<button type="button" class="comment-delete" data-comment-id="${comment.id}" data-post-id="${postId}">Supprimer</button>` : ''}
            </div>
            <div class="comment-body">${escapeHTML(comment.content)}</div>
          </div>
        `;
      })
      .join('');

    attachPostInteractions();
  } catch (error) {
    list.innerHTML = '<div class="comment-empty">Impossible de charger les commentaires.</div>';
  }
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
    const response = await fetch('/api/posts', {
      cache: 'no-store',
      headers: getAuthHeaders(),
    });

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
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content }),
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(json.error?.message || 'Publication impossible. Vérifiez votre connexion.');
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
      headers: getAuthHeaders(),
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
        headers: getAuthHeaders(),
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
  const notificationsEmpty = document.createElement('li');
  notificationsEmpty.textContent = 'Aucune notification chargée.';
  notificationsList.append(notificationsEmpty);
  await loadPosts();
}

init();
