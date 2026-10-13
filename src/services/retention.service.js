/**
 * Durées de conservation (RGPD art. 5-1-e, minimisation dans le temps).
 * Doivent rester alignées avec frontend/confidentialite.html.
 *
 *  - clics : IP et navigateur effacés après 6 mois (ip_hash conservé pour les statistiques) ;
 *  - journal de sécurité : supprimé après 12 mois (recommandation CNIL : 6 à 12 mois) ;
 *  - sessions et jetons expirés : supprimés dès qu'ils ne servent plus.
 */
const { pool } = require('../config/database');
const { logger } = require('../utils/logger');

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const PURGE_QUERIES = [
  ['clicks', `UPDATE clicks SET ip_address = NULL, user_agent = NULL, referrer = NULL
              WHERE created_at < NOW() - INTERVAL '6 months'
                AND (ip_address IS NOT NULL OR user_agent IS NOT NULL OR referrer IS NOT NULL)`],
  ['security_events', `DELETE FROM security_events WHERE created_at < NOW() - INTERVAL '12 months'`],
  ['sessions', `DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day' OR revoked_at < NOW() - INTERVAL '1 day'`],
  ['auth_tokens', `DELETE FROM auth_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`],
];

async function purgeExpiredData() {
  for (const [name, sql] of PURGE_QUERIES) {
    try {
      const { rowCount } = await pool.query(sql);
      if (rowCount) logger.info(`Retention: ${rowCount} row(s) purged in ${name}`);
    } catch (error) {
      logger.error(`Retention purge failed for ${name}`, { error: error.message });
    }
  }
}

function startRetentionJob() {
  purgeExpiredData();
  const timer = setInterval(purgeExpiredData, PURGE_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { purgeExpiredData, startRetentionJob };
