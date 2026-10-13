const express = require('express');
const { openStream, acknowledge } = require('../controllers/broadcast.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { streamRateLimiter } = require('../middleware/rate-limit.middleware');

/*
 * Notifications temps réel des utilisateurs connectés. Toujours actif
 * (contrairement à l'ancienne API /api/notifications, montée après ce
 * routeur seulement si ENABLE_LEGACY_SOCIAL_API=true).
 */
const router = express.Router();

router.get('/stream', streamRateLimiter, authenticateToken, openStream);
// POST : jeton CSRF exigé par authenticateToken.
router.post('/:id/ack', authenticateToken, acknowledge);

module.exports = router;
