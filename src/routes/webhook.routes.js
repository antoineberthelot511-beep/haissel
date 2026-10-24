const express = require('express');
const { handleAffiliateWebhook } = require('../controllers/webhook.controller');
const { webhookRateLimiter } = require('../middleware/rate-limit.middleware');
const { requireInternalAffiliation } = require('../middleware/feature.middleware');

const router = express.Router();

/*
 * Postback d'un réseau d'affiliation. Gelé par défaut
 * (ENABLE_INTERNAL_AFFILIATION) : le format attendu ici — corps JSON signé par
 * l'en-tête X-Haissel-Signature — est propre à HAISSEL, et aucun réseau réel
 * n'émet ce format. Rebrancher un annonceur demandera un adaptateur par
 * réseau (voir README).
 *
 * La garde précède express.raw : inutile de lire un corps qu'on refusera.
 * Corps brut obligatoire ensuite : la signature porte sur les octets exacts
 * reçus.
 */
router.post(
  '/affiliate/:provider',
  requireInternalAffiliation,
  webhookRateLimiter,
  express.raw({ type: '*/*', limit: '16kb' }),
  handleAffiliateWebhook
);

module.exports = router;
