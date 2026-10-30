const express = require('express');
const { handleAffiliateWebhook } = require('../controllers/webhook.controller');
const { webhookRateLimiter } = require('../middleware/rate-limit.middleware');

const router = express.Router();

/*
 * Postback d'un réseau d'affiliation (corps JSON signé par l'en-tête
 * X-Haissel-Signature). Fournisseurs en liste blanche (ALLOWED_PROVIDERS,
 * aujourd'hui « mylead ») : les autres répondent 404.
 *
 * Conversions des liens de l'équipe (sous-identifiant « subid ») : actives.
 * Ancien moteur interne (codes HAI-…) : toujours gelé par
 * ENABLE_INTERNAL_AFFILIATION, vérifié dans le contrôleur.
 *
 * Corps brut obligatoire : la signature porte sur les octets exacts reçus.
 */
router.post(
  '/affiliate/:provider',
  webhookRateLimiter,
  express.raw({ type: '*/*', limit: '16kb' }),
  handleAffiliateWebhook
);

module.exports = router;
