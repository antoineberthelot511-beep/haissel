const { pool } = require('../config/database');
const { sendError, parseId } = require('../utils/http');
const { getClientIp, anonymizeIp, hashIp } = require('../utils/network');
const { loadSession } = require('../services/session.service');
const { logger } = require('../utils/logger');
const { isSafeOfferUrl } = require('../services/affiliate.service');

/*
 * Liens publiés par l'administrateur.
 *
 * GET /api/links  -> liens actifs (utilisateur connecté)
 * GET /go/:id      -> enregistre le clic de l'utilisateur connecté (cookie de
 *                     session, envoyé par le navigateur lors de la navigation)
 *                     puis redirige vers l'URL stockée en base
 */

const CLICK_DEDUP_SECONDS = 30;

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return '';
  }
}

async function listLinks(req, res, next) {
  try {
    const result = await pool.query(
      `
        SELECT id, name, description, url, created_at
        FROM affiliate_links
        WHERE is_active = true
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `
    );

    const items = result.rows.map((link) => ({
      id: link.id,
      name: link.name,
      description: link.description,
      domain: domainOf(link.url),
      go_url: `/go/${link.id}`,
    }));

    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    return next(error);
  }
}

async function goToLink(req, res, next) {
  try {
    const linkId = parseId(req.params.id);
    const session = linkId ? await loadSession(req) : null;
    if (!linkId || !session || session.mfaPending) {
      // Non connecté : retour à l'accueil pour se connecter.
      return res.redirect(302, '/');
    }
    const userId = session.user.id;

    const result = await pool.query(
      `
        SELECT a.url
        FROM affiliate_links a, users u
        WHERE a.id = $1 AND a.is_active = true
          AND u.id = $2 AND u.is_active = true AND u.is_banned = false
      `,
      [linkId, userId]
    );
    const link = result.rows[0];
    if (!link || !isSafeOfferUrl(link.url)) {
      return sendError(res, 404, 'LINK_NOT_AVAILABLE', "Ce lien n'est plus disponible.");
    }

    // Un double-clic rapide du même utilisateur ne compte qu'une fois.
    const clientIp = getClientIp(req);
    await pool.query(
      `
        INSERT INTO clicks (user_id, affiliate_link_id, ip_address, ip_hash, user_agent, referrer, created_at)
        SELECT $1::int, $2::int, $3::text, $4::text, $5::text, $6::text, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM clicks
          WHERE user_id = $1::int AND affiliate_link_id = $2::int
            AND user_affiliate_code_id IS NULL
            AND created_at > NOW() - ($7::text || ' seconds')::interval
        )
      `,
      [
        userId,
        linkId,
        anonymizeIp(clientIp),
        hashIp(clientIp),
        (req.get('user-agent') || '').slice(0, 500) || null,
        (req.get('referer') || '').slice(0, 1000) || null,
        String(CLICK_DEDUP_SECONDS),
      ]
    );

    return res.redirect(302, link.url);
  } catch (error) {
    logger.error('Link redirect failed', { error: error.message });
    return next(error);
  }
}

module.exports = {
  listLinks,
  goToLink,
};
