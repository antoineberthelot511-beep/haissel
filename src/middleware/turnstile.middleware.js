const { sendError } = require('../utils/http');
const { isProduction } = require('../config/security');
const { getClientIp } = require('../utils/network');
const turnstile = require('../services/turnstile.service');
const { logSecurityEvent } = require('../services/security-log.service');
const { logger } = require('../utils/logger');

/*
 * Exige un jeton Turnstile valide avant de traiter la demande.
 * Le jeton est lu dans le champ « cf_turnstile_response » du corps JSON.
 * Il n'est jamais journalisé.
 *
 * La clé SECRÈTE n'est lue que par turnstile.service, côté serveur, et n'est
 * jamais transmise au navigateur : /api/auth/config n'expose que la clé
 * publique du site.
 *
 * CONFIGURATION MANQUANTE :
 *   - en production, la protection ne peut pas être silencieusement absente
 *     sur un formulaire public. La demande est refusée (503) avec un message
 *     explicite, plutôt que laissée passer sans vérification ;
 *   - hors production (développement local, tests), l'absence de clés laisse
 *     simplement passer : sans navigateur, aucun jeton ne peut être produit.
 */
function requireTurnstile(action) {
  return async function checkTurnstile(req, res, next) {
    if (!turnstile.isTurnstileEnabled()) {
      if (isProduction()) {
        logger.error('Turnstile not configured in production: request refused', { path: req.originalUrl });
        return sendError(res, 503, 'TURNSTILE_NOT_CONFIGURED',
          'La vérification anti-robot n’est pas configurée sur ce serveur. '
          + 'Par sécurité, cette action est momentanément indisponible. '
          + 'Contactez l’administrateur du site.');
      }
      return next();
    }

    try {
      const token = (req.body || {}).cf_turnstile_response;
      if (typeof token !== 'string' || !token) {
        return sendError(res, 400, 'TURNSTILE_REQUIRED', 'Validez la vérification anti-robot avant de continuer.');
      }

      const { success, errorCodes } = await turnstile.verifyTurnstileToken(token, {
        remoteIp: getClientIp(req) || undefined,
        expectedAction: action,
      });
      if (success) return next();

      await logSecurityEvent('turnstile_failed', { req, details: { action, errors: errorCodes.slice(0, 5) } });

      if (errorCodes.includes('internal-error')) {
        return sendError(res, 503, 'TURNSTILE_UNAVAILABLE', 'La vérification anti-robot est momentanément indisponible. Réessayez dans un instant.');
      }
      if (errorCodes.includes('timeout-or-duplicate')) {
        return sendError(res, 403, 'TURNSTILE_EXPIRED', 'La vérification anti-robot a expiré ou a déjà servi. Refaites-la puis réessayez.');
      }
      return sendError(res, 403, 'TURNSTILE_FAILED', 'La vérification anti-robot a échoué. Refaites-la puis réessayez.');
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { requireTurnstile };
