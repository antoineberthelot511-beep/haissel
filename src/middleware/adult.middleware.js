const { sendError } = require('../utils/http');
const { isAdult, needsDeclaration } = require('../services/adult.service');

/*
 * Réserve une route aux membres ayant déclaré 18 ans ou plus.
 * À placer APRÈS authenticateToken : req.user doit exister.
 *
 * 403 et non 404 : la fonctionnalité existe, elle est simplement interdite à
 * ce membre, et le message doit le lui expliquer sans ambiguïté.
 */
function requireAdult(req, res, next) {
  if (needsDeclaration(req.user)) {
    return sendError(res, 403, 'ADULT_DECLARATION_REQUIRED',
      'Réponds d’abord à la question sur ton âge pour accéder à cette partie du site.');
  }
  if (!isAdult(req.user)) {
    return sendError(res, 403, 'ADULT_REQUIRED',
      'Cette partie du site est réservée aux membres de 18 ans ou plus, '
      + 'car elle mène à un compte éditeur MyLead. '
      + 'Les guides de l’espace Apprendre restent accessibles.');
  }
  return next();
}

module.exports = { requireAdult };
