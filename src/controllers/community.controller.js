const { pool, withTransaction } = require('../config/database');
const { sendError, parseId, parsePagination } = require('../utils/http');
const { logger } = require('../utils/logger');
const push = require('../services/push.service');
const { refusalForAffiliateLink, meetsMinAge, isAdult } = require('../services/adult.service');
const { FORBIDDEN_CLAIMS } = require('./learn.controller');
const { isAffiliateTrackingUrl, AFFILIATE_LINK_MESSAGE } = require('../utils/affiliate-tracking');

/*
 * Offres publiées par les membres.
 *
 * Toutes les routes exigent une session. Règles :
 *  - un membre ne modifie ou ne retire QUE ses propres offres ;
 *  - deux sortes d'offres (colonne kind, fixée à la création) :
 *      · « campaign » : fiche campagne d'un membre majeur (page officielle,
 *        conseils, conditions) ; un lien de suivi affilié y est refusé ;
 *      · « affiliate » : lien affilié, réservé aux comptes ADMIN ;
 *  - toute offre (création ou modification) passe en modération (pending) ;
 *  - seules les offres « published » sont visibles des autres membres ;
 *  - liens : HTTPS uniquement, vrai nom de domaine, sans identifiants ;
 *    le texte est stocké tel quel et affiché comme texte (jamais du HTML) ;
 *  - thèmes sensibles (jeux d'argent, crypto, crédit, rencontres, adulte…)
 *    refusés ; promesses de gains refusées ;
 *  - limites anti-spam en base (par jour, en attente, doublons) ;
 *  - aucune donnée MyLead (identifiant, mot de passe, cookie) n'est demandée.
 */

/*
 * Catégories : table offer_categories (migration 20261020_0009), administrable
 * depuis la console. Cette liste ne sert plus que de repli si la table n'est
 * pas encore migrée — un formulaire sans catégorie serait inutilisable.
 */
const FALLBACK_CATEGORIES = {
  applications: 'Applications',
  jeux: 'Jeux mobiles',
  shopping: 'Shopping',
  services: 'Services en ligne',
  education: 'Éducation',
  sondages: 'Sondages et avis',
  autre: 'Autre',
};

/*
 * Libellés en mémoire, rafraîchis par loadCategories(). formatOffer en a
 * besoin de façon synchrone ; les routes de lecture appellent loadCategories()
 * avant de formater, donc le cache est toujours chaud quand il sert.
 *
 * Ce cache contient AUSSI les catégories désactivées : une offre publiée sous
 * une catégorie retirée depuis doit continuer d'afficher son libellé.
 */
let categoryLabels = { ...FALLBACK_CATEGORIES };
let categoryCache = null;
const CATEGORY_TTL_MS = 60_000;

/**
 * @returns {Promise<{ active: Object, labels: Object }>}
 * « active » : proposées dans les formulaires. « labels » : toutes, pour
 * l'affichage.
 */
async function loadCategories({ force = false } = {}) {
  if (!force && categoryCache && Date.now() - categoryCache.at < CATEGORY_TTL_MS) {
    return categoryCache.value;
  }
  try {
    const { rows } = await pool.query(
      'SELECT slug, label, is_active FROM offer_categories ORDER BY position, label'
    );
    if (rows.length === 0) throw new Error('aucune catégorie en base');

    const active = {};
    const labels = {};
    for (const row of rows) {
      labels[row.slug] = row.label;
      if (row.is_active) active[row.slug] = row.label;
    }
    categoryLabels = labels;
    categoryCache = { at: Date.now(), value: { active, labels } };
  } catch (error) {
    // Table absente ou base injoignable : on repart du repli, sans planter.
    logger.warn('Catégories indisponibles, repli sur la liste intégrée', { error: error.message });
    categoryLabels = { ...FALLBACK_CATEGORIES };
    categoryCache = { at: Date.now(), value: { active: { ...FALLBACK_CATEGORIES }, labels: { ...FALLBACK_CATEGORIES } } };
  }
  return categoryCache.value;
}

/** À appeler après toute écriture administrative sur les catégories. */
function invalidateCategories() {
  categoryCache = null;
}

const REPORT_REASONS = ['misleading', 'spam', 'dangerous', 'minors', 'rights', 'signup_exchange', 'other'];

const LIMITS = {
  offersPerDay: 5,
  pendingPerUser: 10,
  reportsPerDay: 20,
  reportsToHide: 3,
};

/*
 * Raccourcisseurs d'URL : refusés. Un lien raccourci cache sa destination
 * réelle, donc ni le membre qui clique ni l'équipe qui modère ne peuvent voir
 * où il mène ; la cible peut en plus être changée après la vérification.
 * Un lien d'affiliation MyLead n'a jamais besoin d'être raccourci.
 */
const URL_SHORTENERS = new Set([
  'bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd',
  'buff.ly', 'cutt.ly', 'rb.gy', 'shorturl.at', 's.id', 'lnkd.in', 't.me',
  'rebrand.ly', 'tiny.cc', 'shorte.st', 'adf.ly', 'bl.ink', 'short.io',
  'urlz.fr', 'lc.cx', 'qrco.de', 'trib.al', 'db.tt', 'soo.gd', 'clck.ru',
]);

// Thèmes incompatibles avec un public jeune : refusés quelle que soit la catégorie.
const SENSITIVE_TOPICS = /\b(casinos?|paris?\s+sportifs?|paris?\s+en\s+ligne|betting|poker|loteries?|crypto\w*|bitcoin|forex|trading|rencontres?|dating|adultes?|porno\w*|xxx|sexe|escort\w*|prêts?|crédits?\s+(conso\w*|rapide|immédiat)|rachat\s+de\s+crédit|cbd|vapes?|tabac|alcool)\b/i;

/*
 * « field » : nom du champ concerné (title, url, description, category,
 * countries, expected_action, payout_text, min_age, conditions,
 * rights_confirmed). Il remonte jusqu'au navigateur, qui affiche le message
 * sous le champ au lieu d'un bloc d'erreur en haut du formulaire.
 */
class ValidationError extends Error {
  constructor(code, message, status = 400, field = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

/**
 * Lien fourni par un membre : donnée non fiable.
 * Retourne l'URL normalisée, ou lève une ValidationError.
 */
function normalizeMemberUrl(value) {
  const bad = (message) => new ValidationError('INVALID_URL', message, 400, 'url');

  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw bad('Indique un lien valide (2000 caractères maximum).');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw bad('Ce lien n’est pas une adresse web valide. Il doit commencer par https://');
  }
  const host = url.hostname.toLowerCase();

  /*
   * Le contrôle du protocole couvre à lui seul javascript:, data: et file: —
   * seul « https: » passe. Le http: simple est refusé ici aussi.
   */
  if (url.protocol !== 'https:') {
    throw bad('Seuls les liens sécurisés commençant par « https:// » sont acceptés.');
  }
  if (url.username || url.password) {
    throw bad('Le lien ne doit pas contenir d’identifiant ni de mot de passe (la partie avant le « @ »).');
  }
  if (url.port && url.port !== '443') {
    throw bad('Le lien ne doit pas utiliser de port particulier.');
  }
  /*
   * Toute adresse IP littérale est refusée, v4 comme v6 : cela écarte d'un
   * coup les plages privées (192.168.x, 10.x, 172.16-31.x, 127.x, 169.254.x)
   * sans avoir à les énumérer. Un nom d'hôte sans point, ou en .localhost,
   * .local, .internal, .lan, .home, .arpa, est refusé de la même façon.
   */
  if (!host.includes('.') || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) {
    throw bad('Le lien doit pointer vers un vrai nom de domaine public (pas une adresse IP ni un nom local).');
  }
  if (URL_SHORTENERS.has(host) || URL_SHORTENERS.has(host.replace(/^www\./, ''))) {
    throw bad('Les liens raccourcis ne sont pas acceptés : donne le lien complet, pour qu’on voie où il mène.');
  }
  return url.href;
}

function text(body, name, label, { min = 0, max, required = false }) {
  const raw = body[name];
  const bad = (code, message) => new ValidationError(code, message, 400, name);

  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw bad('INVALID_FIELD', `Le champ « ${label} » est obligatoire.`);
    return null;
  }
  if (typeof raw !== 'string') throw bad('INVALID_FIELD', `« ${label} » doit être un texte.`);
  const value = raw.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (value.length < min || value.length > max) {
    throw bad('INVALID_FIELD', `« ${label} » doit contenir entre ${min} et ${max} caractères : il en compte ${value.length}.`);
  }
  if (FORBIDDEN_CLAIMS.test(value)) {
    throw bad('MISLEADING_CLAIM', `« ${label} » contient une promesse de gain : aucun gain n'est garanti, il faut reformuler.`);
  }
  return value;
}

/*
 * « kind » : 'campaign' (fiche campagne, membre) ou 'affiliate' (lien affilié,
 * ADMIN). Une fiche campagne exige le nom de la campagne et refuse tout lien
 * qui ressemble à un lien de suivi affilié.
 */
function validateOffer(body, activeCategories, kind = 'campaign') {
  const source = body && typeof body === 'object' ? body : {};
  const campaign = kind === 'campaign';
  const offer = {
    title: text(source, 'title', 'Titre', { min: 5, max: 120, required: true }),
    url: normalizeMemberUrl(source.url),
    description: text(source, 'description', 'Description', { min: 20, max: 1500, required: true }),
    countries: text(source, 'countries', 'Pays concernés', { min: 2, max: 200, required: true }),
    expected_action: text(source, 'expected_action', 'Action attendue', { min: 5, max: 300, required: true }),
    payout_text: text(source, 'payout_text', 'Rémunération annoncée', { max: 160 }),
    conditions: text(source, 'conditions', 'Conditions et restrictions', { max: 2000 }),
    campaign_name: text(source, 'campaign_name', 'Nom de la campagne MyLead', { min: 2, max: 120, required: campaign }),
    tips: text(source, 'tips', 'Mes conseils', { max: 1500 }),
  };

  if (campaign && isAffiliateTrackingUrl(offer.url)) {
    throw new ValidationError('AFFILIATE_LINK_FORBIDDEN', AFFILIATE_LINK_MESSAGE, 400, 'url');
  }

  // Seule une catégorie ACTIVE peut être choisie : une catégorie désactivée
  // reste affichée sur les offres existantes mais n'est plus proposable.
  if (!Object.prototype.hasOwnProperty.call(activeCategories, source.category)) {
    throw new ValidationError('INVALID_FIELD', 'Choisis une catégorie dans la liste.', 400, 'category');
  }
  offer.category = source.category;

  if (source.min_age === undefined || source.min_age === null || source.min_age === '') {
    offer.min_age = null;
  } else if (Number.isInteger(source.min_age) && source.min_age >= 10 && source.min_age <= 99) {
    offer.min_age = source.min_age;
  } else {
    throw new ValidationError('INVALID_FIELD', 'L’âge minimum doit être un nombre entre 10 et 99.', 400, 'min_age');
  }

  if (source.rights_confirmed !== true) {
    throw new ValidationError('RIGHTS_NOT_CONFIRMED', campaign
      ? 'Coche la case : le lien doit mener à la page officielle et ta fiche doit respecter les conditions de la campagne.'
      : 'Coche la case : le lien doit venir de ton propre compte éditeur et respecter les conditions de la campagne.',
    400, 'rights_confirmed');
  }

  const haystack = [offer.title, offer.description, offer.conditions, offer.expected_action, offer.url,
    offer.campaign_name, offer.tips].join(' ');
  if (SENSITIVE_TOPICS.test(haystack)) {
    throw new ValidationError('FORBIDDEN_TOPIC',
      'Ce type d’offre (jeux d’argent, crypto, crédit, rencontres, contenus pour adultes, tabac, alcool…) n’est pas accepté sur HAISSEL.',
      400, 'description');
  }
  return offer;
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return '';
  }
}

/*
 * « viewer » est le membre qui regarde (req.user). L'URL de destination n'est
 * transmise au navigateur QUE s'il a le droit de l'ouvrir : un mineur ne doit
 * pas recevoir l'adresse d'un lien affilié, même masquée dans l'interface.
 * Le domaine reste visible : il sert à juger l'offre, pas à l'ouvrir.
 *
 * L'auteur voit toujours l'URL de sa propre offre, sinon il ne pourrait plus
 * la relire ni la corriger.
 */
/*
 * Fiches campagne au format « story » : visibles STORY_HOURS heures à partir
 * de leur publication (validation par la modération) ou de leur
 * republication. Les offres ADMIN (kind = 'affiliate') ont expires_at NULL.
 */
const STORY_HOURS = 24;
const RENEW_COOLDOWN_HOURS = 20;
const NOT_EXPIRED = '(o.expires_at IS NULL OR o.expires_at > NOW())';

function isExpired(row) {
  return Boolean(row.expires_at) && new Date(row.expires_at).getTime() <= Date.now();
}

function formatOffer(row, userId, viewer = null) {
  const mine = row.user_id === userId;
  /*
   * Dérogation d'auteur : elle ne vaut QUE pour un majeur, et ne sert qu'à
   * relire sa propre offre malgré un âge minimum que HAISSEL ne peut pas
   * certifier. Un mineur n'ouvre aucun lien affilié, pas même le sien.
   */
  const expired = isExpired(row);
  const canOpen = !viewer
    || (mine && isAdult(viewer))
    || (!expired && refusalForAffiliateLink(viewer, row.min_age) === null);
  return {
    id: row.id,
    kind: row.kind || 'campaign',
    title: row.title,
    campaign_name: row.campaign_name || null,
    tips: row.tips || null,
    url: canOpen ? row.url : null,
    can_open: canOpen,
    domain: domainOf(row.url),
    description: row.description,
    category: row.category,
    category_label: categoryLabels[row.category] || row.category,
    countries: row.countries,
    expected_action: row.expected_action,
    payout_text: row.payout_text,
    min_age: row.min_age,
    conditions: row.conditions,
    status: row.status,
    published_at: row.published_at,
    renewed_at: row.renewed_at || null,
    expires_at: row.expires_at || null,
    expired,
    // Date de mise en avant dans le fil : publication ou republication.
    shown_at: row.renewed_at && row.renewed_at > row.published_at ? row.renewed_at : row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author: { username: row.author_username },
    is_mine: row.user_id === userId,
    saved: Boolean(row.saved),
    ...(row.user_id === userId ? { moderation_note: row.moderation_note } : {}),
  };
}

function handleError(error, res, next) {
  if (error instanceof ValidationError) {
    return sendError(res, error.status, error.code, error.message, error.field ? { field: error.field } : null);
  }
  return next(error);
}

const OFFER_SELECT = `
  SELECT o.*, u.username AS author_username,
         EXISTS (SELECT 1 FROM member_offer_saves s WHERE s.offer_id = o.id AND s.user_id = $1) AS saved
  FROM member_offers o
  JOIN users u ON u.id = o.user_id`;

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

async function listOffers(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query, 50);
    // Chargées d'abord : elles servent au filtre ET aux libellés des cartes.
    const { active, labels } = await loadCategories();
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    // Le filtre accepte aussi une catégorie désactivée : un lien de recherche
    // déjà partagé doit continuer de fonctionner.
    const category = typeof req.query.category === 'string' && labels[req.query.category] ? req.query.category : null;
    const country = typeof req.query.country === 'string' && /^[A-Za-z]{2}$/.test(req.query.country) ? req.query.country.toUpperCase() : null;
    const author = typeof req.query.author === 'string' && /^[a-z0-9_.-]{1,50}$/i.test(req.query.author) ? req.query.author.toLowerCase() : null;
    const savedOnly = req.query.saved === '1';
    // Filtres de la feuille « Filtres » : valeurs en liste blanche, sinon ignorées.
    const kind = req.query.kind === 'campaign' || req.query.kind === 'affiliate' ? req.query.kind : null;
    // « Plus populaires » : nombre de sauvegardes, seul signal stocké ; à égalité, les plus récentes.
    const order = req.query.sort === 'popular'
      ? '(SELECT COUNT(*) FROM member_offer_saves s WHERE s.offer_id = o.id) DESC, '
      : '';

    const result = await pool.query(
      `${OFFER_SELECT}
       WHERE o.status = 'published' AND u.is_active AND NOT u.is_banned
         AND ($2::text = '' OR o.title ILIKE '%' || $2 || '%' OR o.description ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR o.category = $3)
         AND ($4::text IS NULL OR upper(o.countries) ~ ('(^|[^A-Z])(' || $4 || '|MONDE|TOUS)([^A-Z]|$)'))
         AND ($5::text IS NULL OR u.username = $5)
         AND (NOT $6::boolean OR EXISTS (SELECT 1 FROM member_offer_saves s WHERE s.offer_id = o.id AND s.user_id = $1))
         -- Fiche expirée : absente du fil et de la recherche, mais gardée
         -- (grisée) dans « Sauvegardées ».
         AND ($6::boolean OR ${NOT_EXPIRED})
         AND ($9::text IS NULL OR COALESCE(o.kind, 'campaign') = $9)
       ORDER BY ${order}GREATEST(o.published_at, COALESCE(o.renewed_at, o.published_at)) DESC, o.id DESC
       LIMIT $7 OFFSET $8`,
      [req.user.id, q.replace(/[\\%_]/g, (c) => `\\${c}`), category, country, author, savedOnly, limit, offset, kind]
    );
    return res.status(200).json({
      success: true,
      data: {
        items: result.rows.map((row) => formatOffer(row, req.user.id, req.user)),
        categories: active,
        pagination: { page, limit },
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyOffers(req, res, next) {
  try {
    const { active } = await loadCategories();
    const result = await pool.query(
      `${OFFER_SELECT} WHERE o.user_id = $1 AND o.status <> 'removed' ORDER BY o.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    return res.status(200).json({
      success: true,
      data: { items: result.rows.map((row) => formatOffer(row, req.user.id, req.user)), categories: active, limits: LIMITS },
    });
  } catch (error) {
    return next(error);
  }
}

/*
 * GET /api/community/offers/:id/open
 *
 * Seul endroit qui délivre l'adresse de destination d'une offre. Le navigateur
 * ne l'a pas reçue avec la liste (voir formatOffer) : il doit la demander ici,
 * ce qui donne au serveur un point de contrôle réel. Sans cette route,
 * « refusé côté serveur » serait impossible à tenir, l'ouverture étant
 * autrement une simple action du navigateur.
 */
async function openOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');

    const found = await pool.query(
      `SELECT o.id, o.url, o.min_age, o.user_id, o.status, o.expires_at
       FROM member_offers o JOIN users u ON u.id = o.user_id
       WHERE o.id = $1 AND o.status = 'published' AND u.is_active AND NOT u.is_banned`,
      [id]
    );
    const offer = found.rows[0];
    const isAdmin = String(req.userRole || '').toUpperCase() === 'ADMIN';
    // Fiche expirée : 404 pour les autres membres, comme si elle n'existait plus.
    if (offer && isExpired(offer) && offer.user_id !== req.user.id && !isAdmin) {
      return sendError(res, 404, 'NOT_FOUND', 'Cette offre n’est plus disponible.');
    }
    if (!offer) return sendError(res, 404, 'NOT_FOUND', 'Cette offre n’est plus disponible.');

    // Même dérogation qu'à l'affichage : réservée aux majeurs.
    if (!(offer.user_id === req.user.id && isAdult(req.user))) {
      const refusal = refusalForAffiliateLink(req.user, offer.min_age);
      if (refusal) {
        logger.info('Affiliate link refused', { offerId: id, userId: req.user.id, reason: refusal.code });
        return sendError(res, 403, refusal.code, refusal.message);
      }
    }

    return res.status(200).json({ success: true, data: { url: offer.url } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Catégories (administration)
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9_-]{2,40}$/;

/** Valide les champs d'une catégorie. Lève une ValidationError. */
function validateCategory(body, { requireSlug = true } = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const out = {};

  if (requireSlug) {
    const slug = String(source.slug || '').trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new ValidationError('INVALID_FIELD',
        'L’identifiant doit contenir 2 à 40 caractères : lettres minuscules, chiffres, tiret ou tiret bas.',
        400, 'slug');
    }
    out.slug = slug;
  }

  const label = String(source.label || '').trim().replace(/\s+/g, ' ');
  if (label.length < 2 || label.length > 80) {
    throw new ValidationError('INVALID_FIELD', 'Le nom affiché doit contenir entre 2 et 80 caractères.', 400, 'label');
  }
  out.label = label;

  const position = source.position === undefined || source.position === null || source.position === ''
    ? 100
    : Number(source.position);
  if (!Number.isInteger(position) || position < 0 || position > 999) {
    throw new ValidationError('INVALID_FIELD', 'L’ordre doit être un nombre entier entre 0 et 999.', 400, 'position');
  }
  out.position = position;

  out.is_active = source.is_active === undefined ? true : source.is_active === true;
  return out;
}

/** Nombre d'offres portant chaque catégorie : une catégorie utilisée ne se supprime pas. */
const CATEGORY_SELECT = `
  SELECT c.slug, c.label, c.position, c.is_active, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM member_offers o
           WHERE o.category = c.slug AND o.status <> 'removed')::int AS offers
  FROM offer_categories c`;

async function adminListCategories(req, res, next) {
  try {
    const { rows } = await pool.query(`${CATEGORY_SELECT} ORDER BY c.position, c.label`);
    return res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    return next(error);
  }
}

async function adminCreateCategory(req, res, next) {
  try {
    const value = validateCategory(req.body);
    const { rows } = await pool.query(
      `INSERT INTO offer_categories (slug, label, position, is_active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING
       RETURNING slug`,
      [value.slug, value.label, value.position, value.is_active]
    );
    if (!rows[0]) {
      return sendError(res, 409, 'CATEGORY_EXISTS', 'Cet identifiant est déjà utilisé.', { field: 'slug' });
    }

    invalidateCategories();
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, action, target_type, details)
       VALUES ($1, 'category.create', 'offer_category', $2)`,
      [req.user.id, JSON.stringify({ slug: value.slug })]
    );
    logger.info('Offer category created', { adminId: req.user.id, slug: value.slug });

    const created = await pool.query(`${CATEGORY_SELECT} WHERE c.slug = $1`, [value.slug]);
    return res.status(201).json({ success: true, data: { category: created.rows[0] } });
  } catch (error) {
    return handleError(error, res, next);
  }
}

/*
 * L'identifiant (slug) n'est JAMAIS modifiable : il est inscrit dans chaque
 * offre existante et dans les liens de recherche déjà partagés. Seuls le nom
 * affiché, l'ordre et l'activation changent.
 */
async function adminUpdateCategory(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return sendError(res, 400, 'INVALID_ID', 'Catégorie invalide.');
    const value = validateCategory(req.body, { requireSlug: false });

    const { rows } = await pool.query(
      `UPDATE offer_categories SET label = $2, position = $3, is_active = $4, updated_at = NOW()
       WHERE slug = $1 RETURNING slug`,
      [slug, value.label, value.position, value.is_active]
    );
    if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Catégorie introuvable.');

    invalidateCategories();
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, action, target_type, details)
       VALUES ($1, 'category.update', 'offer_category', $2)`,
      [req.user.id, JSON.stringify({ slug, is_active: value.is_active })]
    );

    const updated = await pool.query(`${CATEGORY_SELECT} WHERE c.slug = $1`, [slug]);
    return res.status(200).json({ success: true, data: { category: updated.rows[0] } });
  } catch (error) {
    return handleError(error, res, next);
  }
}

/*
 * Suppression possible UNIQUEMENT si aucune offre ne porte la catégorie.
 * Sinon on propose de la désactiver : supprimer laisserait des offres avec une
 * catégorie orpheline, sans libellé affichable.
 */
async function adminDeleteCategory(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return sendError(res, 400, 'INVALID_ID', 'Catégorie invalide.');

    const used = await pool.query(
      "SELECT COUNT(*)::int AS n FROM member_offers WHERE category = $1 AND status <> 'removed'",
      [slug]
    );
    if (used.rows[0].n > 0) {
      return sendError(res, 409, 'CATEGORY_IN_USE',
        `${used.rows[0].n} offre(s) utilisent cette catégorie. Désactive-la plutôt que de la supprimer.`);
    }

    const { rows } = await pool.query('DELETE FROM offer_categories WHERE slug = $1 RETURNING slug', [slug]);
    if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Catégorie introuvable.');

    invalidateCategories();
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, action, target_type, details)
       VALUES ($1, 'category.delete', 'offer_category', $2)`,
      [req.user.id, JSON.stringify({ slug })]
    );
    logger.info('Offer category deleted', { adminId: req.user.id, slug });
    return res.status(200).json({ success: true, data: { message: 'Catégorie supprimée.' } });
  } catch (error) {
    return next(error);
  }
}

/** Profil public : pseudo, ancienneté et nombre d'offres publiées. Ni nom ni e-mail. */
async function getMemberProfile(req, res, next) {
  try {
    const username = String(req.params.username || '').toLowerCase();
    if (!/^[a-z0-9_.-]{1,50}$/.test(username)) return sendError(res, 404, 'NOT_FOUND', 'Membre introuvable.');
    const result = await pool.query(
      `SELECT u.username, u.created_at,
              (SELECT COUNT(*) FROM member_offers o WHERE o.user_id = u.id AND o.status = 'published' AND ${NOT_EXPIRED})::int AS published_offers
       FROM users u
       WHERE u.username = $1 AND u.is_active AND NOT u.is_banned`,
      [username]
    );
    if (!result.rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Membre introuvable.');
    const row = result.rows[0];
    return res.status(200).json({
      success: true,
      data: { profile: { username: row.username, member_since: row.created_at, published_offers: row.published_offers } },
    });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Publication (auteur)
// ---------------------------------------------------------------------------

async function createOffer(req, res, next) {
  try {
    const { active } = await loadCategories();
    // Lien affilié : ADMIN uniquement (rôle lu en base). Sinon, fiche campagne.
    const kind = req.userRole === 'ADMIN' ? 'affiliate' : 'campaign';
    const offer = validateOffer(req.body, active, kind);

    const usage = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM member_offers WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours')::int AS today,
         (SELECT COUNT(*) FROM member_offers WHERE user_id = $1 AND status = 'pending')::int AS pending,
         EXISTS (SELECT 1 FROM member_offers WHERE user_id = $1 AND url = $2 AND status IN ('pending', 'published')) AS duplicate`,
      [req.user.id, offer.url]
    );
    const { today, pending, duplicate } = usage.rows[0];
    if (duplicate) throw new ValidationError('DUPLICATE_OFFER', 'Tu as déjà proposé ce lien.', 409);
    if (today >= LIMITS.offersPerDay) {
      throw new ValidationError('RATE_LIMITED', `Limite atteinte : ${LIMITS.offersPerDay} offres par 24 heures.`, 429);
    }
    if (pending >= LIMITS.pendingPerUser) {
      throw new ValidationError('RATE_LIMITED', `Tu as déjà ${LIMITS.pendingPerUser} offres en attente de vérification.`, 429);
    }

    const result = await pool.query(
      `INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action,
                                  payout_text, min_age, conditions, rights_confirmed_at, status,
                                  kind, campaign_name, tips)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), 'pending', $11, $12, $13)
       RETURNING *`,
      [req.user.id, offer.title, offer.url, offer.description, offer.category, offer.countries,
        offer.expected_action, offer.payout_text, offer.min_age, offer.conditions,
        kind, offer.campaign_name, offer.tips]
    );
    logger.info('Member offer submitted', { userId: req.user.id, offerId: result.rows[0].id });
    return res.status(201).json({
      success: true,
      data: {
        offer: formatOffer({ ...result.rows[0], author_username: req.user.username }, req.user.id, req.user),
        message: kind === 'campaign'
          ? 'Ta fiche a été envoyée. Elle sera visible après vérification par l’équipe.'
          : 'Ton offre a été envoyée. Elle sera visible après vérification par l’équipe.',
      },
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

/*
 * Droit de modifier ou de retirer une offre : son auteur, ou un ADMIN.
 *
 * On lit l'offre AVANT d'agir, pour distinguer deux situations que l'ancienne
 * version confondait en 404 :
 *   - l'offre n'existe pas            -> 404
 *   - elle existe mais appartient a   -> 403, et on le dit clairement
 *     quelqu'un d'autre
 *
 * L'identifiant du demandeur vient toujours de la session (req.user.id),
 * jamais du corps de la requête.
 *
 * Retourne { offer } si l'accès est accordé, sinon { error: true } après avoir
 * répondu.
 */
async function loadOwnedOffer(req, res, id) {
  const found = await pool.query(
    `SELECT o.id, o.user_id, o.status, o.kind, u.username AS author_username
     FROM member_offers o JOIN users u ON u.id = o.user_id
     WHERE o.id = $1`,
    [id]
  );
  const offer = found.rows[0];
  if (!offer || offer.status === 'removed') {
    sendError(res, 404, 'NOT_FOUND', 'Cette offre n’existe pas ou a déjà été retirée.');
    return { error: true };
  }

  const isAuthor = offer.user_id === req.user.id;
  const isAdmin = String(req.userRole || '').toUpperCase() === 'ADMIN';
  if (!isAuthor && !isAdmin) {
    logger.warn('Member offer access denied', { offerId: id, userId: req.user.id });
    sendError(res, 403, 'NOT_OWNER', 'Cette offre a été publiée par un autre membre : tu ne peux pas la modifier.');
    return { error: true };
  }
  return { offer, isAdmin, isAuthor };
}

async function updateOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');

    const access = await loadOwnedOffer(req, res, id);
    if (access.error) return undefined;

    const { active } = await loadCategories();
    /*
     * Un ADMIN garde la sorte de l'offre qu'il corrige. Un non ADMIN ne
     * modifie qu'une fiche campagne : même une ancienne offre « affiliate »
     * (auteur qui n'est plus ADMIN) devient une fiche campagne.
     */
    const kind = access.isAdmin ? (access.offer.kind || 'campaign') : 'campaign';
    const offer = validateOffer(req.body, active, kind);

    /*
     * Toute modification renvoie l'offre en vérification, y compris celle d'un
     * ADMIN : le contenu change, il doit être revu. L'auteur ne change jamais
     * (user_id n'est pas touché), même si c'est un ADMIN qui modifie.
     */
    const result = await pool.query(
      `UPDATE member_offers
       SET title = $2, url = $3, description = $4, category = $5, countries = $6, expected_action = $7,
           payout_text = $8, min_age = $9, conditions = $10, rights_confirmed_at = NOW(),
           kind = $11, campaign_name = $12, tips = $13,
           status = 'pending', moderation_note = NULL, published_at = NULL, expires_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'published', 'rejected')
       RETURNING *`,
      [id, offer.title, offer.url, offer.description, offer.category, offer.countries,
        offer.expected_action, offer.payout_text, offer.min_age, offer.conditions,
        kind, offer.campaign_name, offer.tips]
    );
    if (!result.rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Offre introuvable.');
    return res.status(200).json({
      success: true,
      data: {
        // Le pseudo affiché est celui de l'AUTEUR, pas du demandeur : un ADMIN
        // qui corrige une offre ne doit pas apparaître comme son auteur.
        offer: formatOffer({ ...result.rows[0], author_username: access.offer.author_username }, req.user.id, req.user),
        message: 'Modification envoyée : ton offre sera de nouveau visible après vérification.',
      },
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

async function removeOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');

    const access = await loadOwnedOffer(req, res, id);
    if (access.error) return undefined;

    // Retrait logique : la ligne reste en base avec status = 'removed'.
    const result = await pool.query(
      `UPDATE member_offers SET status = 'removed', updated_at = NOW()
       WHERE id = $1 AND status <> 'removed' RETURNING id`,
      [id]
    );
    if (!result.rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Offre introuvable.');
    return res.status(200).json({ success: true, data: { message: 'Ton offre a été retirée.' } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Enregistrer / signaler
// ---------------------------------------------------------------------------

async function saveOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');
    const result = await pool.query(
      `INSERT INTO member_offer_saves (user_id, offer_id)
       SELECT $1, o.id FROM member_offers o WHERE o.id = $2 AND o.status = 'published' AND ${NOT_EXPIRED}
       ON CONFLICT DO NOTHING RETURNING offer_id`,
      [req.user.id, id]
    );
    const exists = result.rows[0] || (await pool.query(
      'SELECT 1 FROM member_offer_saves WHERE user_id = $1 AND offer_id = $2', [req.user.id, id]
    )).rows[0];
    if (!exists) return sendError(res, 404, 'NOT_FOUND', 'Offre introuvable.');
    return res.status(200).json({ success: true, data: { saved: true } });
  } catch (error) {
    return next(error);
  }
}

async function unsaveOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');
    await pool.query('DELETE FROM member_offer_saves WHERE user_id = $1 AND offer_id = $2', [req.user.id, id]);
    return res.status(200).json({ success: true, data: { saved: false } });
  } catch (error) {
    return next(error);
  }
}

async function reportOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');
    const reason = req.body?.reason;
    if (!REPORT_REASONS.includes(reason)) return sendError(res, 400, 'INVALID_REASON', 'Choisis un motif de signalement.');
    const details = req.body?.details === undefined || req.body?.details === null || req.body?.details === ''
      ? null
      : (typeof req.body.details === 'string' && req.body.details.length <= 500 ? req.body.details.trim() : undefined);
    if (details === undefined) return sendError(res, 400, 'INVALID_FIELD', 'Le détail ne doit pas dépasser 500 caractères.');

    const outcome = await withTransaction(async (client) => {
      const offer = await client.query(
        "SELECT id, user_id, status FROM member_offers WHERE id = $1 AND status = 'published' FOR UPDATE", [id]
      );
      if (!offer.rows[0]) return { status: 404 };
      if (offer.rows[0].user_id === req.user.id) return { status: 400 };

      const recent = await client.query(
        "SELECT COUNT(*)::int AS n FROM member_offer_reports WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        [req.user.id]
      );
      if (recent.rows[0].n >= LIMITS.reportsPerDay) return { status: 429 };

      const inserted = await client.query(
        `INSERT INTO member_offer_reports (offer_id, user_id, reason, details) VALUES ($1, $2, $3, $4)
         ON CONFLICT (offer_id, user_id) DO NOTHING RETURNING id`,
        [id, req.user.id, reason, details]
      );
      if (!inserted.rows[0]) return { status: 200, already: true };

      // Trop de signalements : l'offre est masquée en attendant la modération.
      const open = await client.query(
        "SELECT COUNT(*)::int AS n FROM member_offer_reports WHERE offer_id = $1 AND status = 'open'", [id]
      );
      if (open.rows[0].n >= LIMITS.reportsToHide) {
        await client.query(
          `UPDATE member_offers SET status = 'pending', published_at = NULL,
                  moderation_note = 'Masquée automatiquement après plusieurs signalements.', updated_at = NOW()
           WHERE id = $1`,
          [id]
        );
        logger.warn('Member offer hidden after reports', { offerId: id });
      }
      return { status: 200 };
    });

    if (outcome.status === 404) return sendError(res, 404, 'NOT_FOUND', 'Offre introuvable.');
    if (outcome.status === 400) return sendError(res, 400, 'OWN_OFFER', 'Tu ne peux pas signaler ta propre offre.');
    if (outcome.status === 429) return sendError(res, 429, 'RATE_LIMITED', 'Trop de signalements aujourd’hui.');
    return res.status(200).json({
      success: true,
      data: { message: outcome.already ? 'Tu as déjà signalé cette offre.' : 'Merci : ton signalement a été transmis à l’équipe.' },
    });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Modération (admin)
// ---------------------------------------------------------------------------

const ADMIN_FILTERS = {
  pending: "o.status = 'pending'",
  published: "o.status = 'published'",
  rejected: "o.status = 'rejected'",
  removed: "o.status = 'removed'",
  reported: "EXISTS (SELECT 1 FROM member_offer_reports r WHERE r.offer_id = o.id AND r.status = 'open')",
};

async function adminListOffers(req, res, next) {
  try {
    const filter = ADMIN_FILTERS[req.query.status] || ADMIN_FILTERS.pending;
    const result = await pool.query(
      `SELECT o.*, u.username AS author_username,
              (SELECT COUNT(*) FROM member_offer_reports r WHERE r.offer_id = o.id AND r.status = 'open')::int AS open_reports,
              (SELECT json_agg(json_build_object('reason', r.reason, 'details', r.details, 'created_at', r.created_at)
                               ORDER BY r.created_at DESC)
                 FROM member_offer_reports r WHERE r.offer_id = o.id AND r.status = 'open') AS reports
       FROM member_offers o JOIN users u ON u.id = o.user_id
       WHERE ${filter}
       /*
        * Les offres signalées remontent en tête, les plus signalées d'abord :
        * ce sont celles qui demandent une décision rapide. Le reste suit par
        * date de mise à jour.
        */
       ORDER BY (SELECT COUNT(*) FROM member_offer_reports r
                 WHERE r.offer_id = o.id AND r.status = 'open') DESC,
                o.updated_at DESC
       LIMIT 200`
    );
    const items = result.rows.map((row) => ({
      ...formatOffer(row, null),
      moderation_note: row.moderation_note,
      open_reports: row.open_reports,
      reports: row.reports || [],
    }));
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    return next(error);
  }
}

const DECISIONS = {
  publish: 'published',
  reject: 'rejected',
  remove: 'removed',
};

async function adminModerateOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');
    const status = DECISIONS[req.body?.decision];
    if (!status) return sendError(res, 400, 'INVALID_DECISION', 'Décision invalide.');
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) || null : null;
    if (status !== 'published' && !note) {
      return sendError(res, 400, 'NOTE_REQUIRED', 'Indique le motif : il sera montré à l’auteur.');
    }

    const offer = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE member_offers
         SET status = $2::text, moderation_note = $3, moderated_by = $4, moderated_at = NOW(), updated_at = NOW(),
             published_at = CASE WHEN $2::text = 'published' THEN NOW() ELSE NULL END,
             -- Fiche campagne : 24 h à partir de la validation, pas de l'envoi.
             expires_at = CASE WHEN $2::text = 'published' AND kind = 'campaign'
                               THEN NOW() + make_interval(hours => ${STORY_HOURS}) ELSE NULL END,
             renewed_at = NULL
         WHERE id = $1 RETURNING id, title, user_id`,
        [id, status, note, req.user.id]
      );
      if (!result.rows[0]) return null;
      // Une décision clôt les signalements ouverts.
      await client.query("UPDATE member_offer_reports SET status = 'closed' WHERE offer_id = $1 AND status = 'open'", [id]);
      await client.query(
        `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details)
         VALUES ($1, $2, 'member_offer', $3, $4)`,
        [req.user.id, `member_offer.${req.body.decision}`, id, JSON.stringify({ note })]
      );
      return result.rows[0];
    });
    if (!offer) return sendError(res, 404, 'NOT_FOUND', 'Offre introuvable.');
    logger.info('Admin action', { adminId: req.user.id, action: `member_offer.${req.body.decision}`, targetId: id });
    // Web Push, attendu (3 s max) : seulement validation et refus.
    if (status === 'published' || status === 'rejected') {
      const title = String(offer.title || '').length > 40 ? `${String(offer.title).slice(0, 39)}…` : String(offer.title || '');
      await push.sendToUser(offer.user_id, {
        title: 'HAISSEL',
        body: status === 'published' ? `Ta fiche a été validée : ${title}` : `Ta fiche n’a pas été validée : ${title}`,
        url: '/app#profile',
        tag: `offer-${offer.id}`,
      }, { urgency: 'high' });
    }
    return res.status(200).json({ success: true, data: { id: offer.id, status } });
  } catch (error) {
    return next(error);
  }
}

/*
 * POST /api/community/offers/:id/renew : l'auteur republie sa fiche pour 24 h.
 *
 * Le contenu ne change pas, donc pas de nouvelle modération. Modifier le
 * contenu passe par PATCH et repasse en modération.
 *
 * RÈGLE VOULUE : republier ne dépend D'AUCUNE action sur les fiches ou les
 * liens des autres membres (pas de « j'aime », de clic, d'inscription ni de
 * republication d'autrui en échange). N'ajoutez jamais une telle condition :
 * ce serait organiser l'échange d'inscriptions que le règlement interdit.
 * Seules conditions : être l'auteur, fiche campagne publiée, 20 h depuis la
 * dernière publication.
 */
async function renewOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Fiche invalide.');
    const found = await pool.query(
      `SELECT id, user_id, kind, status,
              GREATEST(published_at, COALESCE(renewed_at, published_at))
                > NOW() - make_interval(hours => ${RENEW_COOLDOWN_HOURS}) AS too_soon
       FROM member_offers WHERE id = $1`,
      [id]
    );
    const offer = found.rows[0];
    if (!offer || offer.user_id !== req.user.id || offer.status === 'removed') {
      return sendError(res, 404, 'NOT_FOUND', 'Fiche introuvable.');
    }
    if (offer.kind !== 'campaign' || offer.status !== 'published') {
      return sendError(res, 409, 'NOT_RENEWABLE', 'Seule une fiche campagne publiée peut être republiée.');
    }
    if (offer.too_soon) {
      return sendError(res, 403, 'RENEW_TOO_SOON',
        `Tu as publié cette fiche il y a moins de ${RENEW_COOLDOWN_HOURS} h. Tu pourras la republier plus tard.`);
    }
    const result = await pool.query(
      `UPDATE member_offers
       SET renewed_at = NOW(), expires_at = NOW() + make_interval(hours => ${STORY_HOURS}), updated_at = NOW()
       WHERE id = $1 AND status = 'published' RETURNING *`,
      [id]
    );
    if (!result.rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Fiche introuvable.');
    return res.status(200).json({
      success: true,
      data: {
        offer: formatOffer({ ...result.rows[0], author_username: req.user.username }, req.user.id, req.user),
        message: 'Ta fiche est de nouveau visible 24 h.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

/*
 * POST /api/admin/community/offers/:id/extend : un ADMIN prolonge une fiche
 * campagne publiée de 24 h (à partir de maintenant si elle a déjà expiré).
 * Le retrait passe par la décision « remove » de adminModerateOffer.
 */
async function adminExtendOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');
    const offer = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE member_offers
         SET expires_at = GREATEST(COALESCE(expires_at, NOW()), NOW()) + make_interval(hours => ${STORY_HOURS}),
             updated_at = NOW()
         WHERE id = $1 AND kind = 'campaign' AND status = 'published' RETURNING id, expires_at`,
        [id]
      );
      if (!result.rows[0]) return null;
      await client.query(
        `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details)
         VALUES ($1, 'member_offer.extend', 'member_offer', $2, $3)`,
        [req.user.id, id, JSON.stringify({ expires_at: result.rows[0].expires_at })]
      );
      return result.rows[0];
    });
    if (!offer) return sendError(res, 409, 'NOT_EXTENDABLE', 'Seule une fiche campagne publiée peut être prolongée.');
    logger.info('Admin action', { adminId: req.user.id, action: 'member_offer.extend', targetId: id });
    return res.status(200).json({ success: true, data: { id: offer.id, expires_at: offer.expires_at } });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  renewOffer,
  adminExtendOffer,
  STORY_HOURS,
  RENEW_COOLDOWN_HOURS,
  openOffer,
  listOffers,
  listMyOffers,
  getMemberProfile,
  createOffer,
  updateOffer,
  removeOffer,
  saveOffer,
  unsaveOffer,
  reportOffer,
  adminListOffers,
  adminModerateOffer,
  normalizeMemberUrl,
  validateOffer,
  SENSITIVE_TOPICS,
  loadCategories,
  invalidateCategories,
  adminListCategories,
  adminCreateCategory,
  adminUpdateCategory,
  adminDeleteCategory,
  FALLBACK_CATEGORIES,
  LIMITS,
};
