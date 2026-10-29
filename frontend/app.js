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
  community: { loaded: false, categories: {}, editing: null, reportId: null, pendingCategory: '' },
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

/** « il y a 3 h », « il y a 2 j » ; au-delà d'une semaine, la date. */
function formatAgo(value) {
  if (!value) return '';
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 24 * 60) return `il y a ${Math.floor(minutes / 60)} h`;
  if (minutes < 7 * 24 * 60) return `il y a ${Math.floor(minutes / (24 * 60))} j`;
  return `le ${formatDate(value)}`;
}

/** Icône du sprite de index.html (décorative). */
function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

/*
 * Icône par catégorie : les catégories sont gérées par l'administration, une
 * catégorie inconnue d'ici prend l'étiquette générique. Aucune photo.
 */
const CATEGORY_ICONS = {
  applications: 'i-cat-applications',
  jeux: 'i-cat-jeux',
  shopping: 'i-cat-shopping',
  services: 'i-cat-services',
  education: 'i-cat-education',
  sondages: 'i-cat-sondages',
};

function categoryIcon(category, className = 'icon') {
  return icon(CATEGORY_ICONS[category] || 'i-tag', className);
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
    throw new ApiError(0, 'NETWORK', 'Serveur injoignable. Vérifie ta connexion.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error?.message === 'string' ? payload.error.message : 'Une erreur est survenue.';
    const error = new ApiError(response.status, payload.error?.code || 'ERROR', message);
    // Nom du champ fautif, quand le serveur le précise (voir sendError).
    error.field = typeof payload.error?.field === 'string' ? payload.error.field : null;
    const sessionLost = response.status === 401 && state.user && !url.startsWith('/api/auth/');
    if (sessionLost || (response.status === 403 && error.code === 'ADMIN_LOCAL_ONLY' && state.user)) {
      showLoggedOut();
      setMessage('error', response.status === 401 ? 'Ta session a expiré. Reconnecte-toi.' : message);
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
  if (error) window.HaisselMotion?.shake(ui.authError);
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
  ui.sidebarEmail.textContent = state.user?.email || 'Connecte-toi';
  ui.welcomeName.textContent = state.user?.first_name || displayName.split(' ')[0];
  ui.profileDisplayName.textContent = displayName;
  ui.profileUsername.textContent = `@${state.user?.username || ''}`;
  ui.profileEmail.textContent = state.user?.email || '—';
  ui.profileFullName.textContent = state.user?.display_name || '—';
  ui.profileCreatedAt.textContent = formatDate(state.user?.created_at);
  ui.sidebarAvatar.textContent = initials;
  ui.profileAvatar.textContent = initials;
  ui.topbarAvatar.textContent = initials;
  ui.navAvatar.textContent = initials;

  ui.homeName.textContent = ui.welcomeName.textContent;
  ui.homeUsername.textContent = state.user ? `@${state.user.username}` : '—';
  ui.homeCreated.textContent = formatDate(state.user?.created_at);
  ui.statusBadge.textContent = state.user ? 'En ligne' : 'Connexion';
  ui.statusBadge.classList.toggle('offline', !state.user);
  ui.logoutButton.classList.toggle('hidden', !state.user);
}

function setActiveView(viewName) {
  // Barre principale et raccourcis de la colonne latérale.
  // « Déjà un compte ? Connecte-toi » et l'inverse, sous les formulaires.
  document.querySelectorAll('[data-switch-form]').forEach((button) => {
    button.addEventListener('click', () => showAuthForm(`${button.dataset.switchForm}-form`));
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `${viewName}-view`);
  });
  // Découvrir : barre du bas en version sombre (liquid-glass.css).
  document.body.dataset.view = viewName;
  // Sens du glissement (motion.js) : ordre des onglets de la barre du bas.
  window.HaisselMotion?.noteView(viewName);
  rememberView(viewName);
  // Messages = la conversation avec l'équipe ; la quitter la ferme (interrogation au rythme normal).
  if (viewName === 'messages' && state.user) openChat();
  else closeChat();
  refreshUnread();
  if (viewName === 'notifications' && state.user) showActivity();
  if (viewName === 'home' && state.user) renderHomeLearnCard();
  if ((viewName === 'learn' || viewName === 'home') && state.user && !state.learn.loaded) loadLearn();
  if ((viewName === 'links' || viewName === 'home' || viewName === 'discover') && state.user && !state.community.loaded) loadCommunity();
  if (viewName === 'publish' && state.user) loadMyOffers();
  if (viewName === 'profile' && state.user) {
    if (isAdultMember()) loadMyOffers();
    loadSavedOffers();
  }
  window.scrollTo({ top: 0 });
}

/*
 * L'onglet ouvert est gardé dans l'adresse (« /app#recherche ») : un
 * rechargement rouvre la même page. replaceState ne déclenche pas
 * « hashchange » et n'ajoute rien à l'historique.
 */
function rememberView(viewName) {
  if (!state.user) return;
  const hash = window.HaisselPush.hashForView(viewName);
  if (!hash || window.location.hash === hash) return;
  try {
    history.replaceState(history.state, '', window.location.pathname + window.location.search + hash);
  } catch (error) { /* adresse non modifiable : rien à mémoriser */ }
}

function showLoggedOut() {
  if (notificationCenter) notificationCenter.stop();
  resetChat();
  state.user = null;
  state.links = [];
  state.learn = { loaded: false, opportunities: [] };
  state.community = {
    loaded: false, categories: {}, editing: null, reportId: null, pendingCategory: '',
  };
  ui.authScreen.classList.remove('hidden');
  ui.appScreen.classList.add('hidden');
  updateUserSummary();
  setActiveView('home');
}

/*
 * Majorite declaree.
 *
 * Le masquage ci-dessous est un confort : il evite de proposer ce qui sera
 * refuse. La regle reelle est appliquee par le serveur (403), qui ne transmet
 * meme pas l'adresse des liens affiliés a un mineur.
 */
function isAdultMember() {
  return state.user?.is_adult === true;
}

/*
 * Publication ouverte aux membres majeurs : fiche campagne pour un membre,
 * lien affilié pour un ADMIN. Le serveur applique la même règle.
 */
function canPublish() {
  return isAdultMember();
}

function isAdminUser() {
  return state.user?.role === 'ADMIN';
}

/*
 * Formulaire « Publier » selon le rôle : un ADMIN publie un lien affilié
 * (« Partager un bon plan »), un membre une fiche campagne (page officielle,
 * nom de la campagne, conseils).
 */
function applyPublishMode() {
  const admin = isAdminUser();
  ui.publishForm.dataset.kind = admin ? 'affiliate' : 'campaign';
  document.getElementById('publish-title').textContent = admin ? 'Partager un bon plan 🚀' : 'Partager une fiche campagne';
  document.getElementById('publish-eyebrow').textContent = admin
    ? 'Partage ton lien d’affiliation avec la communauté.'
    : 'Tes conseils et les conditions d’une campagne, sans ton lien affilié.';
  document.getElementById('pub-url-label').textContent = admin
    ? 'Lien'
    : 'Lien vers la page officielle (site de l’annonceur ou page de la campagne sur MyLead)';
  const rights = document.getElementById('pub-rights-text');
  rights.replaceChildren(...(admin
    ? ['Ce lien vient de ', h('strong', null, 'mon propre compte éditeur'), ' et je respecte les conditions de la campagne.']
    : ['Ce lien mène à la ', h('strong', null, 'page officielle'), ', pas à mon lien affilié, et ma fiche respecte les conditions de la campagne.']));
  document.querySelectorAll('[data-campaign-only]').forEach((el) => { el.hidden = admin; });
  if (!state.community.editing) ui.publishFormTitle.textContent = admin ? 'Nouvelle offre' : 'Nouvelle fiche';
  document.getElementById('pub-step-1-label').textContent = admin ? 'Colle ton lien' : 'Lien officiel';
  document.getElementById('my-offers-label').textContent = admin ? 'Mes offres' : 'Mes fiches';
}

function needsAgeAnswer() {
  return Boolean(state.user) && state.user.adult_declaration_required === true;
}

/** Montre ou cache tout ce qui suppose 18 ans. */
function applyAgeRestrictions() {
  const adult = isAdultMember();
  applyPublishMode();
  const minor = Boolean(state.user) && state.user.is_adult === false;

  // Onglet « Publier » : retire de la navigation et des raccourcis.
  // [data-adult-only] : textes et blocs qui invitent à publier.
  document.querySelectorAll('[data-adult-only]').forEach((el) => {
    el.classList.toggle('hidden', !adult);
  });
  // Bouton +, « Publier » du profil, invitation à publier : aussi masqués
  // tant que la publication est réservée à l'équipe.
  const publish = canPublish();
  document.querySelectorAll('[data-view="publish"], [data-goto="publish"], [data-publish-only]').forEach((el) => {
    el.classList.toggle('hidden', !publish);
  });
  // Parcours MyLead et Parrainage : rubriques de l'espace Apprendre.
  document.querySelectorAll('[data-learn-tab="mylead"], [data-learn-tab="referral"]').forEach((el) => {
    el.classList.toggle('hidden', !adult);
  });

  const notice = document.getElementById('minor-notice');
  if (notice) notice.classList.toggle('hidden', !minor);

  // Une rubrique masquée ne doit pas rester la rubrique active.
  const activeTab = document.querySelector('.learn-tab.active');
  if (!adult && activeTab && ['mylead', 'referral'].includes(activeTab.dataset.learnTab)) {
    setLearnTab('guides');
  }
  // Idem pour la vue : qui ne peut pas publier ne reste pas sur « Publier ».
  if (!publish && !document.getElementById('publish-view').classList.contains('hidden')) {
    setActiveView('home');
  }
  renderHomeLearnCard();
  // « Mes offres » n'existe que pour les majeurs : un mineur arrive sur « Sauvegardées ».
  const tab = document.querySelector('.profile-tab[aria-selected="true"]');
  if (!tab || (!adult && tab.dataset.profileTab === 'offers')) setProfileTab(adult ? 'offers' : 'saved');
}

/** Onglets du profil : Mes offres, Sauvegardées, Sécurité. */
function setProfileTab(name) {
  document.querySelectorAll('.profile-tab').forEach((tab) => {
    const active = tab.dataset.profileTab === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  for (const key of ['offers', 'saved', 'account', 'security', 'settings']) {
    document.getElementById(`ppanel-${key}`).hidden = key !== name;
  }
}

/*
 * Bandeau « Apprendre » de l'accueil, sur une ligne. Le seul chiffre affiché
 * est la progression du parcours MyLead, enregistrée dans ce navigateur par
 * mylead-guide.js ; le parcours n'existe que pour les majeurs. Un mineur
 * voit une invitation aux guides, sans chiffre. Le bandeau se masque ;
 * Apprendre reste accessible depuis le profil.
 */
function renderHomeLearnCard() {
  if (!ui.homeLearnCard || !ui.homeLearnStep) return;
  const guide = window.HaisselMyLeadGuide;
  ui.homeLearnCard.hidden = Boolean(guide?.bannerHidden?.());
  const progress = isAdultMember() && guide?.progress ? guide.progress() : null;

  if (progress) {
    const finished = progress.done >= progress.total;
    ui.homeLearnStep.textContent = finished ? 'Parcours terminé' : `Étape ${progress.done + 1} sur ${progress.total}`;
    ui.homeLearnText.textContent = 'Débuter sur MyLead';
    ui.homeLearnGo.dataset.tab = 'mylead';
  } else {
    ui.homeLearnStep.textContent = 'Guides';
    ui.homeLearnText.textContent = 'Les bases de l’affiliation';
    ui.homeLearnGo.dataset.tab = 'guides';
  }
}

/* Vignette carrée de la grille « Recherche » : toucher ouvre le détail. */
function gridTile(offer) {
  return h('button', {
    className: `grid-cell${offer.expired ? ' is-expired' : ''}`, type: 'button', 'aria-label': `Voir l’offre « ${offer.title} »`,
    onclick: () => openOffer(offer),
  }, categoryVisual(offer.category, 'grid-tile',
    h('span', { className: 'grid-tile-icon', 'aria-hidden': 'true' }, categoryIcon(offer.category, 'icon')),
    h('span', { className: 'grid-tile-title' }, offer.title),
    offer.kind === 'affiliate' ? h('span', { className: 'grid-tile-tag', title: 'Lien affilié' }, icon('i-link', 'icon sm')) : null));
}

function showLoggedIn(user) {
  state.user = user;
  ui.authScreen.classList.add('hidden');
  ui.appScreen.classList.remove('hidden');
  updateUserSummary();
  applyAgeRestrictions();
  renderMfaState();
  renderProfileVisibility();
  // Comptes anterieurs a la declaration : la question passe avant tout.
  if (needsAgeAnswer()) openAgeGate();
  /*
   * Vue de départ lue dans l'adresse AVANT tout rendu : l'Accueil n'est pas
   * affiché puis remplacé par la page demandée.
   */
  const startView = initialView();
  setActiveView(startView);
  // Sans liste d'offres à charger, rien d'autre n'attend l'écran de démarrage.
  if (!['home', 'links', 'discover'].includes(startView)) bootReady();
  loadLinks();
  // Première visite d'un membre connecté sur cet appareil : point de départ des 3 jours.
  if (!storageGet(INSTALL_KEYS.firstSeen)) storageSet(INSTALL_KEYS.firstSeen, String(Date.now()));
  welcomeNewMember(user);
  renderInstallUi();
  autoTuto.done = false;
  autoTuto.tries = 0;
  scheduleAutoTuto();
  if (notificationCenter) notificationCenter.start();
  startUnreadPolling();
  syncPush();
}

// ---------------------------------------------------------------------------
// Question de majorite (comptes existants)
// ---------------------------------------------------------------------------

/*
 * Ecran bloquant : le contenu de dessous est rendu inerte, sinon la question
 * serait contournable a la tabulation. Pas de bouton « fermer » : il n'y a
 * pas de troisieme reponse possible.
 */
/*
 * Contenu situé derrière l'écran : les deux enfants directs de <body>. Le lien
 * « Aller au contenu » n'est PAS dans .app-shell ; l'oublier laissait la
 * tabulation l'atteindre, puis repartir dans la page masquée.
 */
function setGateInert(on) {
  for (const selector of ['.skip-link', '.app-shell']) {
    window.HaisselInert.set(document.querySelector(selector), 'age-gate', on);
  }
}

function openAgeGate() {
  const gate = document.getElementById('age-gate');
  if (!gate) return;
  gate.hidden = false;
  document.body.classList.add('age-gate-open');
  setGateInert(true);
  document.getElementById('age-gate-error').classList.add('hidden');
  gate.focus({ preventScroll: true });
}

function closeAgeGate() {
  const gate = document.getElementById('age-gate');
  if (!gate) return;
  gate.hidden = true;
  document.body.classList.remove('age-gate-open');
  setGateInert(false);
  // La feuille d'installation attendait peut-être la fin de la question.
  autoTuto.tries = 0;
  scheduleAutoTuto();
}

async function answerAgeGate(isAdultAnswer) {
  const error = document.getElementById('age-gate-error');
  error.classList.add('hidden');
  try {
    const data = await api('/api/auth/adult-declaration', { method: 'POST', body: { is_adult: isAdultAnswer } });
    state.user = data.user;
    closeAgeGate();
    applyAgeRestrictions();
    updateUserSummary();
    setMessage('info', isAdultAnswer
      ? 'Merci. Tu as acces a l\u2019ensemble du site.'
      : 'Merci. Les guides de l\u2019espace Apprendre restent accessibles.');
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

function linkCard(link) {
  return h('article', { className: 'offer-card' },
    h('div', { className: 'offer-logo', 'aria-hidden': 'true' }, (link.name || 'H').charAt(0).toUpperCase()),
    h('div', { className: 'offer-body' },
      h('div', { className: 'offer-header-line' },
        h('h3', null, link.name),
        // Transparence commerciale (Code de la consommation L. 121-1, loi du 9 juin 2023).
        h('span', { className: 'pill ad', title: 'Lien affilié : HAISSEL peut percevoir une commission si tu utilises ce lien.' }, icon('i-link', 'icon sm'), 'Lien affilié')),
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

// ---------------------------------------------------------------------------
// Page d'accueil (encadrés)
// ---------------------------------------------------------------------------

function widgetItems(container, items, emptyMessage) {
  container.replaceChildren(...(items.length ? items : [h('li', { className: 'widget-empty' }, emptyMessage)]));
}

function renderHomeLinks() {
  widgetItems(ui.homeLinks, state.links.slice(0, 5).map((link) => h('li', null,
    h('a', { href: link.go_url, target: '_blank', rel: 'noopener noreferrer' }, link.name),
    h('span', { className: 'pill ad' }, 'Lien affilié'))), 'Aucun lien publié pour le moment.');
}

function renderHomeLearn(items) {
  widgetItems(ui.homeLearn, items.slice(0, 5).map((item) => h('li', null,
    h('button', { className: 'widget-link', type: 'button', onclick: () => { setActiveView('learn'); setLearnTab(item.kind === 'guide' ? 'guides' : 'tutorials'); } }, item.title),
    h('small', null, item.kind === 'guide' ? 'Guide' : 'Tutoriel'))), 'Les guides arrivent bientôt.');
}

function renderLinks() {
  renderHomeLinks();
  ui.linksList.setAttribute('aria-busy', 'false');
  ui.linksList.replaceChildren(...(state.links.length
    ? state.links.map(linkCard)
    : [h('div', { className: 'panel-card' }, 'Aucun lien publié pour le moment. Reviens plus tard !')]));
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
  else if (wrongCountry) action = h('p', { className: 'learn-warning' }, 'Ton pays ne fait pas partie des pays acceptés : lien masqué.');
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
      item.is_affiliate ? h('span', { className: 'pill ad', title: 'Lien affilié : HAISSEL peut percevoir une commission.' }, 'Lien affilié') : null,
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
    /*
     * Le parrainage est réservé aux majeurs : sans majorité déclarée, on ne
     * l'appelle pas du tout. S'il est refusé quand même (403), son échec ne
     * doit pas emporter les guides et les opportunités, qui restent ouverts.
     * D'où le catch individuel plutôt qu'un Promise.all strict.
     */
    const restricted = { available: false, restricted: true };
    const [content, opportunities, referral] = await Promise.all([
      api('/api/learn/content'),
      api('/api/learn/opportunities'),
      state.user?.is_adult !== true ? restricted : api('/api/learn/referral').catch((error) => {
        if (error.status === 403) return restricted;
        throw error;
      }),
    ]);
    const items = content.items || [];
    state.learn = { loaded: true, opportunities: opportunities.items || [] };
    renderLearnList(ui.learnGuidesList, items.filter((item) => item.kind === 'guide'), contentCard,
      'Les guides sont en cours de relecture. Reviens bientôt !');
    renderLearnList(ui.learnTutorialsList, items.filter((item) => item.kind === 'tutorial'), contentCard,
      'Les tutoriels sont en cours de relecture. Reviens bientôt !');
    renderOpportunities();
    renderReferral(referral);
    renderHomeLearn(items);
    renderMyLeadGuide(referral);
  } catch (error) {
    if (error.status === 401 || error.status === 403) return;
    for (const list of lists) {
      list.setAttribute('aria-busy', 'false');
      list.replaceChildren(h('div', { className: 'panel-card is-error mascot-state', role: 'alert' }, bear('oups-erreur', 120),
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
// Offres de la communauté
// ---------------------------------------------------------------------------

const OFFER_STATUS_LABELS = {
  pending: ['En attente', 'pending'],
  published: ['Publiée', 'published'],
  rejected: ['Refusée', 'rejected'],
};

/*
 * Avatar de l'équipe (l'ours) : toujours rond, 128 px jusqu'à 64 px affichés,
 * 256 px au-delà. Le logo « H » reste celui de l'application.
 */
function teamAvatar(size, className = '') {
  const file = size <= 64 ? 'avatar-equipe-128.webp' : 'avatar-equipe-256.webp';
  return h('img', { className: `team-avatar ${className}`.trim(), src: `/images/mascotte/${file}`, alt: 'Équipe Haissel', width: size, height: size, decoding: 'async' });
}

/* Ours de la mascotte (mascot.js) ; rien si le script manque. */
function bear(name, size) {
  return window.HaisselMascot ? window.HaisselMascot.mascot(name, { size }) : null;
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function fillCategorySelect(select, categories, firstLabel) {
  const current = select.value;
  select.replaceChildren(h('option', { value: '' }, firstLabel),
    ...Object.entries(categories).map(([value, label]) => h('option', { value }, label)));
  select.value = current;
}

/** Ouvre un lien de membre après confirmation (domaine affiché, âge rappelé). */
/*
 * Ouverture d'une offre de la communauté.
 *
 * L'adresse de destination n'est PAS dans la liste reçue : le navigateur la
 * demande au serveur au moment du clic, ce qui laisse au serveur le dernier
 * mot (majorité déclarée, âge minimum de l'offre). Si elle est déjà connue
 * (offre dont on est l'auteur), on l'utilise directement.
 */
function confirmLeave(offer) {
  ui.leaveDomain.textContent = offer.domain || 'site externe';
  ui.leaveAge.textContent = offer.min_age ? `Offre réservée aux ${offer.min_age} ans et plus : ne continue que si tu as cet âge.` : '';
  ui.leaveAge.classList.toggle('hidden', !offer.min_age);
  ui.leaveDialog.returnValue = '';
  ui.leaveDialog.addEventListener('close', async () => {
    if (ui.leaveDialog.returnValue !== 'confirm') return;
    /*
     * Onglet ouvert AVANT l'appel réseau : un onglet ouvert plus tard, hors du
     * geste de l'utilisateur, est bloqué (Safari iOS).
     * Pas d'option « noopener » : avec elle, window.open renvoie toujours null
     * et la référence à l'onglet est perdue. Le lien avec cette page est coupé
     * à la main (opener = null) ; le référent, lui, n'est jamais transmis
     * (Referrer-Policy: no-referrer, voir src/app.js).
     */
    const tab = window.open('about:blank', '_blank');
    if (tab) {
      try { tab.opener = null; } catch (error) { /* propriété non modifiable */ }
    }
    // Bloqueur de fenêtres : le lien s'ouvre dans l'onglet courant.
    const go = (url) => (tab ? tab.location.replace(url) : window.location.assign(url));

    if (offer.url) {
      go(offer.url);
      return;
    }
    try {
      const data = await api(`/api/community/offers/${encodeURIComponent(offer.id)}/open`);
      go(data.url);
    } catch (error) {
      if (tab) tab.close();
      setMessage('error', error.message);
    }
  }, { once: true });
  openDialog(ui.leaveDialog);
}

/*
 * Bouton « Sauvegarder ». Deux présentations : icône seule (carte du fil)
 * ou icône et texte (détail d'une offre), choisies par data-variant.
 */
function paintSaveButton(button, saved) {
  const label = saved ? 'Sauvegardée' : 'Sauvegarder';
  button.setAttribute('aria-pressed', String(saved));
  if (button.dataset.variant === 'text') {
    button.replaceChildren(icon(saved ? 'i-bookmark-fill' : 'i-bookmark'), label);
  } else {
    button.replaceChildren(icon(saved ? 'i-bookmark-fill' : 'i-bookmark', 'icon lg'), h('span', { className: 'visually-hidden' }, label));
  }
}

function saveButtonFor(offer, { variant = 'icon', disabled = false } = {}) {
  const button = h('button', {
    className: variant === 'text' ? 'save-button text' : 'save-button', type: 'button', disabled,
    'data-variant': variant, title: 'Sauvegarder pour plus tard',
    onclick: () => toggleSave(offer, button),
  });
  paintSaveButton(button, offer.saved);
  return button;
}

/*
 * Badge de l'offre. Mention en toutes lettres : « Publicité » seul était trop
 * vague. Lien affilié = publié par un ADMIN ; fiche campagne = membre, avec un
 * lien vers la page officielle.
 */
/*
 * Temps de visibilité restant d'une fiche campagne (format « story ») :
 * « encore 5 h », arrondi à l'heure, puis « moins d'1 h ». null pour une
 * offre sans limite (ADMIN) ou une fiche déjà expirée.
 */
function storyTimeLeft(offer) {
  if (offer.kind !== 'campaign' || !offer.expires_at || offer.expired) return null;
  const left = new Date(offer.expires_at).getTime() - Date.now();
  if (left <= 0) return null;
  const hours = left / 3600000;
  return hours < 1 ? 'moins d’1 h' : `encore ${Math.round(hours)} h`;
}

/*
 * Couleurs des catégories (grande zone visuelle des publications, vignettes).
 * Catégorie inconnue (créée depuis la console) : couleur neutre.
 */
const CATEGORY_COLORS = {
  applications: ['var(--brand)', 'var(--brand-light)'],
  jeux: ['#7c3aed', '#c084fc'],
  shopping: ['#db2777', '#f9a8d4'],
  services: ['#0d9488', '#5eead4'],
  education: ['#ea580c', '#fdba74'],
  sondages: ['#ca8a04', '#fde047'],
};

function categoryVisual(category, className, ...children) {
  const [from, to] = CATEGORY_COLORS[category] || ['#475569', '#94a3b8'];
  const element = h('div', { className }, ...children);
  element.style.setProperty('--cat-from', from);
  element.style.setProperty('--cat-to', to);
  return element;
}

/*
 * Publication du fil d'Accueil, façon Instagram : en-tête, grande zone
 * carrée, actions, texte. Toucher la zone ouvre le détail habituel (règles
 * d'âge et confirmation de sortie inchangées).
 */
function postCard(offer) {
  const left = storyTimeLeft(offer);
  // Pastille en verre posée sur le visuel coloré (liquid-glass.css).
  const visual = categoryVisual(offer.category, 'post-visual',
    h('span', { className: 'post-visual-icon lg-glass', 'aria-hidden': 'true' }, categoryIcon(offer.category, 'icon')),
    h('h3', { className: 'post-visual-title' }, offer.title),
    offer.kind === 'campaign' && offer.campaign_name ? h('p', { className: 'post-visual-sub' }, offer.campaign_name) : null);
  return h('article', { className: 'post-card' },
    h('header', { className: 'post-head' },
      storyAvatar(offer.author.username, 'story-avatar sm'),
      h('div', { className: 'post-who' },
        h('button', { className: 'post-author', type: 'button', onclick: () => openMember(offer.author.username) }, offer.author.username),
        h('span', null, [offer.category_label, formatAgo(offer.shown_at || offer.published_at)].filter(Boolean).join(' · '))),
      kindBadge(offer)),
    h('button', { className: 'post-open', type: 'button', 'aria-label': `Voir l’offre « ${offer.title} »`, onclick: () => openOffer(offer) }, visual),
    h('div', { className: 'post-actions' },
      offer.is_mine ? null : saveButtonFor(offer),
      offer.is_mine ? null : h('button', {
        className: 'post-action', type: 'button', 'aria-label': `Signaler « ${offer.title} »`, onclick: () => openReport(offer),
      }, icon('i-flag', 'icon lg')),
      h('span', { className: 'post-spacer' }),
      offer.min_age ? h('span', { className: 'pill adult' }, `${offer.min_age} ans et +`) : null),
    h('p', { className: 'post-todo' }, h('strong', null, 'Ce qu’il faut faire : '), offer.expected_action),
    h('p', { className: 'post-meta' },
      offer.countries ? h('span', null, icon('i-globe', 'icon sm'), offer.countries) : null,
      left ? h('span', null, icon('i-clock', 'icon sm'), left) : null));
}

/*
 * Découvrir (façon Reels) : une offre par écran, défilement vertical aimanté
 * (scroll-snap). Rien n'est lu automatiquement ; « Voir » passe par la
 * confirmation de sortie habituelle et n'apparaît que si le serveur permet
 * d'ouvrir le lien (mineurs, âge minimum : règles inchangées).
 */
function discoverSlide(offer) {
  const left = storyTimeLeft(offer);
  const sideButton = (label, iconName, onclick) => h('button', { className: 'discover-action', type: 'button', onclick },
    icon(iconName, 'icon lg'), h('span', null, label));
  const save = offer.is_mine ? null : saveButtonFor(offer);
  return h('section', { className: 'discover-slide', 'aria-label': offer.title },
    categoryVisual(offer.category, 'discover-card',
      h('span', { className: 'post-visual-icon', 'aria-hidden': 'true' }, categoryIcon(offer.category, 'icon')),
      h('h2', { className: 'discover-title' }, offer.title),
      offer.kind === 'campaign' && offer.campaign_name ? h('p', { className: 'post-visual-sub' }, offer.campaign_name) : null),
    // Panneau texte et colonne de boutons en verre sombre, posés sur l'image.
    h('div', { className: 'discover-text lg-glass' },
      h('p', { className: 'discover-who' },
        storyAvatar(offer.author.username, 'story-avatar sm'),
        h('button', { className: 'post-author', type: 'button', onclick: () => openMember(offer.author.username) }, offer.author.username),
        kindBadge(offer)),
      h('p', null, h('strong', null, 'Ce qu’il faut faire : '), offer.expected_action),
      h('p', { className: 'discover-meta' },
        [offer.countries, offer.min_age ? `${offer.min_age} ans et +` : null, left].filter(Boolean).join(' · '))),
    h('div', { className: 'discover-side lg-glass lg-pill' },
      save,
      offer.is_mine ? null : sideButton('Signaler', 'i-flag', () => openReport(offer)),
      offer.can_open ? sideButton('Voir', 'i-external', () => confirmLeave(offer)) : null));
}

function renderDiscover(items) {
  if (!ui.discoverFeed) return;
  const list = [...items.filter((offer) => offer.kind !== 'campaign'), ...items.filter((offer) => offer.kind === 'campaign')];
  ui.discoverFeed.replaceChildren(...(list.length ? list.map(discoverSlide) : [discoverEmpty()]));
}

/*
 * Découvrir vide : l'ours qui cherche (entrée douce puis léger balancement
 * toutes les 4 s, coupé en mouvement réduit), sur le fond sombre de
 * Découvrir ; « Actualiser » recharge les offres (petit loader en attendant).
 */
function discoverEmpty() {
  const bearImg = bear('rien-a-decouvrir', 160);
  bearImg?.classList.add('discover-bear');
  return h('section', { className: 'discover-slide is-empty' },
    h('div', { className: 'discover-empty' },
      bearImg,
      h('h2', { className: 'discover-empty-title' }, 'Rien à découvrir pour le moment'),
      h('p', { className: 'discover-empty-text' }, 'Les nouvelles offres arrivent ici dès qu’elles sont validées.'),
      h('button', {
        className: 'secondary-button small-button discover-refresh', type: 'button',
        onclick: () => { showDiscoverLoading(); state.community.loaded = false; loadCommunity(); },
      }, icon('i-refresh', 'icon sm'), 'Actualiser')));
}

/* Chargement : petit loader sur le fond sombre (jamais d'écran noir vide). */
function showDiscoverLoading() {
  if (!ui.discoverFeed) return;
  ui.discoverFeed.replaceChildren(h('section', { className: 'discover-slide is-empty', 'aria-busy': 'true' },
    h('div', { className: 'loader', role: 'status', 'aria-label': 'Chargement' })));
}

function storyBadge(offer) {
  if (offer.expired) return h('span', { className: 'pill expired' }, 'Expirée');
  const left = storyTimeLeft(offer);
  return left ? h('span', { className: 'pill story', title: 'Une fiche campagne reste visible 24 h.' }, icon('i-clock', 'icon sm'), left) : null;
}

/*
 * Badge du type d'offre, partout où une offre apparaît (fil, Découvrir,
 * stories, page de l'offre). Lien de l'équipe : « Lien affilié » visible,
 * avec « En savoir plus » vers la page Transparence. Fiche d'un membre :
 * « Fiche membre · lien officiel ».
 */
function kindBadge(offer) {
  if (offer.kind === 'campaign') {
    return h('span', { className: 'kind-badge' },
      h('span', { className: 'pill campaign', title: 'Fiche d’un membre : le lien mène à la page officielle, pas à un lien affilié.' },
        icon('i-info', 'icon sm'), 'Fiche membre · lien officiel'));
  }
  return h('span', { className: 'kind-badge' },
    h('span', { className: 'pill ad', title: 'Lien affilié : HAISSEL peut toucher une commission si tu réalises l’action.' },
      icon('i-link', 'icon sm'), 'Lien affilié'),
    h('a', { className: 'kind-more', href: 'transparence.html' }, 'En savoir plus'));
}

/*
 * Carte du fil d'offres (accueil, recherche, profil d'un membre, aperçu).
 * Elle résume l'offre ; la description, les conditions et le signalement
 * sont dans le détail (openOffer). Aucune photo : une icône de catégorie.
 */
function communityCard(offer, { preview = false } = {}) {
  const author = `@${offer.author.username}`;
  return h('article', { className: `offer-card community-card${offer.expired ? ' is-expired' : ''}` },
    h('div', { className: 'fc-head' },
      h('span', { className: 'fc-avatar', 'aria-hidden': 'true' }, categoryIcon(offer.category)),
      h('div', { className: 'fc-who' },
        preview
          ? h('strong', { className: 'fc-author' }, author)
          : h('button', { className: 'fc-author', type: 'button', onclick: () => openMember(offer.author.username) }, author),
        h('span', { className: 'fc-time' }, preview ? 'à l’instant' : formatAgo(offer.shown_at || offer.published_at || offer.created_at))),
      kindBadge(offer)),
    h('div', { className: 'fc-body' },
      h('p', { className: 'fc-meta' },
        offer.countries ? h('span', null, icon('i-globe', 'icon sm'), offer.countries) : null,
        h('span', null, offer.category_label),
        offer.min_age ? h('span', { className: 'pill adult' }, `${offer.min_age} ans et +`) : null,
        preview ? null : storyBadge(offer)),
      h('h3', { className: 'fc-title' }, offer.title),
      offer.kind === 'campaign' && offer.campaign_name ? h('p', { className: 'fc-campaign' }, `Campagne : ${offer.campaign_name}`) : null,
      offer.domain ? h('p', { className: 'fc-domain' }, offer.domain) : null,
      h('p', { className: 'fc-todo' },
        icon('i-check-circle'),
        h('span', null, h('strong', null, 'Ce qu’il faut faire : '), offer.expected_action))),
    h('div', { className: 'fc-actions' },
      h('button', {
        className: 'offer-link-button', type: 'button', disabled: preview,
        'aria-label': `Voir l’offre « ${offer.title} »`,
        onclick: () => openOffer(offer),
      }, 'Voir l’offre', icon('i-arrow-right')),
      offer.is_mine || preview ? null : saveButtonFor(offer)));
}

// ---------------------------------------------------------------------------
// Détail d'une offre
// ---------------------------------------------------------------------------

/*
 * Vue plein écran, ouverte depuis une carte. Elle reprend l'offre déjà reçue
 * (aucun appel réseau) ; le lien lui-même passe toujours par confirmLeave,
 * qui le demande au serveur au moment du clic.
 *
 * Une entrée d'historique est ajoutée : le bouton « retour » du téléphone
 * ferme le détail au lieu de quitter le site.
 */
function openOffer(offer) {
  if (ui.memberDialog.open) closeDialog(ui.memberDialog);
  const current = document.querySelector('.view-panel:not(.hidden)');
  if (current && current.id !== 'offer-view') {
    state.community.returnView = current.id.replace(/-view$/, '');
    state.community.returnScroll = window.scrollY;
  }
  ui.offerDetail.replaceChildren(...offerDetail(offer));
  setActiveView('offer');
  try {
    if (!window.history.state?.haisselOffer) window.history.pushState({ haisselOffer: offer.id }, '', window.location.href);
  } catch (error) { /* navigateur sans History API : le bouton « retour » de la vue suffit */ }
  document.getElementById('offer-title')?.focus({ preventScroll: true });
}

function closeOffer() {
  setActiveView(state.community.returnView || 'home');
  window.scrollTo({ top: state.community.returnScroll || 0 });
}

function leaveOfferView() {
  if (window.history.state?.haisselOffer) window.history.back(); // → popstate → closeOffer
  else closeOffer();
}

function offerDetail(offer) {
  const fact = (label, value, note) => (value ? h('div', { className: note ? 'od-fact wide' : 'od-fact' },
    h('dt', null, label), h('dd', null, value, note ? h('small', null, note) : null)) : null);
  const step = (n, title, text) => h('li', null,
    h('span', { className: 'od-step-no', 'aria-hidden': 'true' }, String(n)),
    h('div', null, h('strong', null, title), h('span', null, text)));
  const author = offer.author.username;
  const published = offer.status === 'published';
  const campaign = offer.kind === 'campaign';
  const openLabel = campaign ? 'Voir la page officielle' : 'Ouvrir le lien (site officiel)';

  return [
    h('div', { className: 'od-top' },
      h('button', { className: 'round-button', type: 'button', 'aria-label': 'Retour', onclick: leaveOfferView }, icon('i-arrow-left')),
      h('div', { className: 'od-badges' },
        offer.countries ? h('span', { className: 'pill' }, icon('i-globe', 'icon sm'), offer.countries) : null,
        kindBadge(offer))),

    h('article', { className: 'od-card od-hero' },
      h('div', { className: 'od-hero-head' },
        h('span', { className: 'od-icon', 'aria-hidden': 'true' }, categoryIcon(offer.category, 'icon')),
        h('div', null,
          h('span', { className: 'pill' }, offer.category_label),
          h('h2', { id: 'offer-title', tabindex: '-1' }, offer.title))),
      published ? h('p', { className: 'od-verified' },
        icon('i-shield-check'), h('span', null, 'Vérifiée par l’équipe HAISSEL'),
        h('small', null, formatAgo(offer.published_at))) : null,
      h('dl', { className: 'od-facts' },
        campaign ? fact('Campagne MyLead', offer.campaign_name) : null,
        fact('Catégorie', offer.category_label),
        fact('Pays', offer.countries),
        offer.min_age ? fact('Âge minimum', `${offer.min_age} ans`) : null,
        // Aucun montant inventé : seulement ce que l'auteur a saisi, avec la mise en garde.
        fact('Rémunération annoncée', offer.payout_text, 'indicatif, non garanti'),
        fact('Site', offer.domain))),

    h('section', { className: 'od-card', 'aria-labelledby': 'offer-todo-title' },
      h('h3', { id: 'offer-todo-title', className: 'od-title-dot' }, 'Ce qu’il faut faire'),
      h('p', { className: 'od-description' }, offer.description),
      h('ol', { className: 'od-steps' },
        step(1, `Clique sur « ${campaign ? 'Voir la page officielle' : 'Ouvrir le lien'} » ci-dessous`, 'HAISSEL te demande de confirmer avant de quitter le site.'),
        step(2, offer.expected_action, 'C’est l’action attendue par le site partenaire.'),
        step(3, 'Lis les conditions du site partenaire', 'Elles priment toujours sur ce résumé.'))),

    campaign && offer.tips ? h('section', { className: 'od-card', 'aria-labelledby': 'offer-tips-title' },
      h('h3', { id: 'offer-tips-title' }, `Les conseils de @${author}`),
      h('p', { className: 'od-description' }, offer.tips)) : null,

    h('section', { className: 'od-card', 'aria-labelledby': 'offer-terms-title' },
      h('h3', { id: 'offer-terms-title' }, 'Conditions claires'),
      h('p', { className: 'od-muted' }, campaign
        ? 'Cette fiche mène à la page officielle : ce n’est pas un lien affilié. Pour participer à la campagne, récupère ton propre lien sur MyLead. Aucun gain n’est garanti.'
        : 'Ce lien est un lien affilié publié par l’équipe : HAISSEL peut toucher une commission. Ça ne te coûte rien de plus, et aucun gain n’est garanti.'),
      offer.conditions ? h('p', { className: 'od-conditions' }, offer.conditions) : null,
      h('div', { className: 'od-tags' },
        offer.min_age ? h('span', { className: 'pill' }, icon('i-shield', 'icon sm'), `Réservé aux ${offer.min_age} ans et +`) : null,
        h('a', { className: 'pill pill-link', href: 'transparence.html' }, icon('i-info', 'icon sm'), 'Transparence affiliation'))),

    h('section', { className: 'od-card od-author' },
      h('span', { className: 'avatar', 'aria-hidden': 'true' }, initialsFromName(author)),
      h('div', null,
        h('button', { className: 'fc-author', type: 'button', onclick: () => openMember(author) }, `@${author}`),
        h('p', null, `Membre de la communauté · publiée ${formatAgo(offer.published_at || offer.created_at)}`))),

    h('div', { className: 'od-actions' },
      /*
       * can_open vient du serveur. Un mineur, ou une offre dont l'âge minimum
       * dépasse ce que HAISSEL peut certifier, voit la raison plutôt qu'un
       * bouton qui échouerait.
       */
      offer.can_open === false
        ? h('p', { className: 'offer-blocked' }, icon('i-lock'), 'Accessible à partir de 18 ans : le lien n’est pas affiché.')
        : h('button', {
          className: 'offer-link-button od-open', type: 'button',
          'aria-label': `${openLabel} : « ${offer.title} » (site externe, nouvel onglet)`,
          onclick: () => confirmLeave(offer),
        }, openLabel, icon('i-external')),
      offer.is_mine ? null : saveButtonFor(offer, { variant: 'text' }),
      offer.is_mine ? null : h('button', { className: 'text-button od-report', type: 'button', onclick: () => openReport(offer) },
        icon('i-flag', 'icon sm'), 'Un problème ? Signaler cette offre')),
  ];
}

function communityQuery() {
  const params = new URLSearchParams();
  const q = ui.communityQ.value.trim();
  if (q) params.set('q', q);
  if (ui.communityCategory.value) params.set('category', ui.communityCategory.value);
  if (ui.communityKind.value) params.set('kind', ui.communityKind.value);
  if (ui.communitySort.value) params.set('sort', ui.communitySort.value);
  if (ui.communitySaved.checked) params.set('saved', '1');
  return params.toString();
}

/*
 * Les filtres vivent dans l'adresse de la page : une recherche peut être
 * partagée ou mise en favori, et le bouton « précédent » du téléphone
 * retrouve l'état précédent. replaceState : on n'empile pas une entrée
 * d'historique à chaque frappe dans le champ de recherche.
 */
function syncFiltersToUrl() {
  const query = communityQuery();
  const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  try {
    window.history.replaceState(null, '', url + window.location.hash);
  } catch (error) { /* navigateur sans History API : sans conséquence */ }
}

/** Remplit les filtres depuis l'adresse au premier affichage. */
function readFiltersFromUrl() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (error) {
    return;
  }
  const q = params.get('q');
  const category = params.get('category');
  if (q) ui.communityQ.value = q.slice(0, 80);
  const kind = params.get('kind');
  if (kind === 'campaign' || kind === 'affiliate') ui.communityKind.value = kind;
  if (params.get('sort') === 'popular') ui.communitySort.value = 'popular';
  ui.communitySaved.checked = params.get('saved') === '1';
  paintSearchControls();
  // La catégorie est appliquée après le remplissage de la liste déroulante.
  state.community.pendingCategory = category || '';
}

/** Petit loader centré (suite du fil, résultats de Recherche). */
function loaderRow() {
  return h('div', { className: 'loader-row' }, h('div', { className: 'loader is-small', role: 'status', 'aria-label': 'Chargement' }));
}

/** Retire l'écran de démarrage (boot.js) ; sans effet après la première fois. */
function bootReady() {
  // Ne doit jamais interrompre l'app : au pire, les filets de secours retirent l'écran.
  try {
    if (window.HaisselBoot && window.HaisselBoot.ready) window.HaisselBoot.ready();
  } catch (error) {
    document.getElementById('boot-screen')?.remove();
  }
}

async function loadCommunity() {
  ui.communityList.setAttribute('aria-busy', 'true');
  if (!ui.communityList.childElementCount) ui.communityList.replaceChildren(loaderRow());
  if (ui.homeOffers && !ui.homeOffers.childElementCount) ui.homeOffers.replaceChildren(loaderRow());
  try {
    const query = communityQuery();
    const data = await api(`/api/community/offers${query ? `?${query}` : ''}`);
    state.community.loaded = true;
    state.community.categories = data.categories || {};
    fillCategorySelect(ui.communityCategory, state.community.categories, 'Toutes');
    fillCategorySelect(ui.pubCategory, state.community.categories, 'Choisir…');
    renderCategoryTiles();

    /*
     * La catégorie venant de l'adresse ne peut être appliquée qu'ici : la liste
     * déroulante vient seulement d'être remplie. Une seule fois.
     */
    if (state.community.pendingCategory) {
      if (state.community.categories[state.community.pendingCategory]) {
        ui.communityCategory.value = state.community.pendingCategory;
      }
      state.community.pendingCategory = '';
      paintSearchControls();
    }

    const items = data.items || [];
    ui.communityList.setAttribute('aria-busy', 'false');
    ui.communityList.replaceChildren(...(items.length
      ? items.map((offer) => gridTile(offer))
      : [query
        ? h('div', { className: 'search-empty mascot-state' }, bear('aucun-resultat', 140),
          h('p', null, 'Aucun résultat'),
          h('button', { className: 'secondary-button', type: 'button', onclick: clearSearch }, 'Effacer les filtres'))
        : h('div', { className: 'panel-card' }, 'Aucune offre de la communauté pour le moment. Sois le premier à en publier une !')]));
    if (items.length && ui.communityList.offsetParent) window.HaisselMotion?.cascade(ui.communityList);

    /*
     * Accueil : le fil complet, sans filtre. On ne le met à jour que lorsque
     * la liste reçue n'est pas filtrée, sinon une recherche modifierait aussi
     * la page d'accueil.
     */
    if (!query && ui.homeOffers) {
      renderStories(items);
      renderDiscover(items);
      // Fil de l'accueil : les offres ADMIN d'abord, puis les fiches.
      const feed = [...items.filter((offer) => offer.kind !== 'campaign'), ...items.filter((offer) => offer.kind === 'campaign')];
      ui.homeOffers.replaceChildren(...(feed.length
        ? feed.map((offer) => postCard(offer))
        : [h('div', { className: 'panel-card mascot-state' }, bear('vide-dodo', 140),
          h('p', null, 'Aucune offre pour le moment. Tu peux être le premier à en publier une.'))]));
      // Premier rendu visible : entrée en cascade (8 éléments au plus, motion.js).
      if (feed.length && ui.homeOffers.offsetParent) window.HaisselMotion?.cascade(ui.homeOffers);
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) return;
    ui.communityList.setAttribute('aria-busy', 'false');
    ui.communityList.replaceChildren(h('div', { className: 'panel-card is-error mascot-state', role: 'alert' }, bear('oups-erreur', 120),
      h('p', null, `Impossible de charger les offres : ${error.message}`),
      h('button', { className: 'secondary-button', type: 'button', onclick: loadCommunity }, 'Réessayer')));
    // Découvrir : pas d'écran noir en cas d'erreur, l'état vide propose « Actualiser ».
    if (!communityQuery()) renderDiscover([]);
    if (ui.homeOffers) {
      ui.homeOffers.replaceChildren(h('div', { className: 'panel-card is-error mascot-state', role: 'alert' }, bear('oups-erreur', 120),
        h('p', null, 'Offres indisponibles pour le moment.')));
    }
  } finally {
    // Premier rendu de l'Accueil (stories et fil, état vide ou erreur).
    bootReady();
  }
}

// ---------------------------------------------------------------------------
// Recherche : barre, bouton « Filtres » et feuille du bas
// ---------------------------------------------------------------------------

const filterFields = () => ({
  category: ui.communityCategory.value, kind: ui.communityKind.value,
  sort: ui.communitySort.value, saved: ui.communitySaved.checked,
});

function setFilterFields({ category = '', kind = '', sort = '', saved = false }) {
  ui.communityCategory.value = category;
  ui.communityKind.value = kind;
  ui.communitySort.value = sort;
  ui.communitySaved.checked = saved;
}

/** Bouton ✕ du champ et pastille du nombre de filtres actifs. */
function paintSearchControls() {
  ui.communityQClear.hidden = !ui.communityQ.value;
  const count = window.HaisselChat.countActiveFilters(filterFields());
  ui.filtersCount.hidden = !count;
  ui.filtersCount.textContent = count ? String(count) : '';
  ui.filtersOpen.setAttribute('aria-label', count ? `Filtres (${count} actif${count > 1 ? 's' : ''})` : 'Filtres');
}

function runSearch() {
  paintSearchControls();
  syncFiltersToUrl();
  loadCommunity();
}

/** État vide : on efface le texte ET les filtres. */
function clearSearch() {
  ui.communityQ.value = '';
  setFilterFields({});
  runSearch();
}

/*
 * Feuilles du bas (<dialog class="sheet">) : même entrée et même geste de
 * fermeture que le lecteur de stories (glisser vers le bas au-delà de 25 %
 * de la hauteur, ou vite). Échap et le fond assombri ferment aussi.
 * onClose(dialog, { apply }) est appelé une fois la feuille fermée.
 */
const sheets = new WeakMap();

function openSheet(dialog) {
  if (dialog.open) return;
  const panel = dialog.querySelector('.sheet-panel');
  sheets.get(dialog).closing = false;
  // Focus initial sans anneau : il n'apparaît qu'après une touche du clavier dans la feuille.
  dialog.dataset.noRing = '';
  dialog.addEventListener('keydown', () => { delete dialog.dataset.noRing; }, { once: true });
  dialog.showModal();
  panel.style.transform = '';
  dialog.style.setProperty('--sheet-fade', '1');
  if (reducedMotion()) panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
  // Montée avec ressort (même courbe que le Liquid Glass) ; la fermeture est plus rapide.
  else panel.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.34, 1.2, .55, 1)' });
}

function closeSheet(dialog, { apply = false } = {}) {
  const entry = sheets.get(dialog);
  if (!dialog.open || entry.closing) return;
  entry.closing = true;
  if (entry.beforeClose) entry.beforeClose({ apply });
  const panel = dialog.querySelector('.sheet-panel');
  const done = () => {
    dialog.close();
    panel.style.transform = '';
    entry.closing = false;
    if (entry.onClose) entry.onClose({ apply });
  };
  const animation = reducedMotion()
    ? panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' })
    : panel.animate([{ transform: panel.style.transform || 'none' }, { transform: 'translateY(100%)' }],
      { duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  animation.finished.then(() => { done(); animation.cancel(); }, done);
}

/*
 * Geste commun à toutes les feuilles (sheet-gesture.js) : glisser vers le bas
 * depuis n'importe où (poignée et titre sans défilement natif, touch-action:
 * none) ; la direction est décidée au premier mouvement, un balayage
 * horizontal (carrousel du tuto) ne ferme rien. La feuille suit le doigt, le
 * fond s'éclaircit ; au lâcher : fermeture (25 % ou lancer) ou retour avec
 * ressort. Le fond assombri et Échap ferment aussi.
 */
function bindSheet(dialog, { beforeClose = null, onClose = null } = {}) {
  const entry = { closing: false, drag: null, beforeClose, onClose };
  sheets.set(dialog, entry);
  const panel = dialog.querySelector('.sheet-panel');
  const Gesture = window.HaisselSheetGesture;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeSheet(dialog); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeSheet(dialog); });
  dialog.querySelectorAll('[data-close-sheet]').forEach((button) => button.addEventListener('click', () => closeSheet(dialog)));
  const paintDrag = (dy) => {
    panel.style.transform = dy ? `translateY(${dy}px)` : '';
    dialog.style.setProperty('--sheet-fade', String(Gesture.backdropOpacity(dy, panel.offsetHeight)));
  };
  panel.addEventListener('pointerdown', (event) => {
    // Les contrôles natifs gardent leur comportement (roue iOS, menu Android).
    if (event.target.closest('select, input, textarea, label, a') || event.button > 0 || entry.closing) return;
    // Contenu qui défile : on ne ferme que depuis le haut de la feuille.
    if (panel.scrollTop > 0 && !event.target.closest('.sheet-grabber, .sheet-title')) return;
    const drag = Gesture.createSheetDrag({ height: panel.offsetHeight });
    drag.start(event.clientX, event.clientY, event.timeStamp);
    entry.drag = { id: event.pointerId, drag, captured: false };
  });
  panel.addEventListener('pointermove', (event) => {
    const current = entry.drag;
    if (!current || current.id !== event.pointerId) return;
    const { axis, dy } = current.drag.move(event.clientX, event.clientY, event.timeStamp);
    if (axis === 'other') { entry.drag = null; return; }
    if (axis !== 'down') return;
    if (!current.captured) {
      current.captured = true;
      try { panel.setPointerCapture(event.pointerId); } catch (error) { /* pointeur déjà relâché */ }
    }
    paintDrag(dy);
  });
  // Le clic qui suit un glissement ne doit pas toucher un bouton (« Suivant »…).
  panel.addEventListener('click', (event) => {
    if (!entry.justDragged) return;
    entry.justDragged = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  const release = (event) => {
    const current = entry.drag;
    if (!current || current.id !== event.pointerId) return;
    entry.drag = null;
    const decision = event.type === 'pointercancel' && current.drag.dy === 0 ? 'ignore' : current.drag.end();
    if (decision === 'ignore') return;
    entry.justDragged = current.drag.dy > 0;
    window.setTimeout(() => { entry.justDragged = false; }, 0);
    if (decision === 'close') { closeSheet(dialog); return; }
    const from = panel.style.transform;
    paintDrag(0);
    if (from && !reducedMotion()) panel.animate([{ transform: from }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
  };
  panel.addEventListener('pointerup', release);
  panel.addEventListener('pointercancel', release);
}

/*
 * Filtres : les valeurs ne s'appliquent qu'avec « Afficher les résultats » ;
 * fermer autrement rétablit les filtres d'avant.
 */
let filtersBefore = null;

function openFilters() {
  filtersBefore = filterFields();
  openSheet(ui.filtersSheet);
}

function bindFiltersSheet() {
  bindSheet(ui.filtersSheet, {
    beforeClose: ({ apply }) => { if (!apply && filtersBefore) setFilterFields(filtersBefore); },
    onClose: ({ apply }) => {
      if (apply) runSearch();
      ui.filtersOpen.focus({ preventScroll: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Activité (cloche) et réglage des notifications
// ---------------------------------------------------------------------------

/*
 * Liste lue sur /api/messages/activity (lecture seule). « Non lu » = plus
 * récent que la dernière ouverture d'Activité sur cet appareil (stockage
 * local, par compte) : aucune donnée de plus côté serveur. Mise à jour avec
 * l'interrogation existante des messages (60 s) et à chaque annonce reçue.
 */
const activity = { items: [], loaded: false, loading: null };

const readActivitySeen = () => window.HaisselActivity.readSeen(state.user?.id || 'anon');

function markActivitySeen() {
  window.HaisselActivity.markSeen(state.user?.id || 'anon', activity.items[0]?.at);
  paintBell();
}

function paintBell() {
  const count = window.HaisselActivity.unreadCount(activity.items, readActivitySeen());
  ui.bellBadge.hidden = !count;
  ui.bellBadge.textContent = count > 9 ? '9+' : String(count);
  ui.bellButton.setAttribute('aria-label', count ? `Activité (${count} nouveauté${count > 1 ? 's' : ''})` : 'Activité');
}

async function loadActivity() {
  if (!state.user) return;
  if (activity.loading) return activity.loading;
  activity.loading = (async () => {
    try {
      const data = await api('/api/messages/activity');
      activity.items = (data.items || []).filter((item) => window.HaisselActivity.describe(item));
      activity.loaded = true;
      paintBell();
      if (document.body.dataset.view === 'notifications') renderActivity();
    } catch (error) {
      if (error.status === 401 || error.status === 403) return;
      if (!activity.loaded && document.body.dataset.view === 'notifications') {
        ui.activityList.replaceChildren(h('div', { className: 'panel-card is-error mascot-state', role: 'alert' }, bear('oups-erreur', 120),
          h('p', null, 'Impossible d’afficher ton activité pour le moment.'),
          h('button', { className: 'secondary-button', type: 'button', onclick: loadActivity }, 'Réessayer')));
      }
    } finally {
      activity.loading = null;
    }
  })();
  return activity.loading;
}

/** Un appui ouvre l'élément concerné. */
function openActivityItem(item) {
  if (item.type === 'team_message') {
    setActiveView('messages');
    openChat();
    return;
  }
  if (item.type === 'announcement') {
    if (item.url) window.location.assign(item.url);
    return;
  }
  setActiveView('profile');
  setProfileTab(isAdultMember() ? 'offers' : 'account');
  window.setTimeout(() => {
    const tile = item.offer_id ? document.querySelector(`[data-offer-id="${CSS.escape(String(item.offer_id))}"]`) : null;
    if (tile) tile.click();
  }, 400);
}

function activityRow(item, seenAt) {
  const info = window.HaisselActivity.describe(item);
  const unread = window.HaisselActivity.isUnread(item, seenAt);
  const opens = item.type !== 'announcement' || item.url;
  return h('li', null, h(opens ? 'button' : 'div', {
    className: `activity-row${unread ? ' is-unread' : ''}`, ...(opens ? { type: 'button', onclick: () => openActivityItem(item) } : {}),
  },
  item.type === 'team_message'
    ? h('span', { className: 'activity-icon is-team' }, teamAvatar(40))
    : h('span', { className: `activity-icon tone-${info.tone}`, 'aria-hidden': 'true' }, icon(info.icon)),
  h('span', { className: 'activity-text' },
    h('span', { className: 'activity-phrase' }, info.text),
    h('time', { className: 'activity-time', datetime: item.at }, window.HaisselActivity.relativeTime(item.at))),
  unread ? h('span', { className: 'activity-dot' }, h('span', { className: 'visually-hidden' }, 'Nouveau')) : null));
}

function renderActivity() {
  if (!activity.loaded) {
    ui.activityList.replaceChildren(h('p', { className: 'activity-empty' }, 'Chargement…'));
    return;
  }
  if (!activity.items.length) {
    ui.activityList.replaceChildren(h('div', { className: 'activity-empty mascot-state' }, bear('vide-dodo', 140),
      h('p', null, 'Rien de nouveau pour l’instant.')));
    return;
  }
  const seenAt = readActivitySeen();
  ui.activityList.replaceChildren(...window.HaisselActivity.groupBySection(activity.items).map((section) => h('section', {
    className: 'activity-section', 'aria-label': section.label,
  }, h('h3', { className: 'activity-section-title' }, section.label),
  h('ul', { className: 'activity-items' }, ...section.items.map((item) => activityRow(item, seenAt))))));
}

/** Page Activité ouverte : on affiche (points bleus de la visite), puis on marque « vu ». */
async function showActivity() {
  renderActivity();
  await loadActivity();
  renderActivity();
  markActivitySeen();
}

function deviceEnv() {
  let displayModeStandalone = false;
  try { displayModeStandalone = window.matchMedia('(display-mode: standalone)').matches; } catch (error) { /* ancien navigateur */ }
  return {
    hasNotification: 'Notification' in window,
    isSecureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone: navigator.standalone === true,
    displayModeStandalone,
  };
}

/*
 * Profil › Réglages : une ligne, un interrupteur, un texte d'aide selon
 * l'appareil. Web Push (push-client.js) : notifications même app fermée.
 */
const pushState = { config: null, subscribed: false };

async function loadPushConfig() {
  if (pushState.config) return pushState.config;
  try {
    pushState.config = await api('/api/push/config');
  } catch (error) {
    return { enabled: false };
  }
  return pushState.config;
}

function pushDeps() {
  return { nav: navigator, Notif: 'Notification' in window ? window.Notification : null, api, publicKey: pushState.config?.public_key };
}

async function renderNotifSetting() {
  const support = window.HaisselActivity.deviceSupport(deviceEnv());
  const config = await loadPushConfig();
  ui.notifHowto.hidden = support !== 'ios-install';
  ui.notifSwitch.hidden = !config.enabled;
  ui.notifSwitch.disabled = true;
  ui.notifSwitch.checked = false;
  if (!config.enabled) {
    ui.notifHelp.textContent = 'Les nouveautés s’affichent dans Activité (la cloche).';
    return;
  }
  if (support === 'ios-install') {
    ui.notifHelp.textContent = 'Sur iPhone, ajoute HAISSEL à ton écran d’accueil pour recevoir les notifications.';
    return;
  }
  if (support !== 'available' || !window.HaisselPush.canPush(navigator)) {
    ui.notifHelp.textContent = 'Ton navigateur ne permet pas les notifications. Les nouveautés restent visibles dans Activité.';
    return;
  }
  const permission = window.Notification.permission;
  if (permission === 'denied') {
    ui.notifHelp.textContent = 'Autorise HAISSEL dans Réglages > Notifications de ton téléphone.';
    return;
  }
  pushState.subscribed = permission === 'granted' && Boolean(await window.HaisselPush.current(navigator));
  ui.notifSwitch.disabled = false;
  ui.notifSwitch.checked = pushState.subscribed;
  ui.notifHelp.textContent = pushState.subscribed
    ? 'Activées : HAISSEL te prévient, même application fermée.'
    : 'Désactivées. Active-les pour que HAISSEL te prévienne des nouveautés.';
}

/* Réglages : « Profil visible par les membres » (désactivé par défaut). */
function renderProfileVisibility() {
  const toggle = document.getElementById('profile-public-switch');
  if (toggle && state.user) toggle.checked = Boolean(state.user.profile_public);
}

async function handleProfileVisibility(event) {
  const toggle = event.target;
  const wanted = toggle.checked;
  toggle.disabled = true;
  try {
    const data = await api('/api/auth/me/profile-visibility', { method: 'POST', body: { public: wanted } });
    state.user.profile_public = data.profile_public;
  } catch (error) {
    toggle.checked = !wanted;
    window.HaisselMotion?.toast(error.message, { check: false });
  } finally {
    toggle.disabled = false;
    renderProfileVisibility();
  }
}

async function handleNotifSwitch() {
  // La permission n'est demandée qu'ici, au toucher de l'interrupteur.
  const wanted = ui.notifSwitch.checked;
  ui.notifSwitch.disabled = true;
  const result = wanted
    ? await window.HaisselPush.enable(pushDeps())
    : await window.HaisselPush.disable(pushDeps());
  await renderNotifSetting();
  if (result === 'error') ui.notifHelp.textContent = 'Activation impossible pour le moment. Réessaie dans un instant.';
  else if (wanted && ui.notifSwitch.checked) window.HaisselMotion?.toast('Notifications activées', { mascot: 'notifications' });
}

/* Feuille « Comment faire ? » : le carrousel repart de la première étape. */
let tuto = null;
function openHowto() {
  openSheet(ui.howtoSheet);
  if (tuto) tuto.reset();
}

// ---------------------------------------------------------------------------
// Installer l'application (install.js) : ligne de Réglages et bannière de l'Accueil
// ---------------------------------------------------------------------------

const INSTALL_KEYS = {
  firstSeen: 'haissel-first-seen',
  bannerDismissed: 'haissel-install-banner-dismissed',
  notifyDismissed: 'haissel-notify-offer-dismissed',
};

function storageGet(key) {
  try { return safeStorage()?.getItem(key) ?? null; } catch (error) { return null; }
}

function storageSet(key, value) {
  try { safeStorage()?.setItem(key, value); } catch (error) { /* stockage indisponible : rien à retenir */ }
}

function installState() {
  return window.HaisselInstall.installState({
    ...deviceEnv(), hasPrompt: Boolean(window.HaisselInstall.deferred), installed: window.HaisselInstall.installed,
  });
}

/** Mode de la bannière : 'install', 'notify' (déjà installée) ou null. */
async function installBannerMode() {
  const state = installState();
  if (window.HaisselInstall.bannerVisible({
    state, firstSeenAt: storageGet(INSTALL_KEYS.firstSeen), dismissed: storageGet(INSTALL_KEYS.bannerDismissed) === '1',
  })) return 'install';
  const config = await loadPushConfig();
  const canPush = 'Notification' in window && window.HaisselPush.canPush(navigator);
  const offer = window.HaisselInstall.notifyOfferVisible({
    state,
    pushEnabled: Boolean(config.enabled),
    canPush,
    permission: canPush ? window.Notification.permission : 'denied',
    subscribed: canPush && Boolean(await window.HaisselPush.current(navigator)),
    dismissed: storageGet(INSTALL_KEYS.notifyDismissed) === '1',
  });
  return offer ? 'notify' : null;
}

async function renderInstallUi() {
  const current = installState();
  // Ligne toujours visible ; une fois installée, elle ouvre quand même le tuto (pour aider un ami).
  ui.installRowLabel.textContent = current === 'installed' ? 'Application installée ✓' : 'Installer l’app sur ton téléphone';
  const mode = state.user ? await installBannerMode() : null;
  ui.installBanner.hidden = !mode;
  ui.installBanner.dataset.mode = mode || '';
  if (mode === 'notify') {
    ui.installBannerText.textContent = 'Active les notifications pour être prévenu des nouveautés';
    ui.installBannerAction.textContent = 'Activer';
    ui.installBanner.setAttribute('aria-label', 'Activer les notifications');
  } else {
    ui.installBannerText.textContent = 'Installe HAISSEL pour recevoir les notifications';
    ui.installBannerAction.textContent = 'Installer';
    ui.installBanner.setAttribute('aria-label', 'Installer HAISSEL');
  }
}

/*
 * Feuille d'installation adaptée à l'appareil (install.js, tutoKind) :
 * 'ios' → carrousel « Comment faire ? » ; 'android' → invite native ;
 * 'safari' → « Ouvre HAISSEL dans Safari » et « Copier le lien ».
 */
let installSheetKind = null;

function openInstallGuide(kind) {
  if (kind !== 'android' && kind !== 'safari') {
    openHowto();
    return;
  }
  installSheetKind = kind;
  ui.installSheetStatus.textContent = '';
  if (kind === 'android') {
    ui.installSheetTitle.textContent = 'Installe HAISSEL';
    ui.installSheetText.textContent = 'Ajoute HAISSEL à ton écran d’accueil : il s’ouvre comme une application et peut te prévenir des nouveautés.';
    ui.installSheetAction.textContent = 'Installer';
  } else {
    ui.installSheetTitle.textContent = 'Ouvre HAISSEL dans Safari';
    ui.installSheetText.textContent = 'Ouvre HAISSEL dans Safari pour l’installer : seul Safari peut l’ajouter à l’écran d’accueil de l’iPhone.';
    ui.installSheetAction.textContent = 'Copier le lien';
  }
  openSheet(ui.installSheet);
}

async function handleInstallSheetAction() {
  if (installSheetKind === 'safari') {
    const link = `${window.location.origin}/app`;
    try {
      await navigator.clipboard.writeText(link);
      ui.installSheetStatus.textContent = 'Lien copié : colle-le dans Safari.';
    } catch (error) {
      ui.installSheetStatus.textContent = `Copie impossible : ${link}`;
    }
    return;
  }
  await runInstall();
  closeSheet(ui.installSheet);
}

/* Feuille fermée (quelle que soit l'étape) : « vue » sur le compte, plus d'ouverture automatique. */
function markInstallTutoSeen() {
  if (!state.user || state.user.install_tuto_seen) return;
  state.user.install_tuto_seen = true;
  api('/api/auth/install-tuto/seen', { method: 'POST' }).catch(() => {});
}

/*
 * Ouverture automatique après la première connexion du compte, seulement si
 * elle est utile sur cet appareil. Jamais par-dessus l'écran de chargement ni
 * la question de majorité : on attend qu'ils soient partis.
 */
const autoTuto = { timer: 0, done: false, tries: 0 };

function scheduleAutoTuto() {
  clearTimeout(autoTuto.timer);
  if (autoTuto.done || !state.user) return;
  const kind = window.HaisselInstall.autoTutoKind({ seen: Boolean(state.user.install_tuto_seen), state: installState() });
  if (!kind) return;
  const gate = document.getElementById('age-gate');
  const blocked = document.getElementById('boot-screen') || (gate && !gate.hidden) || document.querySelector('dialog[open]');
  if (blocked) {
    autoTuto.tries += 1;
    if (autoTuto.tries < 200) autoTuto.timer = setTimeout(scheduleAutoTuto, 300);
    return;
  }
  autoTuto.done = true;
  openInstallGuide(kind);
}

/** Bouton « Installer » de la bannière : invite Android, ou feuille « Comment faire ? » sur iPhone. */
async function runInstall() {
  const current = installState();
  if (current === 'ios-safari') {
    openHowto();
    return;
  }
  const event = window.HaisselInstall.deferred;
  if (current !== 'prompt' || !event) return;
  // L'invite ne sert qu'une fois.
  window.HaisselInstall.deferred = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice && choice.outcome === 'accepted') {
      window.HaisselInstall.installed = true;
      storageSet(INSTALL_KEYS.bannerDismissed, '1');
    }
  } catch (error) { /* invite refusée par le navigateur : rien à faire */ }
  await renderInstallUi();
  if (!ui.notifSwitch.closest('[hidden]')) renderNotifSetting();
}

async function handleInstallBannerAction() {
  if (ui.installBanner.dataset.mode === 'notify') {
    // Même chemin que l'interrupteur de Réglages : permission demandée ici, au toucher.
    ui.installBannerAction.disabled = true;
    await window.HaisselPush.enable(pushDeps());
    storageSet(INSTALL_KEYS.notifyDismissed, '1');
    ui.installBannerAction.disabled = false;
    await renderInstallUi();
    return;
  }
  await runInstall();
}

function closeInstallBanner() {
  const key = ui.installBanner.dataset.mode === 'notify' ? INSTALL_KEYS.notifyDismissed : INSTALL_KEYS.bannerDismissed;
  storageSet(key, '1');
  ui.installBanner.hidden = true;
}

/* Au chargement : l'abonnement déjà présent sur l'appareil est renvoyé au serveur (sans rien demander). */
async function syncPush() {
  const config = await loadPushConfig();
  if (config.enabled) window.HaisselPush.sync(pushDeps());
}

/** Vue demandée par l'adresse (rechargement, lien de notification), sinon l'Accueil. */
function initialView() {
  const view = window.HaisselPush.viewFromHash(window.location.hash);
  if (!view || (view === 'publish' && !canPublish())) return 'home';
  return view;
}

/* Fragment modifié à la main ou lien interne (« /app#messages ») : ouvre la bonne vue. */
function openViewFromHash() {
  const view = window.HaisselPush.viewFromHash(window.location.hash);
  if (!view || !state.user) return;
  if (!document.getElementById(`${view}-view`).classList.contains('hidden')) return;
  setActiveView(view);
}

// ---------------------------------------------------------------------------
// Stories : barre de l'accueil et lecteur plein écran
// ---------------------------------------------------------------------------

/*
 * Les fiches campagne des membres s'affichent comme des stories : un rond par
 * auteur, un lecteur plein écran. Les offres ADMIN n'en sont jamais : elles
 * restent dans le fil, sous la barre.
 *
 * Rien n'est chargé de l'extérieur (ni image ni script) et aucune vue n'est
 * envoyée au serveur : « vu » reste dans ce navigateur (voir stories.js).
 */
const Stories = window.HaisselStories;
const STORY_DURATION = 7000;

function safeStorage() {
  try { return window.localStorage; } catch (error) { return null; }
}

function storiesSeen() {
  const storage = safeStorage();
  return storage ? Stories.readSeen(storage) : new Set();
}

function storyAvatar(username, className = 'story-avatar') {
  return h('span', { className, 'aria-hidden': 'true' }, initialsFromName(username));
}

function storyRing({ username, label, unseen, onclick, extra = null, ariaLabel }) {
  return h('li', { className: 'story-item' },
    h('button', {
      className: `story-ring${unseen ? ' is-unseen' : ' is-seen'}`, type: 'button', 'aria-label': ariaLabel, onclick,
      // Le lecteur s'ouvre depuis ce rond et s'y referme (openStoryViewer).
      'data-author': username,
    }, storyAvatar(username), extra),
    h('span', { className: 'story-name', 'aria-hidden': 'true' }, label));
}

function renderStories(items) {
  if (!ui.homeStories) return;
  const seen = storiesSeen();
  const groups = Stories.groupStories(items, seen);
  state.stories = { groups, items };
  const rings = [];

  // « Toi » : réservé aux majeurs, qui seuls peuvent publier.
  if (isAdultMember()) {
    const mine = Stories.ownStories(items);
    const me = state.user?.display_name || state.user?.username || 'toi';
    rings.push(mine.length
      ? storyRing({
        username: me, label: 'Toi', unseen: false, ariaLabel: `Voir tes fiches en cours (${mine.length})`,
        onclick: (event) => openStoryViewer([{ username: me, offers: mine }], 0, 0, event.currentTarget),
      })
      : storyRing({
        username: me, label: 'Toi', unseen: false, ariaLabel: 'Partager une fiche campagne',
        extra: h('span', { className: 'story-add', 'aria-hidden': 'true' }, '+'),
        onclick: () => setActiveView('publish'),
      }));
  }
  groups.forEach((group, index) => {
    const count = group.offers.length;
    rings.push(storyRing({
      username: group.username, label: group.username, unseen: group.unseen,
      ariaLabel: `Fiches de @${group.username} : ${count} fiche${count > 1 ? 's' : ''}${group.unseen ? ', non vues' : ', déjà vues'}`,
      onclick: (event) => openStoryViewer(groups, index, Stories.startIndex(group.offers, seen), event.currentTarget),
    }));
  });
  ui.homeStories.replaceChildren(...rings);
  ui.homeStories.closest('.stories-bar')?.classList.toggle('hidden', rings.length === 0);
}

function refreshStoryRings() {
  if (state.stories) renderStories(state.stories.items);
}

/* Lecteur ------------------------------------------------------------------ */

/*
 * Gestes et animations façon Instagram. Seuls transform et opacity sont
 * animés (plus les coins arrondis à l'ouverture et à la fermeture) ; le doigt
 * est suivi dans requestAnimationFrame. La décision des gestes est dans
 * stories.js (fonctions pures, testées).
 */
const viewer = {
  root: null, backdrop: null, cube: null, face: null, neighbor: null, neighborDir: 0,
  groups: [], g: 0, i: 0, elapsed: 0, last: 0, frame: 0, anim: 0, render: 0,
  paused: false, holding: false, closing: false, gesture: null, holdTimer: 0,
  returnFocus: null, scrollY: 0,
};

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; }
}

function currentStory() {
  return viewer.groups[viewer.g]?.offers[viewer.i] || null;
}

function storyCard(offer) {
  const fact = (label, value) => (value ? h('div', { className: 'sv-fact' }, h('dt', null, label), h('dd', null, value)) : null);
  return h('article', { className: 'sv-card' },
    h('span', { className: 'sv-icon', 'aria-hidden': 'true' }, categoryIcon(offer.category, 'icon lg')),
    h('p', { className: 'sv-category' }, offer.category_label),
    h('h2', { className: 'sv-title', id: 'story-title' }, offer.title),
    offer.campaign_name ? h('p', { className: 'sv-campaign' }, `Campagne : ${offer.campaign_name}`) : null,
    h('dl', { className: 'sv-facts' },
      fact('Ce qu’il faut faire', offer.expected_action),
      fact('Pays', offer.countries),
      fact('Âge', offer.min_age ? `${offer.min_age} ans et +` : 'Pas d’âge minimum indiqué')),
    offer.tips ? h('section', { className: 'sv-tips' },
      h('h3', null, `Les conseils de @${offer.author.username}`),
      h('p', null, offer.tips)) : null);
}

/* Menu « … » : ouvert depuis le point touché, fermé en 120 ms (motion.js). */
function storyMenu(offer) {
  const motion = window.HaisselMotion;
  const hide = () => {
    toggle.setAttribute('aria-expanded', 'false');
    if (motion) motion.closeMenu(menu, () => menu.classList.add('hidden'));
    else menu.classList.add('hidden');
  };
  const menu = h('div', { className: 'sv-menu lg-glass hidden', role: 'menu' },
    h('button', {
      type: 'button', role: 'menuitem',
      // Le lecteur reste en pause tant qu'une fenêtre est ouverte (voir tickStory).
      onclick: () => { hide(); pauseStory(false); openReport(offer); },
    }, icon('i-flag', 'icon sm'), 'Signaler'));
  const toggle = h('button', {
    className: 'sv-round', type: 'button', 'aria-label': 'Plus d’actions', 'aria-haspopup': 'menu',
    onclick: (event) => {
      const open = menu.classList.contains('hidden');
      if (open) {
        menu.classList.remove('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        motion?.openMenu(menu, { x: event.clientX, y: event.clientY });
      } else hide();
      pauseStory(open);
    },
  }, '…');
  return [toggle, menu];
}

/* Un écran du lecteur : la fiche i de l'auteur g. */
function storyFace(g, i) {
  const group = viewer.groups[g];
  const offer = group.offers[i];
  const bars = group.offers.map((_, index) => {
    const fill = h('span', { className: 'sv-bar-fill' });
    fill.style.transform = `scaleX(${index < i ? 1 : 0})`;
    return h('span', { className: 'sv-bar' }, fill);
  });
  const [menuButton, menu] = storyMenu(offer);
  return h('div', { className: 'sv-face' },
    h('div', { className: 'sv-bars lg-glass lg-pill', 'aria-hidden': 'true' }, bars),
    h('header', { className: 'sv-head' },
      storyAvatar(offer.author.username, 'story-avatar sm'),
      h('div', { className: 'sv-who' },
        h('strong', null, `@${offer.author.username}`),
        h('span', null, formatAgo(offer.shown_at || offer.published_at))),
      kindBadge(offer),
      h('button', { className: 'sv-round lg-glass lg-pill lg-press', type: 'button', 'aria-label': 'Fermer', onclick: () => closeStoryViewer() }, icon('i-close'))),
    h('p', { className: 'visually-hidden', 'aria-live': 'polite' },
      `Fiche ${i + 1} sur ${group.offers.length} de @${group.username}`),
    h('div', { className: 'sv-stage' },
      // Boutons pour le clavier et les lecteurs d'écran ; au doigt, la zone
      // entière réagit (voir onStoryPointerUp).
      h('button', { className: 'sv-nav prev', type: 'button', onclick: () => stepStory(-1) }, h('span', { className: 'visually-hidden' }, 'Précédente')),
      storyCard(offer),
      h('button', { className: 'sv-nav next', type: 'button', onclick: () => stepStory(1) }, h('span', { className: 'visually-hidden' }, 'Suivante'))),
    h('footer', { className: 'sv-foot' },
      h('button', {
        className: 'primary-button sv-open', type: 'button', disabled: !offer.can_open,
        onclick: () => confirmLeave(offer),
      }, 'Voir la page officielle', icon('i-arrow-right')),
      offer.is_mine ? null : saveButtonFor(offer),
      offer.is_mine ? null : menuButton,
      offer.is_mine ? null : menu));
}

function paintStory() {
  const offer = currentStory();
  if (!offer) { closeStoryViewer(); return; }
  const face = storyFace(viewer.g, viewer.i);
  if (viewer.face) viewer.face.replaceWith(face);
  else viewer.cube.append(face);
  viewer.face = face;
  viewer.fill = face.querySelectorAll('.sv-bar-fill')[viewer.i];
  viewer.elapsed = 0;
  if (reducedMotion()) viewer.fill.style.transform = 'scaleX(1)';
  const storage = safeStorage();
  if (storage) Stories.markSeen(storage, offer);
}

function tickStory(now) {
  viewer.frame = window.requestAnimationFrame(tickStory);
  const stopped = viewer.paused || viewer.holding || viewer.closing || viewer.anim
    || (viewer.gesture && viewer.gesture.kind && viewer.gesture.kind !== 'ignore');
  if (stopped || reducedMotion() || document.querySelector('dialog[open]')) { viewer.last = now; return; }
  viewer.elapsed += now - (viewer.last || now);
  viewer.last = now;
  if (viewer.fill) viewer.fill.style.transform = `scaleX(${Math.min(1, viewer.elapsed / STORY_DURATION)})`;
  if (viewer.elapsed >= STORY_DURATION) stepStory(1);
}

/* Changement instantané (toucher, flèches, boutons). */
function stepStory(delta) {
  const group = viewer.groups[viewer.g];
  let { g, i } = viewer;
  i += delta;
  if (i >= group.offers.length) { g += 1; i = 0; }
  if (i < 0) {
    if (g === 0) { i = 0; } else { g -= 1; i = viewer.groups[g].offers.length - 1; }
  }
  if (g >= viewer.groups.length) { closeStoryViewer(); return; }
  viewer.g = g; viewer.i = i;
  pauseStory(false);
  paintStory();
}

function pauseStory(paused) {
  viewer.paused = paused;
  viewer.root?.classList.toggle('is-paused', paused);
}

function onStoryKey(event) {
  if (!viewer.root || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeStoryViewer(); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); stepStory(1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); stepStory(-1); }
}

/* Transformations ----------------------------------------------------------- */

/* Transformation qui ramène l'écran entier sur le rond (ouverture, fermeture). */
function ringTransform(rect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tx = rect.left + rect.width / 2 - vw / 2;
  const ty = rect.top + rect.height / 2 - vh / 2;
  return `translate(${tx}px, ${ty}px) scale(${rect.width / vw}, ${rect.height / vh})`;
}

function ringRectFor(username) {
  const ring = ui.homeStories?.querySelector(`.story-ring[data-author="${CSS.escape(username)}"]`);
  if (!ring) return null;
  const rect = ring.getBoundingClientRect();
  const visible = rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  return visible ? rect : null;
}

/* Fermeture en cours de geste : la story suit le doigt et rétrécit. */
function applyDismiss(dx, dy) {
  const down = Math.max(0, dy);
  const k = Math.min(1, down / (window.innerHeight * 0.5));
  if (reducedMotion()) {
    viewer.face.style.opacity = String(1 - k * 0.6);
  } else {
    viewer.face.style.transform = `translate(${dx * 0.4}px, ${down}px) scale(${1 - 0.15 * k})`;
    viewer.face.style.borderRadius = `${Math.min(24, down / 6)}px`;
  }
  viewer.backdrop.style.opacity = String(1 - k);
}

function setFace(face, tx, deg, origin) {
  face.style.transformOrigin = origin;
  face.style.transform = `translateX(${tx}px) rotateY(${deg}deg)`;
}

/*
 * Cube : p = déplacement / largeur (-1 = auteur suivant arrivé, +1 = auteur
 * précédent arrivé). Chaque face tourne autour de l'arête commune.
 */
function applyCube(p) {
  const w = window.innerWidth;
  if (!viewer.neighbor) {
    // Premier ou dernier auteur : résistance élastique.
    viewer.face.style.transform = `translateX(${p * w * 0.25}px)`;
    return;
  }
  if (p < 0) {
    setFace(viewer.face, p * w, p * 90, '100% 50%');
    setFace(viewer.neighbor, w + p * w, 90 * (1 + p), '0% 50%');
  } else {
    setFace(viewer.face, p * w, p * 90, '0% 50%');
    setFace(viewer.neighbor, -w + p * w, -90 * (1 - p), '100% 50%');
  }
}

function prepareNeighbor(dir) {
  if (viewer.neighborDir === dir) return;
  viewer.neighbor?.remove();
  viewer.neighbor = null;
  viewer.neighborDir = dir;
  const g = viewer.g + dir;
  if (reducedMotion() || g < 0 || g >= viewer.groups.length) return;
  viewer.neighbor = storyFace(g, Stories.startIndex(viewer.groups[g].offers, storiesSeen()));
  viewer.neighbor.setAttribute('aria-hidden', 'true');
  viewer.cube.append(viewer.neighbor);
}

function resetFaceStyles(face) {
  face.style.transform = '';
  face.style.transformOrigin = '';
  face.style.borderRadius = '';
  face.style.opacity = '';
}

/* Interpolation dans requestAnimationFrame (cube qui se termine ou revient). */
function tween(from, to, ms, onFrame, done) {
  const start = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    onFrame(from + (to - from) * ease(t));
    if (t < 1) viewer.anim = window.requestAnimationFrame(step);
    else { viewer.anim = 0; done(); }
  };
  viewer.anim = window.requestAnimationFrame(step);
}

function finishCube(decision, dx) {
  const w = window.innerWidth;
  const p0 = Math.max(-1, Math.min(1, dx / w));
  const target = decision === 'next-author' ? -1 : decision === 'prev-author' ? 1 : 0;
  const done = () => {
    viewer.neighbor?.remove();
    viewer.neighbor = null;
    viewer.neighborDir = 0;
    if (target !== 0) {
      viewer.g -= target;
      viewer.i = Stories.startIndex(viewer.groups[viewer.g].offers, storiesSeen());
      paintStory();
      if (reducedMotion()) viewer.face.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    } else {
      resetFaceStyles(viewer.face);
    }
  };
  if (reducedMotion()) { done(); return; }
  tween(p0, target, target === 0 ? 300 : 260, applyCube, done);
}

function restoreDismiss() {
  const { face, backdrop } = viewer;
  const from = { transform: face.style.transform || 'none', borderRadius: face.style.borderRadius || '0px', opacity: face.style.opacity || '1' };
  const fromBackdrop = backdrop.style.opacity || '1';
  resetFaceStyles(face);
  backdrop.style.opacity = '';
  if (reducedMotion()) return;
  face.animate([from, { transform: 'none', borderRadius: '0px', opacity: '1' }],
    { duration: 320, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
  backdrop.animate([{ opacity: fromBackdrop }, { opacity: 1 }], { duration: 200 });
}

/* Gestes ------------------------------------------------------------------- */

function velocity(samples) {
  const last = samples[samples.length - 1];
  const first = samples.find((s) => last.t - s.t <= 100) || samples[0];
  const dt = Math.max(1, last.t - first.t);
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

function onStoryPointerDown(event) {
  if (viewer.closing || viewer.anim || viewer.gesture) return;
  if (event.target.closest('button, a, [role="menu"]')) return;
  viewer.gesture = {
    id: event.pointerId, x0: event.clientX, y0: event.clientY, dx: 0, dy: 0, kind: null,
    samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }],
  };
  try { viewer.root.setPointerCapture(event.pointerId); } catch (error) { /* pointeur déjà relâché */ }
  clearTimeout(viewer.holdTimer);
  viewer.holdTimer = setTimeout(() => {
    if (!viewer.gesture || viewer.gesture.kind) return;
    viewer.holding = true;
    viewer.root.classList.add('is-holding');
  }, Stories.GESTURE.holdMs);
}

function renderGesture() {
  viewer.render = 0;
  const gesture = viewer.gesture;
  if (!gesture || !viewer.face) return;
  if (gesture.kind === 'dismiss') applyDismiss(gesture.dx, gesture.dy);
  else if (gesture.kind === 'author' && !reducedMotion()) {
    prepareNeighbor(gesture.dx < 0 ? 1 : -1);
    applyCube(Math.max(-1, Math.min(1, gesture.dx / window.innerWidth)));
  }
}

function onStoryPointerMove(event) {
  const gesture = viewer.gesture;
  if (!gesture || event.pointerId !== gesture.id) return;
  gesture.dx = event.clientX - gesture.x0;
  gesture.dy = event.clientY - gesture.y0;
  gesture.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
  if (gesture.samples.length > 12) gesture.samples.shift();
  // Appui long en cours : les mouvements ne lancent plus de geste.
  if (viewer.holding) return;
  if (!gesture.kind) {
    gesture.kind = Stories.classifyGesture(gesture.dx, gesture.dy);
    if (!gesture.kind) return;
    clearTimeout(viewer.holdTimer);
  }
  if (gesture.kind === 'ignore') return;
  if (!viewer.render) viewer.render = window.requestAnimationFrame(renderGesture);
}

function onStoryPointerUp(event, cancelled = false) {
  const gesture = viewer.gesture;
  if (!gesture || event.pointerId !== gesture.id) return;
  viewer.gesture = null;
  clearTimeout(viewer.holdTimer);
  if (viewer.render) { window.cancelAnimationFrame(viewer.render); viewer.render = 0; }
  if (viewer.holding) {
    viewer.holding = false;
    viewer.root.classList.remove('is-holding');
    return;
  }
  if (!gesture.kind) {
    if (!cancelled) stepStory(Stories.tapZone(event.clientX, window.innerWidth) === 'prev' ? -1 : 1);
    return;
  }
  if (gesture.kind === 'ignore') return;
  const { vx, vy } = velocity(gesture.samples);
  const decision = cancelled ? 'restore' : Stories.decideRelease(gesture.kind, {
    dx: gesture.dx, dy: gesture.dy, vx, vy, width: window.innerWidth, height: window.innerHeight,
    hasPrev: viewer.g > 0, hasNext: viewer.g < viewer.groups.length - 1,
  });
  if (gesture.kind === 'dismiss') {
    if (decision === 'close') closeStoryViewer();
    else restoreDismiss();
  } else {
    finishCube(decision, gesture.dx);
  }
}

/* Ouverture et fermeture ---------------------------------------------------- */

function openStoryViewer(groups, g, i, fromElement = null) {
  if (viewer.root) teardownStoryViewer();
  Object.assign(viewer, { groups, g, i, face: null, neighbor: null, neighborDir: 0, closing: false, holding: false, gesture: null });
  viewer.returnFocus = document.activeElement;

  // Page derrière figée sans saut : position fixe décalée du défilement.
  viewer.scrollY = window.scrollY;
  document.body.style.top = `-${viewer.scrollY}px`;
  document.body.classList.add('story-open');

  viewer.backdrop = h('div', { className: 'sv-backdrop' });
  viewer.cube = h('div', { className: 'sv-cube' });
  viewer.root = h('div', {
    className: 'story-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'story-title',
    onpointerdown: onStoryPointerDown, onpointermove: onStoryPointerMove,
    onpointerup: (event) => onStoryPointerUp(event),
    onpointercancel: (event) => onStoryPointerUp(event, true),
    oncontextmenu: (event) => event.preventDefault(),
  }, viewer.backdrop, viewer.cube);
  document.body.append(viewer.root);
  document.addEventListener('keydown', onStoryKey);
  pauseStory(false);
  paintStory();

  // L'anneau touché tourne le temps de l'ouverture (motion.css).
  if (fromElement?.classList.contains('story-ring')) {
    fromElement.classList.add('is-loading');
    setTimeout(() => fromElement.classList.remove('is-loading'), 450);
  }
  const rect = fromElement?.getBoundingClientRect();
  if (rect && rect.width && !reducedMotion()) {
    viewer.face.animate([
      { transform: ringTransform(rect), borderRadius: '50%' },
      { transform: 'none', borderRadius: '0px' },
    ], { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    viewer.backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280 });
  } else {
    viewer.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
  }
  viewer.last = 0;
  viewer.frame = window.requestAnimationFrame(tickStory);
  viewer.root.querySelector('.sv-nav.next')?.focus({ preventScroll: true });
}

function teardownStoryViewer() {
  window.cancelAnimationFrame(viewer.frame);
  window.cancelAnimationFrame(viewer.anim);
  window.cancelAnimationFrame(viewer.render);
  viewer.anim = 0;
  viewer.render = 0;
  clearTimeout(viewer.holdTimer);
  document.removeEventListener('keydown', onStoryKey);
  viewer.root?.remove();
  viewer.root = null;
  viewer.face = null;
  viewer.neighbor = null;
  viewer.closing = false;
  document.body.classList.remove('story-open');
  document.body.style.top = '';
  window.scrollTo(0, viewer.scrollY);
  refreshStoryRings();
  viewer.returnFocus?.focus?.({ preventScroll: true });
}

/* Se referme en se réduisant vers le rond de l'auteur (sinon fondu). */
function closeStoryViewer() {
  if (!viewer.root || viewer.closing) return;
  viewer.closing = true;
  const { face, backdrop } = viewer;
  const rect = !reducedMotion() && ringRectFor(viewer.groups[viewer.g].username);
  let animation;
  if (rect && face) {
    animation = face.animate([
      { transform: face.style.transform || 'none', borderRadius: face.style.borderRadius || '0px', opacity: 1 },
      { transform: ringTransform(rect), borderRadius: '50%', opacity: 0.4 },
    ], { duration: 250, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
    backdrop.animate([{ opacity: backdrop.style.opacity || 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
  } else {
    animation = viewer.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' });
  }
  animation.finished.then(teardownStoryViewer, teardownStoryViewer);
}

// ---------------------------------------------------------------------------
// Messages : liste des conversations et conversation avec l'équipe
// ---------------------------------------------------------------------------

/*
 * Conversation avec l'équipe. Texte brut affiché par textContent (h() crée
 * des nœuds texte) : rien n'est interprété, aucun lien cliquable.
 *
 * Pas de flux temps réel sur Vercel : interrogation toutes les 4 s quand la
 * conversation est ouverte et visible, toutes les 60 s sinon (pastille),
 * arrêtée quand l'onglet est caché (HaisselChat.pollDelay).
 *
 * La conversation n'est jamais redessinée en entier : chaque ligne a une clé
 * stable (layoutThread) ; on crée seulement les nouvelles et on met à jour
 * les autres sur place. Les conversations déjà ouvertes restent en mémoire
 * (chatCache) : réouverture instantanée, puis rafraîchissement.
 */
// Champ de saisie : 5 lignes au plus, puis il défile.
const CHAT_MAX_LINES = 5;
const LONG_PRESS_MS = 450;
// Distance au bas de la liste sous laquelle on suit les nouveaux messages.
const CHAT_STICK_PX = 80;
const chat = { pollTimer: 0, viewport: null, fullHeight: 0, open: false, unread: 0 };
const chatCache = new Map();
const NO_MESSAGE_TEXT = 'Pas encore de message. Pose ta question, l’équipe te répond ici.';

/** Conversation en mémoire : messages (serveur + envois optimistes) et lignes affichées, par clé. */
function teamThread() {
  let entry = chatCache.get('team');
  if (!entry) {
    entry = {
      loaded: false,
      nodes: new Map(),
      store: window.HaisselChat.createThreadStore({
        send: async (content) => (await api('/api/messages/team', { method: 'POST', body: { content } })).message,
      }),
    };
    chatCache.set('team', entry);
  }
  return entry;
}

function resetChat() {
  stopPolling();
  closeChat();
  chatCache.clear();
  ui.chatMessages.replaceChildren();
}

// --- Pastille de non-lus (icône de l'onglet Messages) ------------------------

function paintUnread(count) {
  chat.unread = count;
  ui.navMessagesBadge.hidden = !count;
  ui.navMessagesBadge.closest('button')?.setAttribute('aria-label', count ? `Messages (${count} non lu${count > 1 ? 's' : ''})` : 'Messages');
}

async function refreshUnread() {
  if (!state.user) return;
  try {
    const data = await api('/api/messages/unread');
    // Conversation ouverte et visible : ses réponses sont déjà lues.
    paintUnread(chat.open && document.visibilityState === 'visible' ? 0 : data.unread);
  } catch (error) { /* pastille seulement : on réessaiera */ }
  // Même rythme pour la cloche (Activité).
  loadActivity();
}

// --- Interrogation ----------------------------------------------------------

function stopPolling() {
  clearTimeout(chat.pollTimer);
  chat.pollTimer = 0;
}

function schedulePoll() {
  stopPolling();
  if (!state.user) return;
  const delay = window.HaisselChat.pollDelay({ open: chat.open, visible: document.visibilityState === 'visible' });
  if (delay !== null) chat.pollTimer = setTimeout(pollTick, delay);
}

async function pollTick() {
  stopPolling();
  if (chat.open) await loadChat();
  else await refreshUnread();
  schedulePoll();
}

function startUnreadPolling() {
  refreshUnread();
  schedulePoll();
}

// --- Conversation : lignes à clé, mises à jour sur place --------------------

function chatRowNode(row) {
  if (row.type === 'day' || row.type === 'stamp') {
    const label = row.type === 'day' ? window.HaisselChat.dayLabel(row.at) : window.HaisselChat.hourLabel(row.at);
    return h('p', { className: row.type === 'day' ? 'chat-day' : 'chat-stamp' }, h('time', { datetime: row.at }, label));
  }
  return chatRow(row);
}

/* Une bulle (texte toujours via h(), donc textContent) et, pour mes messages, son état d'envoi. */
function chatRow(row) {
  const bubble = h('div', { className: `bubble ${row.mine ? 'from-me' : 'from-team'}` },
    h('span', { className: 'visually-hidden' }, row.mine ? 'Toi : ' : 'Équipe Haissel : '),
    h('p', null, row.message.content));
  const node = h('div', { className: `bubble-row ${row.mine ? 'from-me' : 'from-team'}` }, bubble);
  node.dataset.key = row.key;
  if (row.mine) node.append(h('span', { className: 'chat-receipt', 'aria-live': 'polite' }));
  updateChatRow(node, row);
  return node;
}

const RECEIPTS = { sending: 'Envoi…', failed: 'Toucher pour réessayer' };

function updateChatRow(node, row) {
  if (row.type !== 'bubble') return;
  const bubble = node.firstChild;
  bubble.classList.toggle('group-start', row.groupStart);
  bubble.classList.toggle('tail', row.tail);
  bubble.title = new Date(row.message.created_at).toLocaleString('fr-FR');
  if (!row.mine) return;
  const status = row.status || (row.sent ? 'sent' : '');
  if (node.dataset.status === status) return;
  node.dataset.status = status;
  node.classList.toggle('is-failed', status === 'failed');
  node.classList.toggle('is-sending', status === 'sending');
  const receipt = node.querySelector('.chat-receipt');
  receipt.textContent = status === 'sent' ? 'Envoyé' : RECEIPTS[status] || '';
  receipt.hidden = !status;
  node.querySelector('.bubble-alert')?.remove();
  if (status === 'failed') {
    // Point d'exclamation rouge collé à la bulle : toute la ligne réessaie l'envoi.
    bubble.append(h('button', { className: 'bubble-alert', type: 'button', 'aria-label': 'Message non envoyé. Réessayer' }, '!'));
  }
}

/** Premier élément visible : repère pour que rien ne saute quand des lignes s'ajoutent au-dessus. */
function firstVisibleRow(list) {
  const top = list.getBoundingClientRect().top;
  return [...list.children].find((node) => node.getBoundingClientRect().bottom > top) || null;
}

/*
 * Rapproche le DOM de la liste calculée : lignes disparues retirées, nouvelles
 * créées et insérées à leur place, existantes seulement mises à jour.
 * Renvoie les lignes créées et si l'on était en bas avant.
 */
function renderChat() {
  const entry = teamThread();
  const list = ui.chatMessages;
  const messages = entry.store.messages();
  const empty = list.querySelector('.chat-empty');
  if (!messages.length) {
    if (entry.loaded && !empty) {
      list.replaceChildren(h('div', { className: 'chat-empty mascot-state' }, bear('aucun-message', 120), h('p', null, NO_MESSAGE_TEXT)));
    }
    return { created: [], atBottom: true };
  }
  empty?.remove();
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < CHAT_STICK_PX;
  const anchor = atBottom ? null : firstVisibleRow(list);
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;

  const rows = window.HaisselChat.layoutThread(messages);
  const keep = new Set(rows.map((row) => row.key));
  for (const [key, node] of entry.nodes) {
    if (!keep.has(key)) { node.remove(); entry.nodes.delete(key); }
  }
  // L'équipe n'a encore rien répondu : l'ours « aucun message » en tête du fil.
  const waiting = !messages.some((m) => m.from_team);
  let hint = list.querySelector('.chat-hint');
  if (waiting && !hint) {
    hint = h('div', { className: 'chat-hint mascot-state' }, bear('aucun-message', 120), h('p', null, NO_MESSAGE_TEXT));
    list.prepend(hint);
  } else if (!waiting && hint) {
    hint.remove();
    hint = null;
  }
  const created = [];
  let previous = hint;
  rows.forEach((row) => {
    let node = entry.nodes.get(row.key);
    if (node) updateChatRow(node, row);
    else {
      node = chatRowNode(row);
      entry.nodes.set(row.key, node);
      created.push({ row, node });
    }
    const expected = previous ? previous.nextSibling : list.firstChild;
    if (node !== expected) list.insertBefore(node, expected);
    previous = node;
  });
  // Ancrage : le message qu'on lisait reste à la même hauteur.
  if (anchor && anchor.isConnected) {
    const delta = anchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > 1) list.scrollTop += delta;
  }
  return { created, atBottom };
}

function scrollChatToEnd(smooth = false) {
  const list = ui.chatMessages;
  if (smooth && !reducedMotion()) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  else list.scrollTop = list.scrollHeight;
  ui.chatNew.hidden = true;
}

async function loadChat() {
  const entry = teamThread();
  try {
    const data = await api('/api/messages/team');
    const added = entry.store.applyServer(data.messages || []);
    const first = !entry.loaded;
    entry.loaded = true;
    const { created, atBottom } = renderChat();
    paintUnread(0);
    if (first) { scrollChatToEnd(); return; }
    // Nouveaux messages : la bulle apparaît depuis son coin (motion.css).
    created.forEach(({ row, node }) => { if (row.type === 'bubble') node.firstChild.classList.add('m-new'); });
    if (atBottom) scrollChatToEnd(true);
    else if (added.length) ui.chatNew.hidden = false;
  } catch (error) {
    if (error.status === 401 || error.status === 403) return;
    ui.chatError.textContent = error.message;
    ui.chatError.classList.remove('hidden');
  }
}

/*
 * Envoi optimiste : la bulle apparaît tout de suite (« Envoi… »), le champ
 * se vide, puis « Envoyé ». En cas d'échec : point d'exclamation rouge et
 * « Toucher pour réessayer ». Les envois partent dans l'ordre (createThreadStore).
 */
function sendChat() {
  const content = ui.chatInput.value.trim();
  if (!content) return;
  ui.chatError.classList.add('hidden');
  ui.chatInput.value = '';
  fitChatInput();
  const { done } = teamThread().store.post(content);
  showSent(done);
  ui.chatInput.focus({ preventScroll: true });
}

function retryChat(key) {
  const done = teamThread().store.retry(key);
  if (done) showSent(done);
}

function showSent(done) {
  const { created } = renderChat();
  // Montée depuis la barre de saisie (motion.css, .m-send).
  created.forEach(({ row, node }) => { if (row.type === 'bubble') node.firstChild.classList.add('m-send'); });
  scrollChatToEnd(true);
  done.then(() => {
    renderChat();
  });
}

// --- Ouverture, fermeture, gestes -------------------------------------------

/*
 * Clavier iOS : la page ne rétrécit pas, seul visualViewport change. La
 * conversation (position fixe) suit donc la zone visible : la barre de
 * saisie reste collée au-dessus du clavier et le dernier message visible.
 */
function fitChatToViewport() {
  const vv = window.visualViewport;
  if (!vv || ui.teamThread.hidden) return;
  /*
   * Clavier ouvert : la zone sûre du bas est déjà couverte par le clavier.
   * Le seuil compare à la plus grande hauteur vue : depuis l'écran d'accueil
   * et dans Chrome iOS, innerHeight peut rétrécir avec le clavier.
   */
  chat.fullHeight = Math.max(chat.fullHeight || 0, window.innerHeight, vv.height);
  const open = chat.fullHeight - vv.height > 120;
  const opened = open && !ui.teamThread.classList.contains('keyboard-open');
  ui.teamThread.classList.toggle('keyboard-open', open);
  /*
   * Entre l'en-tête de l'app et la barre du bas (qui garde la pastille) ;
   * clavier ouvert, la barre du bas est sous le clavier : collée au clavier.
   */
  const header = document.querySelector('.topbar');
  const nav = document.querySelector('.topbar-nav');
  const top = Math.max(0, header ? header.getBoundingClientRect().bottom : 0);
  const navHeight = !open && nav && nav.getClientRects().length ? Math.max(0, window.innerHeight - nav.getBoundingClientRect().top) : 0;
  ui.teamThread.style.setProperty('--chat-top', `${vv.offsetTop + top}px`);
  ui.teamThread.style.setProperty('--chat-height', `${Math.max(200, vv.height - top - navHeight)}px`);
  const list = ui.chatMessages;
  // À l'ouverture du clavier : dernier message. Sinon, on reste en bas si on y était.
  if (opened || list.scrollHeight - list.scrollTop - list.clientHeight < CHAT_STICK_PX) scrollChatToEnd();
}

/* Hauteur de la barre de saisie (superposée) : marge du bas de la liste. */
function watchChatForm() {
  if (chat.formObserver || !('ResizeObserver' in window)) return;
  chat.formObserver = new ResizeObserver(() => {
    ui.teamThread.style.setProperty('--chat-form-h', `${ui.chatForm.offsetHeight}px`);
  });
  chat.formObserver.observe(ui.chatForm);
}

function watchViewport(on) {
  const vv = window.visualViewport;
  if (!vv) return;
  if (on && !chat.viewport) {
    chat.viewport = () => window.requestAnimationFrame(fitChatToViewport);
    vv.addEventListener('resize', chat.viewport);
    vv.addEventListener('scroll', chat.viewport);
    fitChatToViewport();
  } else if (!on && chat.viewport) {
    vv.removeEventListener('resize', chat.viewport);
    vv.removeEventListener('scroll', chat.viewport);
    chat.viewport = null;
  }
}

/** Hauteur du champ : suit le texte jusqu'à 5 lignes ; bouton d'envoi actif seulement s'il y a du texte. */
function fitChatInput() {
  const input = ui.chatInput;
  const style = window.getComputedStyle(input);
  const line = parseFloat(style.lineHeight) || 20;
  const extra = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  input.style.height = '';
  input.style.height = `${Math.min(input.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), line * CHAT_MAX_LINES + extra)}px`;
  ui.chatSend.disabled = !input.value.trim();
}

/*
 * Côté membre, l'onglet Messages est directement la conversation avec
 * l'équipe : seul interlocuteur possible. Elle s'affiche à l'entrée dans
 * l'onglet (déjà en mémoire : instantané) et se ferme quand on le quitte.
 */
function openChat() {
  if (chat.open) return;
  chat.open = true;
  ui.teamThread.hidden = false;
  document.body.classList.add('chat-open');
  ui.chatError.classList.add('hidden');
  fitChatInput();
  watchChatForm();
  watchViewport(true);
  renderChat();
  scrollChatToEnd();
  pollTick();
}

function closeChat() {
  if (!chat.open) return;
  chat.open = false;
  closeBubbleMenu();
  ui.chatNew.hidden = true;
  watchViewport(false);
  ui.teamThread.hidden = true;
  document.body.classList.remove('chat-open');
  schedulePoll();
}

/*
 * Appui long : timer de 450 ms annulé si le doigt bouge de plus de 10 px.
 * onPress(point) ; le clic qui suit un appui long est ignoré. Le clic droit
 * (ordinateur) fait la même chose.
 */
function onLongPress(target, selector, onPress) {
  let press = null;
  const cancel = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press.el.classList.remove('is-pressed');
    press = null;
  };
  target.addEventListener('pointerdown', (event) => {
    delete target.dataset.longPressed;
    const el = event.target.closest(selector);
    if (!el || event.button > 0) return;
    cancel();
    el.classList.add('is-pressed');
    const point = { x: event.clientX, y: event.clientY };
    press = { el, point, fired: false, timer: setTimeout(() => {
      press.fired = true;
      press.el.classList.remove('is-pressed');
      target.dataset.longPressed = '1';
      onPress(el, point);
    }, LONG_PRESS_MS) };
  });
  target.addEventListener('pointermove', (event) => {
    if (press && !press.fired && Math.hypot(event.clientX - press.point.x, event.clientY - press.point.y) > 10) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => target.addEventListener(type, () => {
    if (press && !press.fired) cancel();
    else if (press) press = null;
  }));
  target.addEventListener('click', (event) => {
    if (!target.dataset.longPressed) return;
    delete target.dataset.longPressed;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  target.addEventListener('contextmenu', (event) => {
    const el = event.target.closest(selector);
    if (!el) return;
    event.preventDefault();
    cancel();
    onPress(el, { x: event.clientX, y: event.clientY });
  });
}

// --- Appui long sur une bulle : Copier --------------------------------------

let bubbleMenu = null;

function openBubbleMenu(bubble) {
  closeBubbleMenu();
  const row = bubble.closest('.bubble-row');
  const text = bubble.querySelector('p')?.textContent || '';
  const backdrop = h('div', { className: 'bubble-backdrop' });
  const menu = h('div', { className: 'bubble-menu lg-glass', role: 'menu', 'aria-label': 'Actions du message' },
    h('button', {
      type: 'button', role: 'menuitem',
      onclick: async () => {
        closeBubbleMenu();
        try {
          await navigator.clipboard.writeText(text);
          window.HaisselMotion?.toast('Message copié');
        } catch (error) {
          window.HaisselMotion?.toast('Copie impossible sur ce navigateur', { check: false });
        }
      },
    }, 'Copier'));
  backdrop.addEventListener('click', closeBubbleMenu);
  ui.teamThread.append(backdrop, menu);
  row.classList.add('is-focused');
  bubble.classList.add('is-lifted');
  // Sous la bulle, ou au-dessus s'il n'y a pas la place.
  const rect = bubble.getBoundingClientRect();
  const host = ui.teamThread.getBoundingClientRect();
  const below = rect.bottom + 8 + 52 < host.bottom - ui.chatForm.offsetHeight;
  menu.style.top = `${(below ? rect.bottom + 8 : rect.top - 8 - 52) - host.top}px`;
  if (row.classList.contains('from-me')) menu.style.right = `${host.right - rect.right}px`;
  else menu.style.left = `${rect.left - host.left}px`;
  bubbleMenu = { backdrop, menu, row, bubble };
  window.HaisselMotion?.openMenu(menu, { x: row.classList.contains('from-me') ? rect.right : rect.left, y: below ? rect.bottom : rect.top });
  menu.querySelector('button').focus({ preventScroll: true });
}

function closeBubbleMenu() {
  if (!bubbleMenu) return;
  const { backdrop, menu, row, bubble } = bubbleMenu;
  bubbleMenu = null;
  bubble.classList.remove('is-lifted');
  backdrop.classList.add('is-leaving');
  const done = () => { backdrop.remove(); menu.remove(); row.classList.remove('is-focused'); };
  if (window.HaisselMotion) window.HaisselMotion.closeMenu(menu, done);
  else done();
}

function bindMessages() {
  onLongPress(ui.chatMessages, '.bubble', openBubbleMenu);
  ui.chatMessages.addEventListener('click', (event) => {
    const row = event.target.closest('.bubble-row.is-failed');
    if (row) retryChat(row.dataset.key);
  });
  ui.chatMessages.addEventListener('scroll', () => {
    const list = ui.chatMessages;
    if (!ui.chatNew.hidden && list.scrollHeight - list.scrollTop - list.clientHeight < CHAT_STICK_PX) ui.chatNew.hidden = true;
  }, { passive: true });
  ui.chatNew.addEventListener('click', () => scrollChatToEnd(true));
  ui.teamThread.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeBubbleMenu(); });
  ui.chatSend.addEventListener('click', sendChat);
  ui.chatInput.addEventListener('input', fitChatInput);
  // Mobile : Entrée = saut de ligne, envoi par le bouton. Ordinateur : Entrée envoie.
  const touchInput = window.matchMedia('(hover: none) and (pointer: coarse)');
  ui.chatInput.addEventListener('keydown', (event) => {
    if (window.HaisselChat.enterSends(event, touchInput.matches)) { event.preventDefault(); sendChat(); }
  });
  // Onglet caché : plus d'interrogation ; au retour, tout de suite.
  document.addEventListener('visibilitychange', () => {
    if (!state.user) return;
    if (document.visibilityState === 'visible') pollTick();
    else stopPolling();
  });
}

let communityTimer;
function scheduleCommunityLoad() {
  clearTimeout(communityTimer);
  communityTimer = setTimeout(() => { syncFiltersToUrl(); loadCommunity(); }, 250);
}

async function toggleSave(offer, button) {
  button.disabled = true;
  try {
    await api(`/api/community/offers/${encodeURIComponent(offer.id)}/save`, { method: offer.saved ? 'DELETE' : 'POST' });
    offer.saved = !offer.saved;
    paintSaveButton(button, offer.saved);
    if (ui.communitySaved.checked && !offer.saved) loadCommunity();
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
  }
}

function openReport(offer) {
  state.community.reportId = offer.id;
  ui.reportOffer.textContent = `« ${offer.title} » publiée par @${offer.author.username}`;
  ui.reportForm.reset();
  ui.reportError.classList.add('hidden');
  openDialog(ui.reportDialog);
}

async function handleReport(event) {
  event.preventDefault();
  const reason = ui.reportReason.value;
  if (!reason) {
    ui.reportError.textContent = 'Choisis un motif.';
    ui.reportError.classList.remove('hidden');
    return;
  }
  setBusy(ui.reportForm, true);
  try {
    const data = await api(`/api/community/offers/${encodeURIComponent(state.community.reportId)}/report`, {
      method: 'POST', body: { reason, details: ui.reportDetails.value.trim() },
    });
    closeDialog(ui.reportDialog);
    window.alert(data.message);
  } catch (error) {
    ui.reportError.textContent = error.message;
    ui.reportError.classList.remove('hidden');
  } finally {
    setBusy(ui.reportForm, false);
  }
}

async function openMember(username) {
  ui.memberTitle.textContent = `@${username}`;
  ui.memberMeta.textContent = 'Chargement…';
  ui.memberOffers.replaceChildren();
  openDialog(ui.memberDialog);
  try {
    const [{ profile }, offers] = await Promise.all([
      api(`/api/community/members/${encodeURIComponent(username)}`),
      api(`/api/community/offers?author=${encodeURIComponent(username)}`),
    ]).catch((error) => {
      // Profil privé (par défaut) : seuls le membre et l'équipe le voient.
      if (error.status === 403) {
        ui.memberMeta.textContent = 'Ce profil est privé. Ses fiches publiées restent visibles dans le fil.';
        return [{ profile: null }, null];
      }
      throw error;
    });
    if (!profile) return;
    ui.memberMeta.textContent = `Membre depuis le ${formatDate(profile.member_since)} · ${profile.published_offers} offre${profile.published_offers > 1 ? 's' : ''} publiée${profile.published_offers > 1 ? 's' : ''}`;
    ui.memberOffers.replaceChildren(...(offers.items.length
      ? offers.items.map((offer) => communityCard(offer))
      : [h('p', { className: 'security-note' }, 'Aucune offre publiée.')]));
  } catch (error) {
    ui.memberMeta.textContent = error.message;
  }
}

// ---------------------------------------------------------------------------
// Publier
// ---------------------------------------------------------------------------

function readPublishForm() {
  const minAge = ui.pubAgeChips.querySelector('input:checked')?.value || '';
  const values = {
    title: ui.pubTitle.value.trim(),
    url: ui.pubUrl.value.trim(),
    description: ui.pubDescription.value.trim(),
    category: ui.pubCategory.value,
    countries: readCountries(),
    expected_action: readAction(),
    min_age: minAge === '' ? null : Number(minAge),
    conditions: readConditions() || null,
    rights_confirmed: ui.pubRights.checked,
  };
  // Fiche campagne (membre) : nom de la campagne et conseils.
  if (!isAdminUser()) {
    values.campaign_name = ui.pubCampaignName.value.trim();
    values.tips = ui.pubTips.value.trim() || null;
  }
  /*
   * La rémunération n'est plus saisie. Le serveur réécrit tous les champs
   * lors d'une modification : on renvoie celle de l'offre telle quelle,
   * pour qu'elle ne soit pas effacée.
   */
  if (state.community.editingPayout) values.payout_text = state.community.editingPayout;
  return values;
}

// ---- Choix du formulaire Publier (puces) ---------------------------------
// Les valeurs envoyées gardent le format d'avant : pays « FR, BE », action
// et conditions en texte, âge en nombre ou null.

const PUB_COUNTRIES = [['FR', 'France'], ['BE', 'Belgique'], ['CH', 'Suisse'], ['LU', 'Luxembourg'], ['CA', 'Canada']];
const PUB_MORE_COUNTRIES = [
  ['DE', 'Allemagne'], ['AT', 'Autriche'], ['ES', 'Espagne'], ['US', 'États-Unis'], ['IE', 'Irlande'],
  ['IT', 'Italie'], ['MA', 'Maroc'], ['MC', 'Monaco'], ['NL', 'Pays-Bas'], ['PL', 'Pologne'],
  ['PT', 'Portugal'], ['GB', 'Royaume-Uni'], ['SN', 'Sénégal'], ['CI', 'Côte d’Ivoire'], ['TN', 'Tunisie'], ['DZ', 'Algérie'],
];
const PUB_ACTIONS = [
  'S\'inscrire avec un e-mail confirmé', 'Installer l\'appli', 'Installer et ouvrir l\'appli',
  'Faire un premier achat', 'Remplir un formulaire',
];
const PUB_CONDITIONS = ['Pas de trafic incité', 'Pas d\'envoi en masse', 'Un seul compte par personne', 'France uniquement'];
const CONDITIONS_SEPARATOR = ' · ';
const CONDITIONS_MAX = 2000;
const OTHER = '__autre__';

/** Drapeau en émoji à partir du code pays (FR → 🇫🇷). */
function countryFlag(code) {
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌍';
}

function countryName(code) {
  return [...PUB_COUNTRIES, ...PUB_MORE_COUNTRIES].find(([c]) => c === code)?.[1] || code;
}

/** Une puce : vraie case ou vrai bouton radio, donc utilisable au clavier. */
function choiceChip({ type, name, value, label, checked = false, flag = '', onchange }) {
  return h('label', { className: 'choice-chip' },
    h('input', { type, name, value, checked, onchange }),
    flag ? h('span', { className: 'choice-flag', 'aria-hidden': 'true' }, flag) : null,
    h('span', null, label),
    icon('i-check', 'icon sm choice-check'));
}

function addCountryChip(code, checked = true) {
  const existing = [...ui.pubCountryChips.querySelectorAll('input')].find((input) => input.value === code);
  if (existing) {
    existing.checked = true;
    return;
  }
  ui.pubCountryChips.append(choiceChip({
    type: 'checkbox', name: 'pub-country', value: code, label: countryName(code), flag: countryFlag(code), checked,
    onchange: updatePublishPreview,
  }));
}

function readCountries() {
  return [...ui.pubCountryChips.querySelectorAll('input:checked')].map((input) => input.value).join(', ');
}

function readAction() {
  const choice = ui.pubActionChips.querySelector('input:checked')?.value || '';
  return choice === OTHER ? ui.pubActionOther.value.trim() : choice;
}

function readConditions() {
  const parts = [...ui.pubConditionChips.querySelectorAll('input:checked')]
    .filter((input) => input.value !== OTHER).map((input) => input.value);
  if (ui.pubConditionChips.querySelector(`input[value="${OTHER}"]`).checked) {
    const other = ui.pubConditionsOther.value.trim();
    if (other) parts.push(other);
  }
  return parts.join(CONDITIONS_SEPARATOR);
}

/** Champs « Autre » : visibles seulement quand leur puce est choisie. */
function syncOtherFields() {
  const actionOther = ui.pubActionChips.querySelector('input:checked')?.value === OTHER;
  ui.pubActionOtherField.hidden = !actionOther;
  ui.pubActionOther.required = actionOther;
  const conditionsOther = ui.pubConditionChips.querySelector(`input[value="${OTHER}"]`).checked;
  ui.pubConditionsOtherField.hidden = !conditionsOther;
  // Limite de 2000 caractères pour le texte complet, séparateurs compris.
  const fixed = [...ui.pubConditionChips.querySelectorAll('input:checked')]
    .filter((input) => input.value !== OTHER).map((input) => input.value).join(CONDITIONS_SEPARATOR);
  const room = CONDITIONS_MAX - fixed.length - (fixed ? CONDITIONS_SEPARATOR.length : 0);
  ui.pubConditionsOther.maxLength = Math.max(0, room);
  ui.pubConditionsCount.textContent = `${[...ui.pubConditionsOther.value].length}/${Math.max(0, room)}`;
}

function onChoiceChange() {
  syncOtherFields();
  updatePublishPreview();
}

function renderPublishChoices() {
  ui.pubCountryChips.replaceChildren();
  for (const [code] of PUB_COUNTRIES) addCountryChip(code, code === 'FR');
  ui.pubCountryMore.replaceChildren(h('option', { value: '' }, 'Autre pays…'),
    ...PUB_MORE_COUNTRIES.map(([code, name]) => h('option', { value: code }, `${countryFlag(code)} ${name}`)));

  ui.pubActionChips.replaceChildren(...[...PUB_ACTIONS, OTHER].map((value) => choiceChip({
    type: 'radio', name: 'pub-action', value, label: value === OTHER ? 'Autre…' : value, onchange: onChoiceChange,
  })));
  ui.pubAgeChips.replaceChildren(
    choiceChip({ type: 'radio', name: 'pub-age', value: '', label: 'Pas d’âge précisé', checked: true, onchange: onChoiceChange }),
    choiceChip({ type: 'radio', name: 'pub-age', value: '18', label: '18 ans et +', onchange: onChoiceChange }));
  ui.pubConditionChips.replaceChildren(...[...PUB_CONDITIONS, OTHER].map((value) => choiceChip({
    type: 'checkbox', name: 'pub-condition', value, label: value === OTHER ? 'Autre' : value, onchange: onChoiceChange,
  })));
  ui.pubActionOther.value = '';
  ui.pubConditionsOther.value = '';
  syncOtherFields();
}

/** Comparaison tolérante (apostrophes droites ou typographiques, casse). */
function sameChoice(a, b) {
  const norm = (value) => String(value).replace(/[’‘]/g, '\'').trim().toLowerCase();
  return norm(a) === norm(b);
}

/*
 * Modifier une offre : on recoche les choix à partir des valeurs
 * enregistrées. Ce qui ne correspond à aucun choix va dans « Autre ».
 */
function fillPublishChoices(offer) {
  renderPublishChoices();
  ui.pubCountryChips.querySelectorAll('input').forEach((input) => { input.checked = false; });
  for (const code of String(offer.countries || '').split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean)) {
    addCountryChip(code);
  }

  const action = String(offer.expected_action || '').trim();
  const known = PUB_ACTIONS.find((value) => sameChoice(value, action));
  const actionInput = [...ui.pubActionChips.querySelectorAll('input')].find((input) => input.value === (known || OTHER));
  if (action) actionInput.checked = true;
  if (action && !known) ui.pubActionOther.value = action;

  const age = offer.min_age;
  if (age !== null && age !== undefined && age !== 18) {
    // Âge fixé autrement par le passé : on le garde, proposé comme 3e choix.
    ui.pubAgeChips.append(choiceChip({ type: 'radio', name: 'pub-age', value: String(age), label: `${age} ans et + (actuel)`, onchange: onChoiceChange }));
  }
  ui.pubAgeChips.querySelectorAll('input').forEach((input) => { input.checked = input.value === (age === null || age === undefined ? '' : String(age)); });

  const others = [];
  for (const part of String(offer.conditions || '').split(CONDITIONS_SEPARATOR).map((p) => p.trim()).filter(Boolean)) {
    const input = [...ui.pubConditionChips.querySelectorAll('input')].find((i) => i.value !== OTHER && sameChoice(i.value, part));
    if (input) input.checked = true;
    else others.push(part);
  }
  if (others.length) {
    ui.pubConditionChips.querySelector(`input[value="${OTHER}"]`).checked = true;
    ui.pubConditionsOther.value = others.join(CONDITIONS_SEPARATOR);
  }
  syncOtherFields();
}

/*
 * Messages d'erreur : le serveur indique le champ fautif (error.field), ce qui
 * permet de placer le message juste sous ce champ plutôt qu'en haut du
 * formulaire, où il passe inaperçu sur un téléphone.
 */
const PUBLISH_FIELD_INPUTS = {
  title: 'pubTitle',
  url: 'pubUrl',
  campaign_name: 'pubCampaignName',
  tips: 'pubTips',
  description: 'pubDescription',
  category: 'pubCategory',
  countries: 'pubCountriesGroup',
  expected_action: 'pubActionGroup',
  min_age: 'pubAgeGroup',
  conditions: 'pubConditionsGroup',
  rights_confirmed: 'pubRights',
};

function clearFieldErrors() {
  for (const field of Object.keys(PUBLISH_FIELD_INPUTS)) {
    const slot = document.getElementById(`err-${field}`);
    if (slot) {
      slot.textContent = '';
      slot.classList.add('hidden');
    }
    const input = ui[PUBLISH_FIELD_INPUTS[field]];
    if (input) input.removeAttribute('aria-invalid');
  }
}

/** Retourne true si le message a pu être placé sous un champ. */
function showFieldError(field, message) {
  const slot = field ? document.getElementById(`err-${field}`) : null;
  if (!slot) return false;
  slot.textContent = message;
  slot.classList.remove('hidden');
  const input = ui[PUBLISH_FIELD_INPUTS[field]];
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    // Groupes de puces : le focus va sur le premier choix (ou le champ « Autre » ouvert).
    let target = input;
    if (field === 'category') target = ui.pubCategoryTiles.querySelector('input');
    else if (input.tagName === 'FIELDSET') {
      target = [...input.querySelectorAll('input:not([type=radio]):not([type=checkbox])')].find((el) => !el.closest('[hidden]'))
        || input.querySelector('input');
    }
    if (target) target.focus({ preventScroll: false });
  }
  return true;
}

function publishFeedback(kind, message) {
  ui.publishError.textContent = kind === 'error' ? message : '';
  ui.publishError.classList.toggle('hidden', kind !== 'error');
  ui.publishSuccess.textContent = kind === 'info' ? message : '';
  ui.publishSuccess.classList.toggle('hidden', kind !== 'info');
}

/** Contrôles de confort ; le serveur revérifie tout. */
function checkPublishForm(values) {
  if (values.title.length < 5) return 'Le titre doit contenir au moins 5 caractères.';
  if (!/^https:\/\//i.test(values.url)) return 'Le lien doit commencer par https://';
  if (values.campaign_name !== undefined && values.campaign_name.length < 2) return 'Indique le nom de la campagne MyLead.';
  if (values.description.length < 20) return 'La description doit contenir au moins 20 caractères.';
  if (!values.category) return 'Choisis une catégorie.';
  if (values.countries.length < 2) return 'Choisis au moins un pays.';
  if (!values.expected_action) return 'Choisis ce qu’il faut faire.';
  if (values.expected_action.length < 5) return 'Décris l’action attendue (5 caractères minimum).';
  if (values.conditions && values.conditions.length > CONDITIONS_MAX) {
    return `Les conditions dépassent ${CONDITIONS_MAX} caractères : raccourcis le champ « Autre ».`;
  }
  if (!values.rights_confirmed) return 'Coche la confirmation avant d’envoyer.';
  return '';
}

/*
 * Catégorie : des tuiles (boutons radio) pilotent la liste <select> masquée,
 * que readPublishForm et startOfferEdit continuent d'utiliser.
 */
function renderCategoryTiles() {
  if (!ui.pubCategoryTiles) return;
  ui.pubCategoryTiles.replaceChildren(...Object.entries(state.community.categories).map(([value, label]) => h('label', { className: 'cat-tile' },
    h('input', {
      type: 'radio', name: 'pub-category-tile', value,
      onchange: () => {
        ui.pubCategory.value = value;
        updatePublishPreview();
      },
    }),
    h('span', { className: 'cat-tile-icon', 'aria-hidden': 'true' }, categoryIcon(value)),
    h('span', { className: 'cat-tile-label' }, label))));
  syncCategoryTiles();
}

function syncCategoryTiles() {
  if (!ui.pubCategoryTiles) return;
  ui.pubCategoryTiles.querySelectorAll('input').forEach((input) => {
    input.checked = input.value === ui.pubCategory.value;
  });
}

function updateTitleCount() {
  ui.pubTitleCount.textContent = `${[...ui.pubTitle.value].length}/${ui.pubTitle.maxLength}`;
}

/** Aperçu en direct : la carte telle qu'elle apparaîtra dans le fil. */
function updatePublishPreview() {
  const values = readPublishForm();
  let domain = '';
  try { domain = new URL(values.url).hostname; } catch (error) { /* lien incomplet */ }
  const preview = {
    ...values,
    kind: isAdminUser() ? 'affiliate' : 'campaign',
    domain,
    title: values.title || 'Titre de ton offre',
    expected_action: values.expected_action || 'L’action attendue apparaîtra ici.',
    description: values.description || 'Ta description apparaîtra ici.',
    category_label: state.community.categories[values.category] || 'Catégorie',
    author: { username: state.user?.username || 'toi' },
    created_at: new Date().toISOString(),
    saved: false,
    is_mine: true,
  };
  ui.publishPreviewCard.replaceChildren(communityCard(preview, { preview: true }));
}

function resetPublishForm() {
  state.community.editing = null;
  state.community.editingPayout = null;
  ui.publishForm.reset();
  renderPublishChoices();
  ui.publishFormTitle.textContent = isAdminUser() ? 'Nouvelle offre' : 'Nouvelle fiche';
  ui.pubCancelEdit.classList.add('hidden');
  syncCategoryTiles();
  updateTitleCount();
  updatePublishPreview();
}

function startOfferEdit(offer) {
  setActiveView('publish');
  state.community.editing = offer.id;
  ui.pubTitle.value = offer.title;
  ui.pubUrl.value = offer.url;
  ui.pubCampaignName.value = offer.campaign_name || '';
  ui.pubTips.value = offer.tips || '';
  ui.pubDescription.value = offer.description;
  ui.pubCategory.value = offer.category;
  state.community.editingPayout = offer.payout_text || null;
  fillPublishChoices(offer);
  ui.pubRights.checked = false;
  syncCategoryTiles();
  updateTitleCount();
  updatePublishPreview();
  // Options facultatives déjà remplies : on les montre.
  ui.publishForm.querySelector('.pub-more').open = Boolean(offer.min_age || offer.conditions);
  ui.publishFormTitle.textContent = `Modifier : ${offer.title}`;
  ui.pubCancelEdit.classList.remove('hidden');
  publishFeedback('info', 'Une offre modifiée est de nouveau vérifiée avant d’être visible.');
  ui.publishForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Message au-dessus de la liste « Mes offres » (profil). */
function myOffersFeedback(kind, message) {
  ui.myOffersFeedback.textContent = message || '';
  ui.myOffersFeedback.className = kind === 'error' ? 'auth-error' : 'auth-info';
  ui.myOffersFeedback.classList.toggle('hidden', !message);
}

async function removeMyOffer(offer) {
  if (!window.confirm(`Retirer « ${offer.title} » ? Elle ne sera plus visible.`)) return;
  try {
    const data = await api(`/api/community/offers/${encodeURIComponent(offer.id)}`, { method: 'DELETE' });
    myOffersFeedback('info', data.message);
    loadMyOffers();
    state.community.loaded = false;
  } catch (error) {
    myOffersFeedback('error', error.message);
  }
}

const STATUS_ICONS = { pending: 'i-clock', published: 'i-check-circle', rejected: 'i-alert', expired: 'i-clock' };

/*
 * Republier une fiche pour 24 h. Aucune condition liée aux fiches des autres
 * membres : le serveur ne vérifie que l'auteur et le délai de 20 h.
 */
async function renewMyOffer(offer) {
  try {
    const data = await api(`/api/community/offers/${encodeURIComponent(offer.id)}/renew`, { method: 'POST' });
    myOffersFeedback('info', data.message);
    window.HaisselMotion?.toast('Ta story est de nouveau en ligne pour 24 h', { mascot: 'story-selfie' });
    loadMyOffers();
    state.community.loaded = false;
  } catch (error) {
    myOffersFeedback('error', error.message);
  }
}

/*
 * Une offre de l'auteur : statut, et message de l'équipe quand il existe
 * (motif de refus, ou masquage après signalements). Aucun compteur : le
 * serveur n'en fournit pas.
 */
function myOfferCard(offer) {
  const expired = offer.status === 'published' && offer.expired;
  const [label, kind] = expired ? ['Expirée', 'expired'] : (OFFER_STATUS_LABELS[offer.status] || [offer.status, 'pending']);
  const left = offer.status === 'published' ? storyTimeLeft(offer) : null;
  const sent = offer.status === 'published' && offer.published_at
    ? [`Publiée ${formatAgo(offer.shown_at || offer.published_at)}`, left].filter(Boolean).join(' · ')
    : `Envoyée ${formatAgo(offer.created_at)}`;
  let note = null;
  if (offer.moderation_note) {
    note = h('div', { className: `mo-note ${kind === 'rejected' ? 'is-rejected' : ''}` },
      h('strong', null, icon('i-alert', 'icon sm'), kind === 'rejected' ? 'Motif du refus' : 'Message de l’équipe'),
      h('p', null, offer.moderation_note));
  } else if (kind === 'pending') {
    note = h('p', { className: 'mo-note' }, icon('i-clock', 'icon sm'), 'L’équipe relit ton offre avant publication.');
  } else if (expired) {
    note = h('p', { className: 'mo-note' }, icon('i-clock', 'icon sm'), 'Ta fiche n’est plus visible dans le fil. Tu peux la republier pour 24 h, sans nouvelle vérification.');
  }
  return h('article', { className: 'my-offer-card my-offer' },
    h('div', { className: 'mo-head' },
      h('span', { className: 'fc-avatar', 'aria-hidden': 'true' }, categoryIcon(offer.category)),
      h('div', { className: 'mo-id' },
        h('h4', null, offer.title),
        h('p', null, [sent, offer.domain].filter(Boolean).join(' · '))),
      h('span', { className: `status-tag ${kind}` }, icon(STATUS_ICONS[kind] || 'i-clock', 'icon sm'), label)),
    note,
    h('div', { className: 'mo-actions' },
      expired ? h('button', { className: 'primary-button small-button', type: 'button', onclick: () => renewMyOffer(offer) }, icon('i-send', 'icon sm'), 'Republier pour 24 h') : null,
      h('button', { className: 'secondary-button small-button', type: 'button', onclick: () => startOfferEdit(offer) }, icon('i-edit', 'icon sm'), 'Modifier'),
      h('button', {
        className: 'round-button mo-remove', type: 'button', 'aria-label': `Retirer « ${offer.title} »`, onclick: () => removeMyOffer(offer),
      }, icon('i-trash'))));
}

/*
 * Vignette d'une de mes fiches (grille du profil), avec son statut en
 * pastille. Toucher affiche au-dessus de la grille la carte complète :
 * message de l'équipe, Republier, Modifier, Retirer.
 */
function myOfferTile(offer) {
  const expired = offer.status === 'published' && offer.expired;
  const [label] = expired ? ['Expirée'] : (OFFER_STATUS_LABELS[offer.status] || [offer.status]);
  return h('button', {
    className: `grid-cell${expired ? ' is-expired' : ''}`, type: 'button', 'aria-label': `${offer.title} : ${label}. Gérer cette fiche`,
    'data-offer-id': String(offer.id),
    onclick: () => {
      const pose = { published: expired ? null : 'fiche-validee', rejected: 'fiche-refusee' }[offer.status];
      ui.myOfferDetail.replaceChildren(
        h('button', { className: 'text-button my-offer-detail-close', type: 'button', onclick: () => { ui.myOfferDetail.hidden = true; } }, icon('i-close', 'icon sm'), 'Fermer'),
        pose ? bear(pose, 88) : null,
        myOfferCard(offer));
      ui.myOfferDetail.hidden = false;
      ui.myOfferDetail.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  }, categoryVisual(offer.category, 'grid-tile',
    h('span', { className: 'grid-tile-icon', 'aria-hidden': 'true' }, categoryIcon(offer.category, 'icon')),
    h('span', { className: 'grid-tile-title' }, offer.title),
    h('span', { className: `grid-badge status-${expired ? 'expired' : offer.status}` }, label)));
}

/** Offres sauvegardées (profil). */
async function loadSavedOffers() {
  ui.savedOffers.setAttribute('aria-busy', 'true');
  if (!ui.savedOffers.childElementCount) ui.savedOffers.replaceChildren(h('div', { className: 'panel-card' }, 'Chargement…'));
  try {
    const data = await api('/api/community/offers?saved=1');
    const items = data.items || [];
    ui.savedCount.textContent = `(${items.length})`;
    window.HaisselMotion ? window.HaisselMotion.setCount(ui.statSaved, items.length) : (ui.statSaved.textContent = String(items.length));
    ui.savedOffers.setAttribute('aria-busy', 'false');
    ui.savedOffers.replaceChildren(...(items.length
      ? items.map((offer) => gridTile(offer))
      : [h('div', { className: 'panel-card mascot-state' }, bear('vide-dodo', 120), h('p', null, 'Aucune offre sauvegardée. Touche le signet d’une offre pour la retrouver ici.'))]));
  } catch (error) {
    if (error.status === 401 || error.status === 403) return;
    ui.savedOffers.setAttribute('aria-busy', 'false');
    ui.savedOffers.replaceChildren(h('div', { className: 'panel-card is-error mascot-state', role: 'alert' }, bear('oups-erreur', 120), `Impossible de charger tes offres sauvegardées : ${error.message}`));
  }
}

async function loadMyOffers() {
  ui.myOffers.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/community/offers/mine');
    state.community.categories = data.categories || state.community.categories;
    fillCategorySelect(ui.pubCategory, state.community.categories, 'Choisir…');
    renderCategoryTiles();
    ui.myOffers.setAttribute('aria-busy', 'false');
    ui.myOffersCount.textContent = `(${data.items.length})`;
    const published = data.items.filter((offer) => offer.status === 'published' && !offer.expired).length;
    // Compte de 0 à la valeur à la première apparition (motion.js).
    if (window.HaisselMotion) window.HaisselMotion.setCount(ui.statPublished, published);
    else ui.statPublished.textContent = String(published);
    ui.myOfferDetail.hidden = true;
    ui.myOffers.replaceChildren(...(data.items.length ? data.items.map(myOfferTile)
      : [h('div', { className: 'panel-card mascot-state' }, bear('vide-dodo', 120), h('p', null, 'Tu n’as encore publié aucune offre. Le parcours MyLead (rubrique Apprendre) t’explique comment obtenir ton lien.'))]));
  } catch (error) {
    if (error.status === 401 || error.status === 403) return;
    ui.myOffers.setAttribute('aria-busy', 'false');
    ui.myOffers.replaceChildren(h('div', { className: 'panel-card is-error mascot-state', role: 'alert' }, bear('oups-erreur', 120), `Impossible de charger tes offres : ${error.message}`));
  }
}

async function handlePublish(event) {
  event.preventDefault();
  clearFieldErrors();
  const values = readPublishForm();
  const problem = checkPublishForm(values);
  if (problem) {
    publishFeedback('error', problem);
    return;
  }
  /*
   * Seule la création est vérifiée côté serveur (POST) : une modification
   * (PATCH) vient d'un membre déjà connu, dont l'offre est déjà passée par la
   * modération. On n'envoie donc le jeton que pour une nouvelle offre.
   */
  if (!state.community.editing && !attachTurnstile(ui.publishForm, values)) {
    publishFeedback('error', 'Valide la vérification anti-robot avant de continuer.');
    return;
  }

  setBusy(ui.publishForm, true);
  try {
    const editing = state.community.editing;
    const data = await api(editing ? `/api/community/offers/${encodeURIComponent(editing)}` : '/api/community/offers', {
      method: editing ? 'PATCH' : 'POST', body: values,
    });
    resetPublishForm();
    resetTurnstile(ui.publishForm);
    publishFeedback('info', data.offer?.status === 'published' ? 'Ton offre est publiée.' : data.message);
    window.HaisselMotion?.toast(editing ? 'Fiche modifiée' : 'Fiche envoyée à l’équipe', { mascot: 'bravo' });
    ui.publishSuccess.focus?.();
    loadMyOffers();
  } catch (error) {
    // Message sous le champ fautif quand le serveur l'indique, sinon en haut.
    if (!showFieldError(error.field, error.message)) {
      publishFeedback('error', error.message);
    } else {
      publishFeedback('', '');
    }
  } finally {
    setBusy(ui.publishForm, false);
  }
}

function renderMyLeadGuide(referral) {
  if (!window.HaisselMyLeadGuide) return;
  window.HaisselMyLeadGuide.render(ui.myleadGuide, {
    referral,
    onOpenTab: setLearnTab,
    onOpenView: setActiveView,
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
      widgetItems(ui.homeLinks, [], 'Liens indisponibles pour le moment.');
      ui.linksList.setAttribute('aria-busy', 'false');
      ui.linksList.replaceChildren(h('div', { className: 'panel-card is-error mascot-state', role: 'alert' }, bear('oups-erreur', 120),
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
    setMessage('error', 'Remplis tous les champs.');
    return;
  }

  const body = { identifier, password };
  if (!attachTurnstile(form, body)) {
    setMessage('error', 'Valide la vérification anti-robot avant de continuer.');
    return;
  }

  setBusy(form, true);
  try {
    setMessage('', '');
    const data = await api('/api/auth/login', { method: 'POST', body });
    ui.loginPassword.value = '';
    resetTurnstile(form);
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

/*
 * Ajoute le jeton anti-robot au corps d'une requête.
 * Retourne false si le widget est actif mais pas encore validé : on affiche
 * alors un message plutôt que d'envoyer une requête qui sera refusée.
 */
function attachTurnstile(form, body) {
  if (!window.HaisselTurnstile || !window.HaisselTurnstile.enabled()) return true;
  const token = window.HaisselTurnstile.tokenFor(form);
  if (!token) return false;
  body.cf_turnstile_response = token;
  return true;
}

/** Un jeton ne sert qu'une fois : le widget est remis à zéro après envoi. */
function resetTurnstile(form) {
  if (window.HaisselTurnstile) window.HaisselTurnstile.reset(form);
}

// ---------------------------------------------------------------------------
// Double authentification (réservée aux administrateurs ; un membre qui l'avait activée peut la désactiver)
// ---------------------------------------------------------------------------

/*
 * Trois écrans successifs, un seul visible à la fois : mot de passe, clé à
 * recopier, puis code de vérification. Les codes de secours s'affichent une
 * seule fois, à la fin.
 *
 * Aucun secret n'est conservé dans l'application : la clé vit dans le DOM le
 * temps de l'opération, et le serveur la garde en attente (chiffrée) jusqu'à
 * la validation du premier code.
 */
const MFA_SCREENS = ['mfa-start-form', 'mfa-secret-step', 'mfa-recovery-step',
  'mfa-active-actions', 'mfa-enable-start', 'mfa-disable-form'];

function showMfaScreens(visible) {
  for (const id of MFA_SCREENS) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible.includes(id));
  }
}

function mfaMessage(kind, text) {
  const error = document.getElementById('mfa-error');
  const info = document.getElementById('mfa-info');
  error.textContent = kind === 'error' ? text : '';
  error.classList.toggle('hidden', kind !== 'error');
  info.textContent = kind === 'info' ? text : '';
  info.classList.toggle('hidden', kind !== 'info');
}

/** État affiché d'après state.user, après chaque changement. */
function renderMfaState() {
  const box = document.getElementById('mfa-box');
  if (!box || !state.user) return;
  const pill = document.getElementById('mfa-state-pill');
  const active = Boolean(state.user.mfa_enabled);
  const isAdmin = String(state.user.role || '').toUpperCase() === 'ADMIN';
  /*
   * Réservée aux administrateurs. Un membre qui l'avait activée avant ne voit
   * que « Désactiver » ; les autres membres ne voient pas le bloc.
   */
  box.hidden = !isAdmin && !active;
  if (box.hidden) return;
  document.getElementById('mfa-member-note').classList.toggle('hidden', isAdmin);

  pill.textContent = active ? 'Activée' : 'Non activée';
  pill.className = active ? 'pill ok' : 'pill';
  document.getElementById('mfa-explain').classList.toggle('hidden', active);
  showMfaScreens(active ? ['mfa-active-actions'] : ['mfa-enable-start']);
  mfaMessage('', '');
}

async function startMfaSetup(event) {
  event.preventDefault();
  const password = document.getElementById('mfa-password').value;
  if (!password) {
    mfaMessage('error', 'Entre ton mot de passe pour continuer.');
    return;
  }
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const data = await api('/api/auth/mfa/setup', { method: 'POST', body: { password } });
    document.getElementById('mfa-password').value = '';
    document.getElementById('mfa-secret').textContent = data.secret;
    showMfaScreens(['mfa-secret-step']);
    mfaMessage('', '');
    document.getElementById('mfa-enable-code').focus();
  } catch (error) {
    mfaMessage('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

async function finishMfaSetup(event) {
  event.preventDefault();
  const input = document.getElementById('mfa-enable-code');
  const code = input.value.replace(/\s/g, '');
  if (code.length !== 6) {
    mfaMessage('error', 'Le code comporte 6 chiffres.');
    input.focus();
    return;
  }
  const form = event.currentTarget;
  setBusy(form, true);
  /*
   * Activer la double authentification change le niveau de sécurité : le
   * serveur révoque toutes les sessions et en ouvre une nouvelle.
   *
   * Le flux temps réel ouvert avec l'ancienne session reçoit alors
   * « session-ended » et vérifie la session ; cette vérification tombait sur
   * un 401 avant que le nouveau cookie soit pris en compte, et déconnectait
   * le membre au moment précis où il venait de sécuriser son compte.
   * On ferme donc le canal avant l'opération, et on le rouvre après.
   */
  if (notificationCenter) notificationCenter.stop();
  try {
    const data = await api('/api/auth/mfa/enable', { method: 'POST', body: { code } });
    input.value = '';
    document.getElementById('mfa-secret').textContent = '';
    if (state.user) state.user.mfa_enabled = true;

    /*
     * Pastille mise à jour tout de suite : sans cela, l'écran des codes de
     * secours affichait encore « Non activée » juste sous le message
     * d'activation réussie.
     */
    const pill = document.getElementById('mfa-state-pill');
    pill.textContent = 'Activée';
    pill.className = 'pill ok';
    document.getElementById('mfa-explain').classList.add('hidden');

    const list = document.getElementById('mfa-codes');
    list.replaceChildren(...(data.recovery_codes || []).map((c) => h('li', null, c)));
    showMfaScreens(['mfa-recovery-step']);
    mfaMessage('info', 'Double authentification activée.');
  } catch (error) {
    mfaMessage('error', error.message);
  } finally {
    setBusy(form, false);
    // Canal temps réel rouvert avec la session renouvelée.
    if (notificationCenter) notificationCenter.start();
  }
}

/*
 * Désactivation : le serveur exige le mot de passe ET un code valide, pour
 * qu'un téléphone laissé déverrouillé ne suffise pas à retirer la protection.
 */
async function disableMfa(event) {
  event.preventDefault();
  const password = document.getElementById('mfa-disable-password').value;
  const code = document.getElementById('mfa-disable-code').value.replace(/\s/g, '');
  if (!password || code.length !== 6) {
    mfaMessage('error', 'Entre ton mot de passe et le code à 6 chiffres.');
    return;
  }
  const form = event.currentTarget;
  setBusy(form, true);
  // Même précaution qu'à l'activation : la désactivation change aussi le
  // niveau de sécurité du compte.
  if (notificationCenter) notificationCenter.stop();
  try {
    await api('/api/auth/mfa/disable', { method: 'POST', body: { password, code } });
    document.getElementById('mfa-disable-password').value = '';
    document.getElementById('mfa-disable-code').value = '';
    if (state.user) state.user.mfa_enabled = false;
    renderMfaState();
    mfaMessage('info', 'Double authentification désactivée. Ton compte n’est plus protégé que par son mot de passe.');
  } catch (error) {
    mfaMessage('error', error.message);
  } finally {
    setBusy(form, false);
    if (notificationCenter) notificationCenter.start();
  }
}

/** Copie dans le presse-papiers, avec repli si l'API est indisponible. */
async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    mfaMessage('info', okMessage);
  } catch (error) {
    mfaMessage('error', 'Copie impossible sur ce navigateur : sélectionne le texte à la main.');
  }
}

function wireMfa() {
  const box = document.getElementById('mfa-box');
  if (!box) return;
  document.getElementById('mfa-enable-start').addEventListener('click', () => {
    showMfaScreens(['mfa-start-form']);
    mfaMessage('', '');
    document.getElementById('mfa-password').focus();
  });
  document.getElementById('mfa-start-form').addEventListener('submit', startMfaSetup);
  document.getElementById('mfa-enable-form').addEventListener('submit', finishMfaSetup);
  document.getElementById('mfa-cancel').addEventListener('click', renderMfaState);
  document.getElementById('mfa-disable').addEventListener('click', () => {
    showMfaScreens(['mfa-disable-form']);
    mfaMessage('', '');
    document.getElementById('mfa-disable-password').focus();
  });
  document.getElementById('mfa-disable-form').addEventListener('submit', disableMfa);
  document.getElementById('mfa-disable-cancel').addEventListener('click', renderMfaState);
  document.getElementById('mfa-codes-done').addEventListener('click', renderMfaState);
  document.getElementById('mfa-copy').addEventListener('click', () => {
    copyText(document.getElementById('mfa-secret').textContent, 'Clé copiée.');
  });
  document.getElementById('mfa-codes-copy').addEventListener('click', () => {
    const codes = [...document.querySelectorAll('#mfa-codes li')].map((li) => li.textContent).join('\n');
    copyText(codes, 'Codes copiés. Range-les en lieu sûr.');
  });
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

  /*
   * Majorité : traitée à part des champs texte, car « non » est une réponse
   * valide dont la valeur est « false ». La ranger dans le test ci-dessus la
   * ferait passer pour un champ vide.
   */
  const ageError = document.getElementById('err-register-adult');
  const choice = document.querySelector('input[name="register-adult"]:checked');
  ageError.classList.add('hidden');
  if (!choice) {
    ageError.textContent = 'Indique si tu as 18 ans ou plus : la réponse est obligatoire.';
    ageError.classList.remove('hidden');
    document.getElementById('register-adult-yes').focus();
    return;
  }
  body.is_adult = choice.value === 'yes';

  // Condition d'âge de l'inscription (15 ans ou accord d'un parent) : case obligatoire.
  const termsBox = document.getElementById('register-age-terms');
  const termsError = document.getElementById('err-register-age-terms');
  termsError.classList.add('hidden');
  if (!termsBox.checked) {
    termsError.textContent = 'Coche la case pour confirmer que tu as 15 ans ou plus, ou l’accord d’un parent.';
    termsError.classList.remove('hidden');
    termsBox.focus();
    return;
  }
  body.age_terms_accepted = true;

  if (!attachTurnstile(form, body)) {
    setMessage('error', 'Valide la vérification anti-robot avant de continuer.');
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
    resetTurnstile(form);
    if (data.verification_required) {
      showAuthForm('login-form');
      setMessage('info', 'Compte presque prêt : ouvre le lien envoyé à ton adresse e-mail pour l’activer, puis connecte-toi.');
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
    setMessage('error', 'Indique ton adresse e-mail.');
    return;
  }

  const body = { email };
  if (!attachTurnstile(form, body)) {
    setMessage('error', 'Valide la vérification anti-robot avant de continuer.');
    return;
  }

  setBusy(form, true);
  try {
    const data = await api('/api/auth/password/forgot', { method: 'POST', body });
    form.reset();
    resetTurnstile(form);
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
    feedback('info', 'Mot de passe modifié. Tes autres sessions ont été fermées.');
  } catch (error) {
    feedback('error', error.message);
  } finally {
    setBusy(form, false);
  }
}

/* Écran « À bientôt » : 1,5 s après la déconnexion, puis la page de connexion. */
const GOODBYE_MS = 1500;

function sayGoodbye() {
  const screen = h('div', { className: 'goodbye-screen', role: 'status' }, bear('au-revoir', 160), h('p', null, 'À bientôt !'));
  document.body.append(screen);
  return new Promise((resolve) => {
    window.setTimeout(() => {
      screen.classList.add('is-leaving');
      window.setTimeout(() => { screen.remove(); resolve(); }, 220);
    }, GOODBYE_MS);
  });
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
  await sayGoodbye();
}

/*
 * Première ouverture après l'inscription (compte de moins de 7 jours, jamais
 * accueilli sur cet appareil) : toast « Bienvenue » avec l'ours.
 */
const WELCOME_KEY = 'haissel-welcomed';

function welcomeNewMember(user) {
  if (storageGet(WELCOME_KEY)) return;
  storageSet(WELCOME_KEY, '1');
  const created = Date.parse(user.created_at || '');
  if (!created || Date.now() - created > 7 * 24 * 3600 * 1000) return;
  window.HaisselMotion?.toast(`Bienvenue sur HAISSEL, ${user.display_name || user.username} !`, { mascot: 'bienvenue', duration: 4000 });
}

/* Hors ligne : bandeau avec l'ours tant que navigator.onLine est faux. */
function watchOnline() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const paint = () => { banner.hidden = navigator.onLine !== false; };
  window.addEventListener('online', paint);
  window.addEventListener('offline', paint);
  paint();
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
  setMessage('info', 'Toutes tes sessions ont été fermées.');
}

async function handleDeleteAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = document.getElementById('delete-account-error');
  const password = document.getElementById('delete-account-password').value;
  const confirm = document.getElementById('delete-account-confirm').value.trim();
  errorBox.classList.add('hidden');
  if (confirm !== 'SUPPRIMER') {
    errorBox.textContent = 'Tape SUPPRIMER pour confirmer.';
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
    setMessage('info', 'Ton compte et tes données ont été supprimés.');
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
  const aboutYear = document.getElementById('about-year');
  if (aboutYear) aboutYear.textContent = String(new Date().getFullYear());
  try {
    state.config = await api('/api/auth/config');
  } catch (error) { /* valeurs par défaut */ }

  /*
   * Widget anti-robot. Seule la clé PUBLIQUE arrive ici ; la clé secrète ne
   * quitte jamais le serveur. Sans clé configurée, init() ne fait rien et les
   * emplacements restent masqués.
   */
  if (window.HaisselTurnstile) {
    window.HaisselTurnstile.init(state.config.turnstile_site_key);
  }

  showLoggedOut();
  showAuthForm('login-form');
  if (await handleEmailLinks()) {
    bootReady();
    return;
  }

  try {
    const data = await api('/api/auth/me');
    if (data.mfa_pending) {
      showAuthForm('mfa-form');
      bootReady();
      return;
    }
    // Connecté : l'écran part à la fin de loadCommunity().
    showLoggedIn(data.user);
  } catch (error) {
    if (error.status !== 401) setMessage('error', error.message);
    bootReady();
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
    profileAvatar: 'profile-avatar', linksList: 'links-list',
    profileLogout: 'profile-logout', forgotLink: 'forgot-link', forgotEmail: 'forgot-email',
    resetPassword: 'reset-password', resetConfirmPassword: 'reset-confirm-password',
    mfaCode: 'mfa-code', mfaRecovery: 'mfa-recovery', mfaRecoveryField: 'mfa-recovery-field',
    mfaCodeField: 'mfa-code-field', mfaToggleRecovery: 'mfa-toggle-recovery',
    learnGuidesList: 'learn-guides-list', learnTutorialsList: 'learn-tutorials-list',
    learnOpportunitiesList: 'learn-opportunities-list', oppAge: 'opp-age', oppCountry: 'opp-country',
    referralRate: 'referral-rate', referralAge: 'referral-age', referralBox: 'referral-box',
    homeName: 'home-name', homeUsername: 'home-username', homeCreated: 'home-created',
    homeLinks: 'home-links', homeLearn: 'home-learn',
    homeOffers: 'home-offers', navMessagesBadge: 'nav-messages-badge', chatSend: 'chat-send', teamThread: 'team-thread', chatMessages: 'chat-messages', chatError: 'chat-error', chatForm: 'chat-form', chatInput: 'chat-input', chatNew: 'chat-new', navAvatar: 'nav-avatar', discoverFeed: 'discover-feed', homeStories: 'home-stories', topbarAvatar: 'topbar-avatar', offerDetail: 'offer-detail',
    homeLearnCard: 'home-learn-card', homeLearnStep: 'home-learn-step',
    homeLearnText: 'home-learn-text', homeLearnGo: 'home-learn-go',
    communityList: 'community-list', communityQ: 'community-q', communityCategory: 'community-category',
    communityKind: 'community-kind', communitySort: 'community-sort', communitySaved: 'community-saved', communityFilters: 'community-filters',
    communityQClear: 'community-q-clear', bellButton: 'bell-button', bellBadge: 'bell-badge', activityList: 'activity-list', notifSwitch: 'notif-switch', notifHelp: 'notif-help', notifHowto: 'notif-howto', howtoSheet: 'howto-sheet', installRow: 'install-row', installRowLabel: 'install-row-label', installSheet: 'install-sheet', installSheetTitle: 'install-sheet-title', installSheetText: 'install-sheet-text', installSheetStatus: 'install-sheet-status', installSheetAction: 'install-sheet-action', installBanner: 'install-banner', installBannerText: 'install-banner-text', installBannerAction: 'install-banner-action', installBannerClose: 'install-banner-close', filtersOpen: 'filters-open', filtersCount: 'filters-count', filtersSheet: 'filters-sheet',
    leaveDialog: 'leave-dialog', leaveDomain: 'leave-domain', leaveAge: 'leave-age',
    reportDialog: 'report-dialog', reportForm: 'report-form', reportOffer: 'report-offer', reportError: 'report-error',
    reportReason: 'report-reason', reportDetails: 'report-details',
    pubCampaignName: 'pub-campaign-name', pubTips: 'pub-tips',
    memberDialog: 'member-dialog', memberTitle: 'member-title', memberMeta: 'member-meta', memberOffers: 'member-offers',
    publishForm: 'publish-form', publishFormTitle: 'publish-form-title', publishError: 'publish-error',
    publishSuccess: 'publish-success', publishPreview: 'publish-preview', publishPreviewCard: 'publish-preview-card',
    pubTitle: 'pub-title', pubUrl: 'pub-url', pubDescription: 'pub-description', pubCategory: 'pub-category',
    pubCountryChips: 'pub-country-chips', pubCountryMore: 'pub-country-more', pubCountriesGroup: 'pub-countries-group',
    pubActionChips: 'pub-action-chips', pubActionOther: 'pub-action-other', pubActionOtherField: 'pub-action-other-field',
    pubActionGroup: 'pub-action-group', pubAgeChips: 'pub-age-chips', pubAgeGroup: 'pub-age-group',
    pubConditionChips: 'pub-condition-chips', pubConditionsOther: 'pub-conditions-other',
    pubConditionsOtherField: 'pub-conditions-other-field', pubConditionsCount: 'pub-conditions-count',
    pubConditionsGroup: 'pub-conditions-group', pubRights: 'pub-rights', pubCancelEdit: 'pub-cancel-edit',
    myOffers: 'my-offers', myleadGuide: 'mylead-guide',
    pubCategoryTiles: 'pub-category-tiles', pubTitleCount: 'pub-title-count',
    myOffersFeedback: 'my-offers-feedback', myOfferDetail: 'my-offer-detail', statPublished: 'stat-published', statSaved: 'stat-saved', myOffersCount: 'my-offers-count', savedOffers: 'saved-offers', savedCount: 'saved-count',
    passwordFeedback: 'password-feedback', passwordError: 'password-error', logoutAllButton: 'logout-all-button',
  };
  for (const [key, id] of Object.entries(ids)) ui[key] = document.getElementById(id);
  ui.authTabs = document.querySelector('.auth-tabs');

  notificationCenter = window.createNotificationCenter({
    post: (url, body) => api(url, { method: 'POST', body }),
    // Appareil abonné au Web Push : pas de doublon affiché par la page.
    hasPushSubscription: async () => Boolean(await window.HaisselPush.current(navigator)),
    get: (url) => api(url),
    /*
     * « sse » en local et sous Docker, « poll » sur Vercel. Fonction et non
     * valeur : la configuration est chargée dans init(), après ce câblage.
     */
    mode: () => state.config?.realtime_mode,
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
    // Annonce de l'équipe reçue : Activité et pastille à jour.
    onNotification: () => { loadActivity(); },
    onSessionEnded: () => {
      if (!state.user) return;
      state.csrf = '';
      showLoggedOut();
      showAuthForm('login-form');
      setMessage('error', 'Ta session a pris fin. Reconnecte-toi.');
    },
  });

  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => showAuthForm(`${button.dataset.form}-form`));
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    // View Transitions si disponibles (motion.js), sinon fondu et glissement en CSS.
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      if (window.HaisselMotion) window.HaisselMotion.navigate(view, () => setActiveView(view));
      else setActiveView(view);
    });
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
  wireMfa();
  document.getElementById('age-gate-yes').addEventListener('click', () => answerAgeGate(true));
  document.getElementById('age-gate-no').addEventListener('click', () => answerAgeGate(false));
  document.querySelectorAll('[data-goto]').forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.goto));
  });
  document.querySelectorAll('.learn-tab').forEach((tab) => {
    tab.addEventListener('click', () => setLearnTab(tab.dataset.learnTab));
  });
  // Bandeau « Apprendre » retiré de l'accueil pour l'instant (renderHomeLearnCard ne fait rien sans lui).
  ui.oppAge.addEventListener('input', renderOpportunities);
  ui.oppCountry.addEventListener('input', renderOpportunities);

  // Offres de la communauté
  // Filtres : on recharge ET on reporte l'état dans l'adresse de la page.
  ui.communityFilters.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(communityTimer);
    ui.communityQ.blur();
    runSearch();
  });
  // Recherche pendant la frappe (250 ms après la dernière touche).
  ui.communityQ.addEventListener('input', () => { paintSearchControls(); scheduleCommunityLoad(); });
  ui.communityQClear.addEventListener('click', () => {
    ui.communityQ.value = '';
    clearTimeout(communityTimer);
    runSearch();
    ui.communityQ.focus({ preventScroll: true });
  });
  ui.filtersOpen.addEventListener('click', openFilters);
  document.getElementById('filters-apply').addEventListener('click', () => closeSheet(ui.filtersSheet, { apply: true }));
  document.getElementById('filters-reset').addEventListener('click', () => setFilterFields({}));
  bindFiltersSheet();
  // Réglages : notifications sur cet appareil.
  bindSheet(ui.howtoSheet, {
    onClose: () => {
      markInstallTutoSeen();
      if (!ui.notifHowto.hidden) ui.notifHowto.focus({ preventScroll: true });
    },
  });
  ui.notifHowto.addEventListener('click', openHowto);
  // Tirer pour rafraîchir : Accueil, tout en haut de page, aucune feuille ni story ouverte.
  window.HaisselMotion?.pullToRefresh({
    isActive: () => Boolean(state.user) && document.body.dataset.view === 'home'
      && !document.querySelector('dialog[open]') && !document.body.classList.contains('story-open'),
    onRefresh: () => loadCommunity(),
  });
  /*
   * Feuilles d'installation rangées dans la vue Profil : rattachées au <body>
   * pour s'afficher aussi quand le tuto s'ouvre tout seul depuis une autre vue
   * (un ancêtre masqué cacherait même une fenêtre modale).
   */
  document.body.append(ui.howtoSheet, ui.installSheet);
  tuto = window.HaisselTuto.mount({
    track: document.getElementById('tuto-track'),
    dots: document.getElementById('tuto-dots'),
    next: document.getElementById('tuto-next'),
    prev: document.getElementById('tuto-prev'),
    caption: document.getElementById('tuto-caption'),
    onDone: () => closeSheet(ui.howtoSheet),
  });
  ui.installRow.addEventListener('click', () => openInstallGuide(window.HaisselInstall.tutoKind(installState()) || 'ios'));
  ui.installSheetAction.addEventListener('click', handleInstallSheetAction);
  bindSheet(ui.installSheet, { onClose: markInstallTutoSeen });
  ui.installBannerAction.addEventListener('click', handleInstallBannerAction);
  ui.installBannerClose.addEventListener('click', closeInstallBanner);
  window.addEventListener('haissel-install-change', () => {
    if (!state.user) return;
    renderInstallUi();
    // Android : l'invite peut arriver après la connexion.
    scheduleAutoTuto();
  });
  ui.notifSwitch.addEventListener('change', handleNotifSwitch);
  document.getElementById('profile-public-switch').addEventListener('change', handleProfileVisibility);
  window.addEventListener('hashchange', openViewFromHash);
  // Retour sur l'application (réglages du téléphone modifiés entre-temps).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.user) renderNotifSetting(); });
  // Filtres présents dans l'adresse (lien partagé, favori, retour arrière).
  readFiltersFromUrl();
  ui.reportForm.addEventListener('submit', handleReport);
  // Messages
  bindMessages();
  watchOnline();
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(button.closest('dialog')));
  });
  // Bouton « retour » du téléphone : ferme le détail d'une offre.
  window.addEventListener('popstate', () => {
    if (!document.getElementById('offer-view').classList.contains('hidden')) closeOffer();
  });
  document.querySelectorAll('.profile-tab').forEach((tab) => {
    tab.addEventListener('click', () => setProfileTab(tab.dataset.profileTab));
  });
  document.querySelectorAll('[data-profile-open]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.profileOpen === 'settings') renderNotifSetting();
      setProfileTab(button.dataset.profileOpen);
      document.getElementById(`ppanel-${button.dataset.profileOpen}`).scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  });
  document.getElementById('publish-my-offers').addEventListener('click', () => {
    setActiveView('profile');
    setProfileTab('offers');
  });
  document.getElementById('profile-saved').addEventListener('click', () => {
    ui.communitySaved.checked = true;
    paintSearchControls();
    state.community.loaded = false;
    setActiveView('links');
  });

  // Publier
  ui.publishForm.addEventListener('submit', handlePublish);
  ui.publishForm.addEventListener('input', () => { updateTitleCount(); syncOtherFields(); updatePublishPreview(); });
  renderPublishChoices();
  ui.pubCountryMore.addEventListener('change', () => {
    if (!ui.pubCountryMore.value) return;
    addCountryChip(ui.pubCountryMore.value);
    ui.pubCountryMore.value = '';
    updatePublishPreview();
  });
  updatePublishPreview();
  ui.pubCancelEdit.addEventListener('click', () => { resetPublishForm(); publishFeedback('', ''); });
  renderMyLeadGuide({ available: false });
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
