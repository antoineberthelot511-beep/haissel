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

const router = express.Router();

/*
 * Il n'existe volontairement AUCUNE route utilisateur de création de
 * conversion : les conversions proviennent uniquement du webhook signé
 * (/api/webhooks/affiliate/:provider) ou de l'administration locale.
 */
router.get('/offers', authenticateToken, listAffiliateOffers);
router.post('/offers/:id/link', authenticateToken, getMyAffiliateLink);
router.get('/stats', authenticateToken, getMyAffiliateStats);
router.get('/conversions', authenticateToken, listMyConversions);

// Alias historique des liens déjà partagés : /api/affiliate/HAI-XXXXXXXX.
// Le format canonique est /r/HAI-XXXXXXXX.
router.get('/:code', redirectRateLimiter, getAffiliateRedirect);

module.exports = router;
