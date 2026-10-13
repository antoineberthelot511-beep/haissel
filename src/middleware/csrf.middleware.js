const { sendError } = require('../utils/http');
const { logger } = require('../utils/logger');

/*
 * Défense CSRF globale pour les requêtes qui modifient l'état.
 *
 * 1. Fetch Metadata : un navigateur moderne envoie Sec-Fetch-Site ; une
 *    requête provenant d'un autre site (« cross-site ») est refusée.
 * 2. Origin : s'il est présent, il doit correspondre exactement à l'origine
 *    du serveur.
 * 3. Les routes authentifiées exigent EN PLUS le jeton X-CSRF-Token lié à la
 *    session (voir auth.middleware) ; le cookie est SameSite=Lax.
 *
 * Les clients non navigateurs (sans Origin ni Sec-Fetch-Site) ne portent pas
 * le cookie d'une victime : ils ne permettent pas d'attaque CSRF.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfOriginCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    logger.warn('Cross-site request rejected', { path: req.originalUrl, fetchSite });
    return sendError(res, 403, 'CSRF_REJECTED', 'Requête refusée.');
  }

  const origin = req.get('origin');
  if (origin) {
    const expected = `${req.protocol}://${req.get('host')}`;
    if (origin !== expected) {
      logger.warn('Foreign origin rejected', { path: req.originalUrl });
      return sendError(res, 403, 'CSRF_REJECTED', 'Requête refusée.');
    }
  }

  return next();
}

module.exports = { csrfOriginCheck };
