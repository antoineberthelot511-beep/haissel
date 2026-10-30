const express = require('express');
const contact = require('../controllers/contact.controller');
const { contactRateLimiter } = require('../middleware/rate-limit.middleware');
const { requireTurnstile } = require('../middleware/turnstile.middleware');

const router = express.Router();

// Limite par IP d'abord, puis vérification anti-robot (formulaire public).
router.post('/', contactRateLimiter, requireTurnstile('contact'), contact.submit);

module.exports = router;
