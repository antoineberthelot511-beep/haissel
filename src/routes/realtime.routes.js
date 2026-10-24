const express = require('express');
const { openStream, pollNotifications, acknowledge } = require('../controllers/broadcast.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { streamRateLimiter } = require('../middleware/rate-limit.middleware');

/*
 * Notifications temps réel des utilisateurs connectés. Seul routeur monté sur
 * /api/notifications depuis la suppression de l'ancienne API du réseau social,
 * qui partageait ce préfixe.
 */
const router = express.Router();

router.get('/stream', streamRateLimiter, authenticateToken, openStream);
// Interrogation régulière (Vercel) : le flux SSE ne fonctionne pas sans
// mémoire partagée entre instances. Toujours montée — un client en mode SSE
// ne l'appelle simplement jamais. Pas de limiteur dédié : un appel toutes les
// 45 s par onglet, la limite générale d'app.js suffit.
router.get('/poll', authenticateToken, pollNotifications);
// POST : jeton CSRF exigé par authenticateToken.
router.post('/:id/ack', authenticateToken, acknowledge);

module.exports = router;
