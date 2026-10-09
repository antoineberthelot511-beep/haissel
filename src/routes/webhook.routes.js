const express = require('express');
const { handleAffiliateWebhook } = require('../controllers/webhook.controller');
const { webhookRateLimiter } = require('../middleware/rate-limit.middleware');

const router = express.Router();

// Corps brut obligatoire : la signature porte sur les octets exacts reçus.
router.post(
  '/affiliate/:provider',
  webhookRateLimiter,
  express.raw({ type: '*/*', limit: '16kb' }),
  handleAffiliateWebhook
);

module.exports = router;
