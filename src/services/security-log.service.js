const { pool } = require('../config/database');
const { logger } = require('../utils/logger');
const { getClientIp, anonymizeIp } = require('../utils/network');

/*
 * Journal des événements de sécurité (table security_events + journal
 * serveur). Ne JAMAIS y passer : mot de passe, cookie, jeton, secret TOTP.
 * L'IP est tronquée, l'user-agent raccourci.
 */
async function logSecurityEvent(event, { req, userId = null, details = {} } = {}) {
  const ip = req ? anonymizeIp(getClientIp(req)) : null;
  const userAgent = req ? (req.get('user-agent') || '').slice(0, 200) || null : null;

  logger.info(`Security event: ${event}`, { userId, ip, ...details });

  try {
    await pool.query(
      `INSERT INTO security_events (user_id, event, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, event, ip, userAgent, JSON.stringify(details)]
    );
  } catch (error) {
    // Le journal ne doit jamais faire échouer l'action principale.
    logger.error('Could not store security event', { event, error: error.message });
  }
}

module.exports = { logSecurityEvent };
