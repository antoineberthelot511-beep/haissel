const { pool, withTransaction } = require('../config/database');
const { sendError, parseId } = require('../utils/http');
const { logger } = require('../utils/logger');
const { isSafeOfferUrl } = require('../services/affiliate.service');

/*
 * Espace pédagogique : guides, tutoriels, opportunités et parrainage.
 *
 * Membres (session requise) : lecture des éléments PUBLIÉS uniquement.
 * Administration (requireLocalAdmin -> authenticateToken -> ensureAdmin) :
 * création, modification, vérification, publication, désactivation.
 *
 * Règles :
 *  - publier exige une vérification explicite par un administrateur ;
 *  - toute modification annule la vérification (et dépublie) ;
 *  - une opportunité n'est vérifiable que si âge minimum, pays, action
 *    rémunérée, restrictions et date de contrôle des conditions sont remplis ;
 *  - les promesses de gains garantis sont refusées ;
 *  - aucun clic ni aucune donnée de membre n'est enregistré ici.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Formulations interdites : un gain n'est jamais garanti.
const FORBIDDEN_CLAIMS = /(gains?|revenus?|argent|paiements?|commissions?)\s+(garanti|assuré|sûr|certain)|garanti(e|s)?\s+(de\s+)?(gagner|gains?|revenus?)|argent\s+facile|(100\s*%|sans\s+risque)\s+(garanti|gagnant)/i;

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const field = {
  text: (label, { min = 0, max, required = false } = {}) => ({ type: 'text', label, min, max, required }),
  int: (label, { min, max, required = false } = {}) => ({ type: 'int', label, min, max, required }),
  url: (label) => ({ type: 'url', label }),
  date: (label) => ({ type: 'date', label }),
  bool: (label) => ({ type: 'bool', label }),
  enumOf: (label, values, { required = false } = {}) => ({ type: 'enum', label, values, required }),
  slug: (label) => ({ type: 'slug', label, required: true }),
};

function normalizeValue(name, spec, raw) {
  if (raw === null || raw === '' || raw === undefined) {
    if (spec.required) throw new ValidationError('INVALID_FIELD', `Le champ « ${spec.label} » est obligatoire.`);
    return null;
  }

  switch (spec.type) {
    case 'text': {
      if (typeof raw !== 'string') throw new ValidationError('INVALID_FIELD', `« ${spec.label} » doit être un texte.`);
      const value = raw.replace(/\r\n/g, '\n').trim();
      if (value.length < spec.min || value.length > spec.max) {
        throw new ValidationError('INVALID_FIELD', `« ${spec.label} » doit contenir entre ${spec.min} et ${spec.max} caractères.`);
      }
      if (FORBIDDEN_CLAIMS.test(value)) {
        throw new ValidationError('MISLEADING_CLAIM', `« ${spec.label} » contient une promesse de gain : aucun gain n'est garanti.`);
      }
      return value || null;
    }
    case 'int': {
      const value = typeof raw === 'string' && /^\d{1,5}$/.test(raw) ? Number(raw) : raw;
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
        throw new ValidationError('INVALID_FIELD', `« ${spec.label} » doit être un nombre entre ${spec.min} et ${spec.max}.`);
      }
      return value;
    }
    case 'url':
      if (!isSafeOfferUrl(raw)) throw new ValidationError('INVALID_URL', `« ${spec.label} » doit être une adresse http(s) valide.`);
      return raw.trim();
    case 'date': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
        throw new ValidationError('INVALID_DATE', `« ${spec.label} » doit être une date (AAAA-MM-JJ).`);
      }
      if (Date.parse(`${raw}T00:00:00Z`) > Date.now() + 24 * 3600 * 1000) {
        throw new ValidationError('INVALID_DATE', `« ${spec.label} » ne peut pas être dans le futur.`);
      }
      return raw;
    }
    case 'bool':
      if (typeof raw !== 'boolean') throw new ValidationError('INVALID_FIELD', `« ${spec.label} » doit être vrai ou faux.`);
      return raw;
    case 'enum':
      if (!spec.values.includes(raw)) throw new ValidationError('INVALID_FIELD', `« ${spec.label} » est invalide.`);
      return raw;
    case 'slug':
      if (typeof raw !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,78})[a-z0-9]$/.test(raw)) {
        throw new ValidationError('INVALID_SLUG', `« ${spec.label} » : 3 à 80 caractères, minuscules, chiffres et tirets.`);
      }
      return raw;
    default:
      throw new Error(`Unknown field type for ${name}`);
  }
}

/** Retourne { colonne: valeur } pour les champs fournis (tous si !partial). */
function validateFields(specs, body, { partial = false } = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const changes = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (partial && source[name] === undefined) continue;
    changes[name] = normalizeValue(name, spec, source[name]);
  }
  if (partial && Object.keys(changes).length === 0) {
    throw new ValidationError('INVALID_REQUEST', 'Aucune modification fournie.');
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Ressources gérées par l'administration
// ---------------------------------------------------------------------------

const RESOURCES = {
  content: {
    table: 'learning_content',
    target: 'learning_content',
    notFound: 'Contenu introuvable.',
    columns: 'id, kind, slug, title, summary, body, level, position, status, verified_at, verified_by, created_at, updated_at',
    order: 'kind, position, id',
    fields: {
      kind: field.enumOf('Type', ['guide', 'tutorial'], { required: true }),
      slug: field.slug('Identifiant'),
      title: field.text('Titre', { min: 3, max: 120, required: true }),
      summary: field.text('Résumé', { max: 300 }),
      body: field.text('Contenu', { min: 20, max: 20000, required: true }),
      level: field.enumOf('Niveau', ['debutant', 'intermediaire'], { required: true }),
      position: field.int('Ordre', { min: 0, max: 10000, required: true }),
    },
    defaults: { level: 'debutant', position: 100 },
    missingForPublication: () => [],
  },
  opportunity: {
    table: 'opportunities',
    target: 'opportunity',
    notFound: 'Opportunité introuvable.',
    columns: `id, name, advertiser, network, paid_action, payout_text, countries, min_age, restrictions,
              allowed_channels, forbidden_methods, url, is_affiliate, terms_url,
              to_char(conditions_checked_at, 'YYYY-MM-DD') AS conditions_checked_at,
              status, verified_at, verified_by, created_at, updated_at`,
    order: 'name, id',
    fields: {
      name: field.text('Nom', { min: 2, max: 120, required: true }),
      advertiser: field.text('Annonceur', { max: 120 }),
      network: field.text('Plateforme', { max: 80 }),
      paid_action: field.text('Action rémunérée', { max: 300 }),
      payout_text: field.text('Rémunération indiquée', { max: 160 }),
      countries: field.text('Pays acceptés', { max: 200 }),
      min_age: field.int('Âge minimum', { min: 10, max: 99 }),
      restrictions: field.text('Restrictions', { max: 2000 }),
      allowed_channels: field.text('Canaux autorisés', { max: 1000 }),
      forbidden_methods: field.text('Méthodes interdites', { max: 1000 }),
      url: field.url('Lien'),
      is_affiliate: field.bool('Lien affilié'),
      terms_url: field.url('Conditions officielles'),
      conditions_checked_at: field.date('Conditions vérifiées le'),
    },
    defaults: { is_affiliate: true },
    missingForPublication: (row) => {
      const labels = {
        paid_action: 'action rémunérée', countries: 'pays acceptés', min_age: 'âge minimum',
        restrictions: 'restrictions', conditions_checked_at: 'date de vérification des conditions',
      };
      return Object.entries(labels)
        .filter(([key]) => row[key] === null || row[key] === undefined || row[key] === '')
        .map(([, label]) => label);
    },
  },
};

const STATUSES = ['draft', 'published', 'disabled'];

async function logAdminAction(client, req, action, targetType, targetId, details = {}) {
  await client.query(
    `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.user.id, action, targetType, targetId, JSON.stringify(details)]
  );
  logger.info('Admin action', { adminId: req.user.id, action, targetType, targetId });
}

function handleError(error, res, next) {
  if (error instanceof ValidationError) return sendError(res, 400, error.code, error.message);
  if (error.code === '23505') return sendError(res, 409, 'DUPLICATE', 'Cet identifiant est déjà utilisé.');
  return next(error);
}

function adminHandlers(resourceName) {
  const resource = RESOURCES[resourceName];
  const { table, columns } = resource;

  async function list(req, res, next) {
    try {
      const result = await pool.query(`SELECT ${columns} FROM ${table} ORDER BY ${resource.order} LIMIT 500`);
      const items = result.rows.map((row) => ({ ...row, missing_for_publication: resource.missingForPublication(row) }));
      return res.status(200).json({ success: true, data: { items } });
    } catch (error) {
      return next(error);
    }
  }

  async function create(req, res, next) {
    try {
      const values = validateFields(resource.fields, { ...resource.defaults, ...req.body });
      const names = Object.keys(values);
      const item = await withTransaction(async (client) => {
        const result = await client.query(
          `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
           RETURNING ${columns}`,
          names.map((name) => values[name])
        );
        const row = result.rows[0];
        await logAdminAction(client, req, `${resource.target}.create`, resource.target, row.id, {});
        return row;
      });
      return res.status(201).json({ success: true, data: { item } });
    } catch (error) {
      return handleError(error, res, next);
    }
  }

  async function update(req, res, next) {
    try {
      const id = parseId(req.params.id);
      if (!id) return sendError(res, 400, 'INVALID_ID', 'Identifiant invalide.');
      const changes = validateFields(resource.fields, req.body, { partial: true });
      const names = Object.keys(changes);

      // Modifier le contenu annule la vérification et retire la publication.
      const item = await withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE ${table}
           SET ${names.map((name, i) => `${name} = $${i + 2}`).join(', ')},
               verified_at = NULL, verified_by = NULL,
               status = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
               updated_at = NOW()
           WHERE id = $1
           RETURNING ${columns}`,
          [id, ...names.map((name) => changes[name])]
        );
        if (!result.rows[0]) return null;
        await logAdminAction(client, req, `${resource.target}.update`, resource.target, id, { fields: names });
        return result.rows[0];
      });
      if (!item) return sendError(res, 404, 'NOT_FOUND', resource.notFound);
      return res.status(200).json({ success: true, data: { item } });
    } catch (error) {
      return handleError(error, res, next);
    }
  }

  async function verify(req, res, next) {
    try {
      const id = parseId(req.params.id);
      if (!id) return sendError(res, 400, 'INVALID_ID', 'Identifiant invalide.');
      const current = await pool.query(`SELECT ${columns} FROM ${table} WHERE id = $1`, [id]);
      if (!current.rows[0]) return sendError(res, 404, 'NOT_FOUND', resource.notFound);
      const missing = resource.missingForPublication(current.rows[0]);
      if (missing.length) {
        return sendError(res, 409, 'INCOMPLETE', `Vérification impossible, à compléter : ${missing.join(', ')}.`);
      }
      const item = await withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE ${table} SET verified_at = NOW(), verified_by = $2 WHERE id = $1 RETURNING ${columns}`,
          [id, req.user.id]
        );
        await logAdminAction(client, req, `${resource.target}.verify`, resource.target, id, {});
        return result.rows[0];
      });
      return res.status(200).json({ success: true, data: { item } });
    } catch (error) {
      return next(error);
    }
  }

  async function setStatus(req, res, next) {
    try {
      const id = parseId(req.params.id);
      if (!id) return sendError(res, 400, 'INVALID_ID', 'Identifiant invalide.');
      const status = req.body?.status;
      if (!STATUSES.includes(status)) return sendError(res, 400, 'INVALID_STATUS', 'Statut invalide.');

      const current = await pool.query(`SELECT ${columns} FROM ${table} WHERE id = $1`, [id]);
      const row = current.rows[0];
      if (!row) return sendError(res, 404, 'NOT_FOUND', resource.notFound);
      if (status === 'published' && (!row.verified_at || resource.missingForPublication(row).length)) {
        return sendError(res, 409, 'NOT_VERIFIED', 'Vérifiez ce contenu avant de le publier.');
      }

      const item = await withTransaction(async (client) => {
        const result = await client.query(
          `UPDATE ${table} SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING ${columns}`,
          [id, status]
        );
        await logAdminAction(client, req, `${resource.target}.status`, resource.target, id, { status });
        return result.rows[0];
      });
      return res.status(200).json({ success: true, data: { item } });
    } catch (error) {
      return next(error);
    }
  }

  return { list, create, update, verify, setStatus };
}

// ---------------------------------------------------------------------------
// Parrainage (réglages)
// ---------------------------------------------------------------------------

const SETTINGS_FIELDS = {
  referral_url: field.url('Lien de parrainage'),
  referral_terms_url: field.url('Conditions officielles du programme'),
  referral_terms_checked_at: field.date('Conditions vérifiées le'),
  referral_rate_text: field.text('Rémunération annoncée', { max: 300 }),
  referral_min_age: field.int('Âge minimum', { min: 10, max: 99 }),
};

async function readSettings() {
  const result = await pool.query('SELECT key, value FROM site_settings WHERE key = ANY($1::text[])', [Object.keys(SETTINGS_FIELDS)]);
  const settings = Object.fromEntries(Object.keys(SETTINGS_FIELDS).map((key) => [key, null]));
  for (const row of result.rows) settings[row.key] = row.value;
  if (settings.referral_min_age !== null) settings.referral_min_age = Number(settings.referral_min_age);
  return settings;
}

/** Le lien n'est montré qu'une fois configuré ET ses conditions vérifiées. */
function isReferralReady(settings) {
  return Boolean(settings.referral_url && settings.referral_terms_url && settings.referral_terms_checked_at
    && settings.referral_min_age && settings.referral_rate_text);
}

async function getSettings(req, res, next) {
  try {
    const settings = await readSettings();
    return res.status(200).json({ success: true, data: { settings, referral_ready: isReferralReady(settings) } });
  } catch (error) {
    return next(error);
  }
}

async function updateSettings(req, res, next) {
  try {
    const changes = validateFields(SETTINGS_FIELDS, req.body, { partial: true });
    await withTransaction(async (client) => {
      for (const [key, value] of Object.entries(changes)) {
        await client.query(
          `INSERT INTO site_settings (key, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, value === null ? null : String(value), req.user.id]
        );
      }
      await logAdminAction(client, req, 'settings.update', 'site_settings', null, { keys: Object.keys(changes) });
    });
    const settings = await readSettings();
    return res.status(200).json({ success: true, data: { settings, referral_ready: isReferralReady(settings) } });
  } catch (error) {
    return handleError(error, res, next);
  }
}

// ---------------------------------------------------------------------------
// Lecture membre (éléments publiés uniquement)
// ---------------------------------------------------------------------------

async function listPublishedContent(req, res, next) {
  try {
    const kind = req.query.kind;
    if (kind !== undefined && !['guide', 'tutorial'].includes(kind)) {
      return sendError(res, 400, 'INVALID_KIND', 'Type de contenu invalide.');
    }
    const result = await pool.query(
      `SELECT id, kind, slug, title, summary, body, level, updated_at
       FROM learning_content
       WHERE status = 'published' AND verified_at IS NOT NULL AND ($1::text IS NULL OR kind = $1)
       ORDER BY kind, position, id
       LIMIT 200`,
      [kind ?? null]
    );
    return res.status(200).json({ success: true, data: { items: result.rows } });
  } catch (error) {
    return next(error);
  }
}

async function listPublishedOpportunities(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT id, name, advertiser, network, paid_action, payout_text, countries, min_age, restrictions,
              allowed_channels, forbidden_methods, url, is_affiliate, terms_url,
              to_char(conditions_checked_at, 'YYYY-MM-DD') AS conditions_checked_at
       FROM opportunities
       WHERE status = 'published' AND verified_at IS NOT NULL
       ORDER BY name, id
       LIMIT 200`
    );
    const items = result.rows.map((row) => ({ ...row, url: isSafeOfferUrl(row.url) ? row.url : null }));
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    return next(error);
  }
}

async function getReferral(req, res, next) {
  try {
    const settings = await readSettings();
    const ready = isReferralReady(settings);
    return res.status(200).json({
      success: true,
      data: {
        available: ready,
        url: ready ? settings.referral_url : null,
        rate_text: settings.referral_rate_text,
        terms_url: ready ? settings.referral_terms_url : null,
        terms_checked_at: ready ? settings.referral_terms_checked_at : null,
        min_age: ready ? settings.referral_min_age : null,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  content: adminHandlers('content'),
  opportunity: adminHandlers('opportunity'),
  getSettings,
  updateSettings,
  listPublishedContent,
  listPublishedOpportunities,
  getReferral,
  validateFields,
  FORBIDDEN_CLAIMS,
  RESOURCES,
};
