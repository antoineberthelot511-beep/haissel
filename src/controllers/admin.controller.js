const { pool, withTransaction } = require('../config/database');
const { sendError, parsePagination, parseId } = require('../utils/http');
const { logger } = require('../utils/logger');
const { isSafeOfferUrl } = require('../services/affiliate.service');
const {
  recordConversion,
  updateConversionStatus,
  ConversionError,
  CONVERSION_STATUSES,
  EARNING_STATUSES,
} = require('../services/conversion.service');

/*
 * Toutes ces routes sont montées derrière :
 *   requireLocalAdmin -> authenticateToken -> ensureAdmin
 * Chaque action modifiant des données est journalisée dans admin_actions.
 */

async function logAdminAction(client, req, action, targetType, targetId, details = {}) {
  await client.query(
    `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.user.id, action, targetType, targetId, JSON.stringify(details)]
  );
  logger.info('Admin action', { adminId: req.user.id, action, targetType, targetId });
}

function handleConversionError(error, res, next) {
  if (error instanceof ConversionError) {
    return sendError(res, error.status, error.code, error.message);
  }
  return next(error);
}

function rate(clicks, conversions) {
  return clicks > 0 ? Math.round((conversions / clicks) * 10000) / 100 : 0;
}

// ---------------------------------------------------------------------------
// Vue d'ensemble
// ---------------------------------------------------------------------------

async function getAdminOverview(req, res, next) {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int AS total_users,
        (SELECT COUNT(*) FROM users WHERE is_active AND NOT is_banned)::int AS active_users,
        (SELECT COUNT(*) FROM users WHERE NOT is_active)::int AS suspended_users,
        (SELECT COUNT(*) FROM users WHERE is_banned)::int AS banned_users,
        (SELECT COUNT(*) FROM affiliate_links)::int AS total_offers,
        (SELECT COUNT(*) FROM affiliate_links WHERE is_active)::int AS active_offers,
        (SELECT COUNT(*) FROM clicks)::int AS total_clicks,
        (SELECT COUNT(*) FROM conversions WHERE status = 'approved')::int AS total_conversions,
        (SELECT COUNT(*) FROM conversions WHERE status = 'pending')::int AS pending_conversions,
        (SELECT COUNT(*) FROM conversions WHERE status IN ('rejected', 'cancelled'))::int AS rejected_conversions,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM earnings WHERE status IN ('pending', 'paid'))::bigint AS total_earnings_cents,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM earnings WHERE status = 'pending')::bigint AS pending_earnings_cents,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM earnings WHERE status = 'paid')::bigint AS paid_earnings_cents,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM earnings WHERE status = 'cancelled')::bigint AS cancelled_earnings_cents
    `);

    const data = result.rows[0];
    for (const key of Object.keys(data)) data[key] = Number(data[key]);
    data.conversion_rate = rate(data.total_clicks, data.total_conversions);

    return res.status(200).json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Utilisateurs
// ---------------------------------------------------------------------------

const USER_STATUS_FILTERS = {
  all: 'true',
  active: 'u.is_active AND NOT u.is_banned',
  suspended: 'NOT u.is_active',
  banned: 'u.is_banned',
};

async function listUsers(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const statusFilter = USER_STATUS_FILTERS[req.query.status] || USER_STATUS_FILTERS.all;
    // Les caractères spéciaux de LIKE sont échappés : la recherche est littérale.
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

    const result = await pool.query(
      `
        SELECT u.id, u.username, u.email, u.display_name, u.created_at, u.updated_at,
               u.is_active, u.is_banned, COALESCE(a.role, 'USER') AS role,
               COUNT(*) OVER()::int AS total_count
        FROM users u
        LEFT JOIN admins a ON a.user_id = u.id
        WHERE ($1 = '' OR u.username ILIKE $2 OR u.email ILIKE $2 OR u.display_name ILIKE $2)
          AND ${statusFilter}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT $3 OFFSET $4
      `,
      [search, pattern, limit, offset]
    );

    const total = result.rows[0]?.total_count || 0;
    const users = result.rows.map(({ total_count: _total, ...user }) => user);

    return res.status(200).json({
      success: true,
      data: { users, pagination: { page, limit, total } },
    });
  } catch (error) {
    return next(error);
  }
}

const USER_ACTIONS = {
  suspend: { is_active: false },
  activate: { is_active: true },
  ban: { is_banned: true },
  unban: { is_banned: false },
};

async function updateUserStatus(req, res, next) {
  try {
    const userId = parseId(req.params.id);
    if (!userId) return sendError(res, 400, 'INVALID_USER', 'Utilisateur invalide.');

    const body = req.body || {};
    let changes = USER_ACTIONS[body.action];
    if (!changes) {
      // Format historique : { is_active?: boolean, is_banned?: boolean }
      changes = {};
      if (typeof body.is_active === 'boolean') changes.is_active = body.is_active;
      if (typeof body.is_banned === 'boolean') changes.is_banned = body.is_banned;
    }
    if (Object.keys(changes).length === 0) {
      return sendError(res, 400, 'INVALID_STATUS', 'Action invalide (suspend, activate, ban ou unban).');
    }

    const restricts = changes.is_active === false || changes.is_banned === true;
    if (restricts && userId === req.user.id) {
      return sendError(res, 409, 'CANNOT_DISABLE_SELF', 'Vous ne pouvez pas suspendre ou bannir votre propre compte.');
    }

    const user = await withTransaction(async (client) => {
      const updated = await client.query(
        `
          UPDATE users
          SET is_active = COALESCE($2, is_active),
              is_banned = COALESCE($3, is_banned),
              updated_at = NOW()
          WHERE id = $1
          RETURNING id, username, email, display_name, created_at, updated_at, is_active, is_banned
        `,
        [userId, changes.is_active ?? null, changes.is_banned ?? null]
      );
      if (updated.rows.length === 0) return null;

      // Suspension / bannissement : toutes les sessions sont révoquées.
      if (restricts) {
        await client.query(
          'UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
          [userId]
        );
      }

      await logAdminAction(client, req, 'user.status', 'user', userId, changes);
      return updated.rows[0];
    });

    if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');

    return res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Offres
// ---------------------------------------------------------------------------

function validateOffer(body, { partial = false } = {}) {
  const changes = {};
  const source = body || {};

  if (!partial || source.name !== undefined) {
    if (typeof source.name !== 'string' || source.name.trim().length < 2 || source.name.trim().length > 120) {
      return { error: ['INVALID_NAME', "Le nom de l'offre doit contenir entre 2 et 120 caractères."] };
    }
    changes.name = source.name.trim();
  }

  if (!partial || source.url !== undefined) {
    if (!isSafeOfferUrl(source.url)) {
      return { error: ['INVALID_URL', "L'URL doit être une adresse http(s) valide."] };
    }
    changes.url = source.url.trim();
  }

  if (source.description !== undefined && source.description !== null) {
    if (typeof source.description !== 'string' || source.description.length > 1000) {
      return { error: ['INVALID_DESCRIPTION', 'La description ne doit pas dépasser 1000 caractères.'] };
    }
    changes.description = source.description.trim() || null;
  }

  if (source.is_active !== undefined) {
    if (typeof source.is_active !== 'boolean') {
      return { error: ['INVALID_STATUS', 'is_active doit être un booléen.'] };
    }
    changes.is_active = source.is_active;
  }

  if (partial && Object.keys(changes).length === 0) {
    return { error: ['INVALID_REQUEST', 'Aucune modification fournie.'] };
  }

  return { changes };
}

async function listAffiliateLinks(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const result = await pool.query(
      `
        SELECT a.id, a.name, a.url, a.description, a.is_active, a.created_at, a.updated_at,
               (SELECT COUNT(*) FROM user_affiliate_codes WHERE affiliate_link_id = a.id)::int AS total_affiliates,
               (SELECT COUNT(*) FROM clicks WHERE affiliate_link_id = a.id)::int AS total_clicks,
               (SELECT COUNT(*) FROM conversions WHERE affiliate_link_id = a.id AND status = 'approved')::int AS total_conversions,
               (SELECT COALESCE(SUM(amount_cents), 0) FROM earnings
                 WHERE affiliate_link_id = a.id AND status IN ('pending', 'paid'))::bigint AS total_earnings_cents,
               COUNT(*) OVER()::int AS total_count
        FROM affiliate_links a
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const total = result.rows[0]?.total_count || 0;
    const items = result.rows.map(({ total_count: _total, ...offer }) => ({
      ...offer,
      total_earnings_cents: Number(offer.total_earnings_cents),
    }));

    return res.status(200).json({
      success: true,
      data: { items, pagination: { page, limit, total } },
    });
  } catch (error) {
    return next(error);
  }
}

async function createAffiliateLink(req, res, next) {
  try {
    const { error, changes } = validateOffer(req.body);
    if (error) return sendError(res, 400, error[0], error[1]);

    const offer = await withTransaction(async (client) => {
      const result = await client.query(
        `
          INSERT INTO affiliate_links (name, url, description, is_active, created_at, updated_at)
          VALUES ($1, $2, $3, COALESCE($4, true), NOW(), NOW())
          RETURNING id, name, url, description, is_active, created_at, updated_at
        `,
        [changes.name, changes.url, changes.description ?? null, changes.is_active ?? null]
      );
      await logAdminAction(client, req, 'offer.create', 'offer', result.rows[0].id, { name: changes.name });
      return result.rows[0];
    });

    return res.status(201).json({ success: true, data: { offer } });
  } catch (error) {
    return next(error);
  }
}

async function updateAffiliateLink(req, res, next) {
  try {
    const offerId = parseId(req.params.id);
    if (!offerId) return sendError(res, 400, 'INVALID_OFFER', 'Offre invalide.');

    const { error, changes } = validateOffer(req.body, { partial: true });
    if (error) return sendError(res, 400, error[0], error[1]);

    const offer = await withTransaction(async (client) => {
      const result = await client.query(
        `
          UPDATE affiliate_links
          SET name = COALESCE($2, name),
              url = COALESCE($3, url),
              description = CASE WHEN $4::boolean THEN $5 ELSE description END,
              is_active = COALESCE($6, is_active),
              updated_at = NOW()
          WHERE id = $1
          RETURNING id, name, url, description, is_active, created_at, updated_at
        `,
        [
          offerId,
          changes.name ?? null,
          changes.url ?? null,
          Object.prototype.hasOwnProperty.call(changes, 'description'),
          changes.description ?? null,
          changes.is_active ?? null,
        ]
      );
      if (result.rows.length === 0) return null;
      await logAdminAction(client, req, 'offer.update', 'offer', offerId, changes);
      return result.rows[0];
    });

    if (!offer) return sendError(res, 404, 'OFFER_NOT_FOUND', 'Offre introuvable.');
    return res.status(200).json({ success: true, data: { offer } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Clics
// ---------------------------------------------------------------------------

async function listClicks(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const offerId = req.query.offer_id ? parseId(String(req.query.offer_id)) : null;

    const result = await pool.query(
      `
        SELECT c.id, c.created_at, c.ip_address, c.referrer, c.user_agent,
               u.username, a.name AS offer_name, uac.code,
               COUNT(*) OVER()::int AS total_count
        FROM clicks c
        INNER JOIN affiliate_links a ON a.id = c.affiliate_link_id
        LEFT JOIN users u ON u.id = c.user_id
        LEFT JOIN user_affiliate_codes uac ON uac.id = c.user_affiliate_code_id
        WHERE ($1::int IS NULL OR c.affiliate_link_id = $1)
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2 OFFSET $3
      `,
      [offerId, limit, offset]
    );

    const total = result.rows[0]?.total_count || 0;
    const items = result.rows.map(({ total_count: _total, ...row }) => row);
    return res.status(200).json({ success: true, data: { items, pagination: { page, limit, total } } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

async function listConversions(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const status = CONVERSION_STATUSES.includes(req.query.status) ? req.query.status : null;
    const offerId = req.query.offer_id ? parseId(String(req.query.offer_id)) : null;
    const user = String(req.query.user || '').trim().toLowerCase().slice(0, 100) || null;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    const result = await pool.query(
      `
        SELECT c.id, c.user_id, u.username, u.display_name, a.id AS offer_id, a.name AS offer_name,
               uac.code, c.provider, c.external_reference, c.amount_cents, c.currency, c.status,
               c.click_id, c.created_at, c.processed_at, e.status AS earning_status,
               COUNT(*) OVER()::int AS total_count
        FROM conversions c
        INNER JOIN affiliate_links a ON a.id = c.affiliate_link_id
        INNER JOIN users u ON u.id = c.user_id
        LEFT JOIN user_affiliate_codes uac ON uac.id = c.user_affiliate_code_id
        LEFT JOIN earnings e ON e.conversion_id = c.id
        WHERE ($1::text IS NULL OR c.status = $1)
          AND ($2::int IS NULL OR c.affiliate_link_id = $2)
          AND ($3::text IS NULL OR u.username = $3 OR u.email = $3)
          AND ($4::date IS NULL OR c.created_at >= $4::date)
          AND ($5::date IS NULL OR c.created_at < $5::date + INTERVAL '1 day')
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $6 OFFSET $7
      `,
      [status, offerId, user, from, to, limit, offset]
    );

    const total = result.rows[0]?.total_count || 0;
    const items = result.rows.map(({ total_count: _total, ...row }) => row);
    return res.status(200).json({ success: true, data: { items, pagination: { page, limit, total } } });
  } catch (error) {
    return next(error);
  }
}

/**
 * Saisie manuelle d'une conversion confirmée par un partenaire hors webhook
 * (ex. relevé envoyé par e-mail). Réservée à l'admin local, journalisée,
 * soumise aux mêmes règles d'idempotence (fournisseur "manual").
 */
async function createManualConversion(req, res, next) {
  try {
    const body = req.body || {};
    const { conversion, created } = await recordConversion({
      provider: 'manual',
      external_reference: body.external_reference,
      code: body.code,
      amount_cents: body.amount_cents,
      currency: body.currency,
      status: body.status || 'pending',
      click_id: body.click_id,
    });

    await withTransaction((client) => logAdminAction(
      client, req, 'conversion.manual', 'conversion', conversion.id,
      { external_reference: conversion.external_reference, amount_cents: conversion.amount_cents, created }
    ));

    return res.status(created ? 201 : 200).json({ success: true, data: { conversion, created } });
  } catch (error) {
    return handleConversionError(error, res, next);
  }
}

async function changeConversionStatus(req, res, next) {
  try {
    const conversionId = parseId(req.params.id);
    if (!conversionId) return sendError(res, 400, 'INVALID_CONVERSION', 'Conversion invalide.');

    const status = String((req.body || {}).status || '');
    const { conversion } = await updateConversionStatus(conversionId, status, req.user.id);
    logger.info('Admin action', { adminId: req.user.id, action: 'conversion.status', conversionId, status });

    return res.status(200).json({ success: true, data: { conversion } });
  } catch (error) {
    return handleConversionError(error, res, next);
  }
}

// ---------------------------------------------------------------------------
// Gains
// ---------------------------------------------------------------------------

async function listEarnings(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const status = EARNING_STATUSES.includes(req.query.status) ? req.query.status : null;

    const [list, totals] = await Promise.all([
      pool.query(
        `
          SELECT e.id, e.conversion_id, e.amount_cents, e.currency, e.status, e.created_at, e.paid_at,
                 u.username, u.display_name, a.name AS offer_name, c.external_reference,
                 COUNT(*) OVER()::int AS total_count
          FROM earnings e
          INNER JOIN users u ON u.id = e.user_id
          INNER JOIN affiliate_links a ON a.id = e.affiliate_link_id
          LEFT JOIN conversions c ON c.id = e.conversion_id
          WHERE ($1::text IS NULL OR e.status = $1)
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $2 OFFSET $3
        `,
        [status, limit, offset]
      ),
      pool.query(`
        SELECT status, COALESCE(SUM(amount_cents), 0)::bigint AS amount_cents, COUNT(*)::int AS count
        FROM earnings GROUP BY status
      `),
    ]);

    const summary = { pending: 0, paid: 0, cancelled: 0 };
    for (const row of totals.rows) summary[row.status] = Number(row.amount_cents);
    summary.total = summary.pending + summary.paid;

    const total = list.rows[0]?.total_count || 0;
    const items = list.rows.map(({ total_count: _total, ...row }) => row);
    return res.status(200).json({
      success: true,
      data: { items, summary, pagination: { page, limit, total } },
    });
  } catch (error) {
    return next(error);
  }
}

async function markEarningPaid(req, res, next) {
  try {
    const earningId = parseId(req.params.id);
    if (!earningId) return sendError(res, 400, 'INVALID_EARNING', 'Gain invalide.');

    const earning = await withTransaction(async (client) => {
      const result = await client.query(
        `
          UPDATE earnings SET status = 'paid', paid_at = NOW()
          WHERE id = $1 AND status = 'pending'
          RETURNING id, conversion_id, amount_cents, currency, status, paid_at
        `,
        [earningId]
      );
      if (result.rows.length === 0) return null;
      await logAdminAction(client, req, 'earning.paid', 'earning', earningId, { amount_cents: result.rows[0].amount_cents });
      return result.rows[0];
    });

    if (!earning) {
      return sendError(res, 409, 'EARNING_NOT_PAYABLE', 'Ce gain est introuvable ou n’est pas en attente de paiement.');
    }
    return res.status(200).json({ success: true, data: { earning } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

async function listAdminActions(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const result = await pool.query(
      `
        SELECT aa.id, aa.action, aa.target_type, aa.target_id, aa.details, aa.created_at, u.username AS admin_username
        FROM admin_actions aa
        LEFT JOIN users u ON u.id = aa.admin_user_id
        ORDER BY aa.created_at DESC, aa.id DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );
    return res.status(200).json({ success: true, data: { items: result.rows, pagination: { page, limit } } });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAdminOverview,
  listUsers,
  updateUserStatus,
  listAffiliateLinks,
  createAffiliateLink,
  updateAffiliateLink,
  listClicks,
  listConversions,
  createManualConversion,
  changeConversionStatus,
  listEarnings,
  markEarningPaid,
  listAdminActions,
};
