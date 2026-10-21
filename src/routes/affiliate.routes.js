const express = require('express');
const {
  listAffiliateOffers,
  getMyAffiliateLink,
  getMyAffiliateStats,
  listMyConversions,
  getAffiliateRedirect,
} = require('../controllers/affiliate.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { redirectRateLimiter } = require('../middleware/rate-limit.middleware');
const { requireInternalAffiliation } = require('../middleware/feature.middleware');

const router = express.Router();

/*
 * Il n'existe volontairement AUCUNE route utilisateur de création de
 * conversion : les conversions proviennent uniquement du webhook signé
 * (/api/webhooks/affiliate/:provider) ou de l'administration locale.
 *
 * Ces quatre routes appartiennent au moteur d'affiliation interne, gelé par
 * défaut (ENABLE_INTERNAL_AFFILIATION). La garde est placée AVANT
 * l'authentification : une fonctionnalité désactivée répond 404 sans qu'il
 * soit utile de savoir qui demande.
 */
router.get('/offers', requireInternalAffiliation, authenticateToken, listAffiliateOffers);
router.post('/offers/:id/link', requireInternalAffiliation, authenticateToken, getMyAffiliateLink);
router.get('/stats', requireInternalAffiliation, authenticateToken, getMyAffiliateStats);
router.get('/conversions', requireInternalAffiliation, authenticateToken, listMyConversions);

/*
 * Alias historique des liens déjà partagés : /api/affiliate/HAI-XXXXXXXX.
 * Le format canonique est /r/HAI-XXXXXXXX.
 *
 * JAMAIS gelé : un lien déjà diffusé (message, réseau social, impression) doit
 * continuer de mener à sa destination, même si plus aucun code ne peut être
 * créé. Déclaré après les routes nommées ci-dessus, qui ont la priorité.
 */
router.get('/:code', redirectRateLimiter, getAffiliateRedirect);

module.exports = router;
