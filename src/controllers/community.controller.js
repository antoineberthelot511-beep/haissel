const { pool, withTransaction } = require('../config/database');
const { sendError, parseId, parsePagination } = require('../utils/http');
const { logger } = require('../utils/logger');
const { FORBIDDEN_CLAIMS } = require('./learn.controller');

/*
 * Offres publiées par les membres.
 *
 * Toutes les routes exigent une session. Règles :
 *  - un membre ne modifie ou ne retire QUE ses propres offres ;
 *  - toute offre (création ou modification) passe en modération (pending) ;
 *  - seules les offres « published » sont visibles des autres membres ;
 *  - liens : HTTPS uniquement, vrai nom de domaine, sans identifiants ;
 *    le texte est stocké tel quel et affiché comme texte (jamais du HTML) ;
 *  - thèmes sensibles (jeux d'argent, crypto, crédit, rencontres, adulte…)
 *    refusés ; promesses de gains refusées ;
 *  - limites anti-spam en base (par jour, en attente, doublons) ;
 *  - aucune donnée MyLead (identifiant, mot de passe, cookie) n'est demandée.
 */

const CATEGORIES = {
  applications: 'Applications',
  jeux: 'Jeux mobiles',
  shopping: 'Shopping',
  services: 'Services en ligne',
  education: 'Éducation',
  sondages: 'Sondages et avis',
  autre: 'Autre',
};

const REPORT_REASONS = ['misleading', 'spam', 'dangerous', 'minors', 'rights', 'other'];

const LIMITS = {
  offersPerDay: 5,
  pendingPerUser: 10,
  reportsPerDay: 20,
  reportsToHide: 3,
};

// Thèmes incompatibles avec un public jeune : refusés quelle que soit la catégorie.
const SENSITIVE_TOPICS = /\b(casinos?|paris?\s+sportifs?|paris?\s+en\s+ligne|betting|poker|loteries?|crypto\w*|bitcoin|forex|trading|rencontres?|dating|adultes?|porno\w*|xxx|sexe|escort\w*|prêts?|crédits?\s+(conso\w*|rapide|immédiat)|rachat\s+de\s+crédit|cbd|vapes?|tabac|alcool)\b/i;

class ValidationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Lien fourni par un membre : donnée non fiable.
 * Retourne l'URL normalisée, ou lève une ValidationError.
 */
function normalizeMemberUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new ValidationError('INVALID_URL', 'Indique un lien valide (2000 caractères maximum).');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new ValidationError('INVALID_URL', 'Ce lien n’est pas une adresse web valide.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') {
    throw new ValidationError('INVALID_URL', 'Seuls les liens sécurisés « https:// » sont acceptés.');
  }
  if (url.username || url.password) {
    throw new ValidationError('INVALID_URL', 'Le lien ne doit pas contenir d’identifiant ni de mot de passe.');
  }
  if (url.port && url.port !== '443') {
    throw new ValidationError('INVALID_URL', 'Le lien ne doit pas utiliser de port particulier.');
  }
  if (!host.includes('.') || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) {
    throw new ValidationError('INVALID_URL', 'Le lien doit pointer vers un vrai nom de domaine public.');
  }
  return url.href;
}

function text(body, name, label, { min = 0, max, required = false }) {
  const raw = body[name];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new ValidationError('INVALID_FIELD', `Le champ « ${label} » est obligatoire.`);
    return null;
  }
  if (typeof raw !== 'string') throw new ValidationError('INVALID_FIELD', `« ${label} » doit être un texte.`);
  const value = raw.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (value.length < min || value.length > max) {
    throw new ValidationError('INVALID_FIELD', `« ${label} » doit contenir entre ${min} et ${max} caractères.`);
  }
  if (FORBIDDEN_CLAIMS.test(value)) {
    throw new ValidationError('MISLEADING_CLAIM', `« ${label} » contient une promesse de gain : aucun gain n'est garanti.`);
  }
  return value;
}

function validateOffer(body) {
  const source = body && typeof body === 'object' ? body : {};
  const offer = {
    title: text(source, 'title', 'Titre', { min: 5, max: 120, required: true }),
    url: normalizeMemberUrl(source.url),
    description: text(source, 'description', 'Description', { min: 20, max: 1500, required: true }),
    countries: text(source, 'countries', 'Pays concernés', { min: 2, max: 200, required: true }),
    expected_action: text(source, 'expected_action', 'Action attendue', { min: 5, max: 300, required: true }),
    payout_text: text(source, 'payout_text', 'Rémunération annoncée', { max: 160 }),
    conditions: text(source, 'conditions', 'Conditions et restrictions', { max: 2000 }),
  };

  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, source.category)) {
    throw new ValidationError('INVALID_FIELD', 'Choisis une catégorie dans la liste.');
  }
  offer.category = source.category;

  if (source.min_age === undefined || source.min_age === null || source.min_age === '') {
    offer.min_age = null;
  } else if (Number.isInteger(source.min_age) && source.min_age >= 10 && source.min_age <= 99) {
    offer.min_age = source.min_age;
  } else {
    throw new ValidationError('INVALID_FIELD', 'L’âge minimum doit être un nombre entre 10 et 99.');
  }

  if (source.rights_confirmed !== true) {
    throw new ValidationError('RIGHTS_NOT_CONFIRMED', 'Confirme que tu as le droit de promouvoir cette offre.');
  }

  const haystack = [offer.title, offer.description, offer.conditions, offer.expected_action, offer.url].join(' ');
  if (SENSITIVE_TOPICS.test(haystack)) {
    throw new ValidationError('FORBIDDEN_TOPIC', 'Ce type d’offre (jeux d’argent, crypto, crédit, rencontres, contenus pour adultes, tabac, alcool…) n’est pas accepté sur HAISSEL.');
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

function formatOffer(row, userId) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    domain: domainOf(row.url),
    description: row.description,
    category: row.category,
    category_label: CATEGORIES[row.category] || row.category,
    countries: row.countries,
    expected_action: row.expected_action,
    payout_text: row.payout_text,
    min_age: row.min_age,
    conditions: row.conditions,
    status: row.status,
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author: { username: row.author_username },
    is_mine: row.user_id === userId,
    saved: Boolean(row.saved),
    ...(row.user_id === userId ? { moderation_note: row.moderation_note } : {}),
  };
}

function handleError(error, res, next) {
  if (error instanceof ValidationError) return sendError(res, error.status, error.code, error.message);
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
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const category = typeof req.query.category === 'string' && CATEGORIES[req.query.category] ? req.query.category : null;
    const country = typeof req.query.country === 'string' && /^[A-Za-z]{2}$/.test(req.query.country) ? req.query.country.toUpperCase() : null;
    const author = typeof req.query.author === 'string' && /^[a-z0-9_.-]{1,50}$/i.test(req.query.author) ? req.query.author.toLowerCase() : null;
    const savedOnly = req.query.saved === '1';

    const result = await pool.query(
      `${OFFER_SELECT}
       WHERE o.status = 'published' AND u.is_active AND NOT u.is_banned
         AND ($2::text = '' OR o.title ILIKE '%' || $2 || '%' OR o.description ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR o.category = $3)
         AND ($4::text IS NULL OR upper(o.countries) ~ ('(^|[^A-Z])(' || $4 || '|MONDE|TOUS)([^A-Z]|$)'))
         AND ($5::text IS NULL OR u.username = $5)
         AND (NOT $6::boolean OR EXISTS (SELECT 1 FROM member_offer_saves s WHERE s.offer_id = o.id AND s.user_id = $1))
       ORDER BY o.published_at DESC, o.id DESC
       LIMIT $7 OFFSET $8`,
      [req.user.id, q.replace(/[\\%_]/g, (c) => `\\${c}`), category, country, author, savedOnly, limit, offset]
    );
    return res.status(200).json({
      success: true,
      data: {
        items: result.rows.map((row) => formatOffer(row, req.user.id)),
        categories: CATEGORIES,
        pagination: { page, limit },
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyOffers(req, res, next) {
  try {
    const result = await pool.query(
      `${OFFER_SELECT} WHERE o.user_id = $1 AND o.status <> 'removed' ORDER BY o.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    return res.status(200).json({
      success: true,
      data: { items: result.rows.map((row) => formatOffer(row, req.user.id)), categories: CATEGORIES, limits: LIMITS },
    });
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
              (SELECT COUNT(*) FROM member_offers o WHERE o.user_id = u.id AND o.status = 'published')::int AS published_offers
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
    const offer = validateOffer(req.body);

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
                                  payout_text, min_age, conditions, rights_confirmed_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), 'pending')
       RETURNING *`,
      [req.user.id, offer.title, offer.url, offer.description, offer.category, offer.countries,
        offer.expected_action, offer.payout_text, offer.min_age, offer.conditions]
    );
    logger.info('Member offer submitted', { userId: req.user.id, offerId: result.rows[0].id });
    return res.status(201).json({
      success: true,
      data: {
        offer: formatOffer({ ...result.rows[0], author_username: req.user.username }, req.user.id),
        message: 'Ton offre a été envoyée. Elle sera visible après vérification par l’équipe.',
      },
    });
  } catch (error) {
    return handleError(error, res, next);
  }
}

async function updateOffer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Offre invalide.');
    const offer = validateOffer(req.body);

    // Modifier une offre la renvoie en vérification ; seul l'auteur le peut.
    const result = await pool.query(
      `UPDATE member_offers
       SET title = $3, url = $4, description = $5, category = $6, countries = $7, expected_action = $8,
           payout_text = $9, min_age = $10, conditions = $11, rights_confirmed_at = NOW(),
           status = 'pending', moderation_note = NULL, published_at = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'published', 'rejected')
       RETURNING *`,
      [id, req.user.id, offer.title, offer.url, offer.description, offer.category, offer.countries,
        offer.expected_action, offer.payout_text, offer.min_age, offer.conditions]
    );
    if (!result.rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Offre introuvable.');
    return res.status(200).json({
      success: true,
      data: {
        offer: formatOffer({ ...result.rows[0], author_username: req.user.username }, req.user.id),
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
    const result = await pool.query(
      `UPDATE member_offers SET status = 'removed', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status <> 'removed' RETURNING id`,
      [id, req.user.id]
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
       SELECT $1, id FROM member_offers WHERE id = $2 AND status = 'published'
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
       ORDER BY o.updated_at DESC
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
             published_at = CASE WHEN $2::text = 'published' THEN NOW() ELSE NULL END
         WHERE id = $1 RETURNING id, title`,
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
    return res.status(200).json({ success: true, data: { id: offer.id, status } });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
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
  CATEGORIES,
  LIMITS,
};
