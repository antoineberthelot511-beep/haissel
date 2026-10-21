const { isInternalAffiliationEnabled } = require('../config/security');
const { sendError } = require('../utils/http');

/*
 * Fonctionnalités gelées : la route existe toujours dans le code, mais elle
 * répond 404 tant que son drapeau n'est pas activé. 404 plutôt que 403 : pour
 * un appelant extérieur, la fonctionnalité n'existe pas, et l'existence d'un
 * moteur d'affiliation interne n'a pas à être annoncée.
 *
 * Le code FEATURE_DISABLED distingue ce cas du NOT_FOUND générique : un
 * administrateur qui lit les journaux voit immédiatement qu'il s'agit d'un
 * drapeau à activer, pas d'une URL erronée.
 */
function requireInternalAffiliation(req, res, next) {
  if (!isInternalAffiliationEnabled()) {
    return sendError(
      res,
      404,
      'FEATURE_DISABLED',
      "Le moteur d'affiliation interne est désactivé sur cette instance."
    );
  }
  return next();
}

module.exports = { requireInternalAffiliation };
