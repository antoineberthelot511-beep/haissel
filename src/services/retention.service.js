/**
 * Durées de conservation (RGPD art. 5-1-e, minimisation dans le temps).
 * Doivent rester alignées avec frontend/confidentialite.html.
 *
 *  - clics : IP et navigateur effacés après 6 mois (ip_hash conservé pour les statistiques) ;
 *  - journal de sécurité : supprimé après 12 mois (recommandation CNIL : 6 à 12 mois) ;
 *  - sessions et jetons expirés : supprimés dès qu'ils ne servent plus ;
 *  - messagerie avec l'équipe : conversation et messages supprimés 12 mois
 *    après le dernier échange ;
 *  - demandes du formulaire de contact : supprimées 12 mois après l'envoi ;
 *  - liens de l'équipe : clics suivis supprimés après 13 mois ; conversions
 *    gardées (comptabilité), IP hachée effacée après 13 mois ;
 *  - abonnements aux notifications : supprimés sans envoi réussi depuis 6 mois
 *    (jamais réussi et créé il y a plus de 6 mois, ou dernier succès il y a
 *    plus de 6 mois) ;
 *  - signalements de fiches : traités (« closed ») supprimés après 6 mois,
 *    les autres après 12 mois (la table n'a que created_at comme date) ;
 *  - compteurs de limitation : supprimés dès que leur fenêtre est passée
 *    (ils n'existent que sur Vercel, où les compteurs sont en base).
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
  ['team_conversations', `DELETE FROM conversations
                          WHERE member_id IS NOT NULL AND last_message_at < NOW() - INTERVAL '12 months'`],
  ['contact_requests', `DELETE FROM contact_requests WHERE created_at < NOW() - INTERVAL '12 months'`],
  ['offer_clicks', `DELETE FROM offer_clicks WHERE created_at < NOW() - INTERVAL '13 months'`],
  ['offer_conversions_ip', `UPDATE offer_conversions SET ip_hash = NULL
                            WHERE ip_hash IS NOT NULL AND created_at < NOW() - INTERVAL '13 months'`],
  ['push_subscriptions', `DELETE FROM push_subscriptions
                          WHERE (last_success_at IS NULL AND created_at < NOW() - INTERVAL '6 months')
                             OR last_success_at < NOW() - INTERVAL '6 months'`],
  ['member_offer_reports', `DELETE FROM member_offer_reports
                            WHERE (status = 'closed' AND created_at < NOW() - INTERVAL '6 months')
                               OR created_at < NOW() - INTERVAL '12 months'`],
  ['rate_limit_counters', `DELETE FROM rate_limit_counters WHERE expires_at < NOW() - INTERVAL '1 hour'`],
  ['login_throttle_failures', `DELETE FROM login_throttle_failures WHERE last_failure_at < NOW() - INTERVAL '1 day'`],
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
