const { pool } = require('../config/database');
const { sendError, parsePagination, parseId } = require('../utils/http');
const { getClientIp, anonymizeIp, hashIp } = require('../utils/network');
const { logger } = require('../utils/logger');
const {
  normalizeCode,
  isValidCode,
  isSafeOfferUrl,
  buildDestinationUrl,
  ensureUserAffiliateCode,
  findActiveCode,
  recordClick,
} = require('../services/affiliate.service');

/*
 * Toutes les statistiques sont calculées depuis les tables sources
 * (clicks, conversions, earnings) : elles ne peuvent pas diverger.
 *
 * - conversions = conversions au statut approved
 * - gains       = earnings pending (dus) + paid (versés), jamais cancelled
 */

function conversionRate(clicks, conversions) {
  return clicks > 0 ? Math.round((conversions / clicks) * 10000) / 100 : 0;
}

/**
 * GET /api/affiliate/offers — offres actives + code et stats de l'utilisateur.
 * Une seule requête SQL (pas de N+1), aucune écriture.
 */
async function listAffiliateOffers(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query, 50);
    const result = await pool.query(
      `
        SELECT a.id, a.name, a.description, a.created_at,
               uac.id AS code_id, uac.code,
               COALESCE(ck.total, 0)::int AS total_clicks,
               COALESCE(cv.approved, 0)::int AS total_conversions,
               COALESCE(cv.pending, 0)::int AS pending_conversions,
               COALESCE(er.earned, 0)::bigint AS total_amount_cents
        FROM affiliate_links a
        LEFT JOIN user_affiliate_codes uac
               ON uac.affiliate_link_id = a.id AND uac.user_id = $1
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS total FROM clicks WHERE user_affiliate_code_id = uac.id
        ) ck ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE status = 'approved') AS approved,
                 COUNT(*) FILTER (WHERE status = 'pending') AS pending
          FROM conversions WHERE user_affiliate_code_id = uac.id
        ) cv ON true
        LEFT JOIN LATERAL (
          SELECT SUM(amount_cents) FILTER (WHERE status IN ('pending', 'paid')) AS earned
          FROM earnings WHERE user_affiliate_code_id = uac.id
        ) er ON true
        WHERE a.is_active = true
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2 OFFSET $3
      `,
      [req.user.id, limit, offset]
    );

    const items = result.rows.map((row) => ({
      ...row,
      total_amount_cents: Number(row.total_amount_cents),
      conversion_rate: conversionRate(row.total_clicks, row.total_conversions),
    }));

    return res.status(200).json({
      success: true,
      data: { items, pagination: { page, limit } },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/affiliate/offers/:id/link — obtient (ou crée) le code personnel.
 */
async function getMyAffiliateLink(req, res, next) {
  try {
    const offerId = parseId(req.params.id);
    if (!offerId) return sendError(res, 400, 'INVALID_OFFER', 'Offre invalide.');

    const code = await ensureUserAffiliateCode(req.user.id, offerId);
    if (!code) {
      return sendError(res, 404, 'OFFER_NOT_AVAILABLE', "Cette offre n'est plus disponible.");
    }

    return res.status(200).json({
      success: true,
      data: { offer_id: offerId, code_id: code.id, code: code.code, path: `/r/${code.code}` },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/affiliate/stats — totaux et détail par code de l'utilisateur.
 */
async function getMyAffiliateStats(req, res, next) {
  try {
    const result = await pool.query(
      `
        SELECT uac.id AS code_id, uac.code, a.id AS offer_id, a.name AS offer_name,
               a.is_active AS offer_active,
               COALESCE(ck.total, 0)::int AS total_clicks,
               COALESCE(cv.approved, 0)::int AS total_conversions,
               COALESCE(cv.pending, 0)::int AS pending_conversions,
               COALESCE(er.earned, 0)::bigint AS total_amount_cents,
               COALESCE(er.paid, 0)::bigint AS paid_amount_cents
        FROM user_affiliate_codes uac
        INNER JOIN affiliate_links a ON a.id = uac.affiliate_link_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS total FROM clicks WHERE user_affiliate_code_id = uac.id
        ) ck ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE status = 'approved') AS approved,
                 COUNT(*) FILTER (WHERE status = 'pending') AS pending
          FROM conversions WHERE user_affiliate_code_id = uac.id
        ) cv ON true
        LEFT JOIN LATERAL (
          SELECT SUM(amount_cents) FILTER (WHERE status IN ('pending', 'paid')) AS earned,
                 SUM(amount_cents) FILTER (WHERE status = 'paid') AS paid
          FROM earnings WHERE user_affiliate_code_id = uac.id
        ) er ON true
        WHERE uac.user_id = $1
        ORDER BY uac.created_at DESC
      `,
      [req.user.id]
    );

    const codes = result.rows.map((row) => ({
      ...row,
      total_amount_cents: Number(row.total_amount_cents),
      paid_amount_cents: Number(row.paid_amount_cents),
      conversion_rate: conversionRate(row.total_clicks, row.total_conversions),
    }));

    const sum = (key) => codes.reduce((total, row) => total + Number(row[key] || 0), 0);
    const totalClicks = sum('total_clicks');
    const totalConversions = sum('total_conversions');

    return res.status(200).json({
      success: true,
      data: {
        codes,
        total_clicks: totalClicks,
        total_conversions: totalConversions,
        pending_conversions: sum('pending_conversions'),
        total_earnings: sum('total_amount_cents'),
        paid_earnings: sum('paid_amount_cents'),
        conversion_rate: conversionRate(totalClicks, totalConversions),
      },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/affiliate/conversions — historique des conversions de l'utilisateur.
 */
async function listMyConversions(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query, 50);
    const result = await pool.query(
      `
        SELECT c.id, a.name AS offer_name, uac.code, c.status, c.amount_cents, c.currency,
               c.created_at, c.processed_at, e.status AS earning_status
        FROM conversions c
        INNER JOIN affiliate_links a ON a.id = c.affiliate_link_id
        LEFT JOIN user_affiliate_codes uac ON uac.id = c.user_affiliate_code_id
        LEFT JOIN earnings e ON e.conversion_id = c.id
        WHERE c.user_id = $1
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2 OFFSET $3
      `,
      [req.user.id, limit, offset]
    );

    return res.status(200).json({
      success: true,
      data: { items: result.rows, pagination: { page, limit } },
    });
  } catch (error) {
    return next(error);
  }
}

const UNAVAILABLE_PAGE = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Offre indisponible | Haissel</title></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#1e2235">
<main style="text-align:center;max-width:28rem;padding:1.5rem"><h1 style="font-size:1.4rem">Cette offre n'est plus disponible.</h1>
<p>Le lien que vous avez suivi est invalide ou l'offre a été désactivée.</p></main></body></html>`;

function sendUnavailable(res) {
  return res.status(404).type('html').send(UNAVAILABLE_PAGE);
}

/**
 * GET /r/:code (et alias historique GET /api/affiliate/:code)
 * Enregistre le clic côté serveur puis redirige vers l'URL de l'offre,
 * qui provient exclusivement de la base (pas d'open redirect).
 */
async function getAffiliateRedirect(req, res, next) {
  try {
    const code = normalizeCode(req.params.code);
    if (!isValidCode(code)) return sendUnavailable(res);

    const codeRow = await findActiveCode(code);
    if (!codeRow) return sendUnavailable(res);

    if (!isSafeOfferUrl(codeRow.url)) {
      logger.error('Offer has an unsafe destination URL', { offerId: codeRow.affiliate_link_id });
      return sendUnavailable(res);
    }

    const clientIp = getClientIp(req);
    const { clickId } = await recordClick({
      codeRow,
      ipHash: hashIp(clientIp),
      ipAddress: anonymizeIp(clientIp),
      userAgent: (req.get('user-agent') || '').slice(0, 500) || null,
      referrer: (req.get('referer') || '').slice(0, 1000) || null,
    });

    const destination = buildDestinationUrl(codeRow.url, { clickId, code });
    if (!isSafeOfferUrl(destination)) return sendUnavailable(res);

    return res.redirect(302, destination);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listAffiliateOffers,
  getMyAffiliateLink,
  getMyAffiliateStats,
  listMyConversions,
  getAffiliateRedirect,
};
