const express = require('express');
const push = require('../controllers/push.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { pushRateLimiter } = require('../middleware/rate-limit.middleware');

const router = express.Router();

// Session obligatoire (et jeton CSRF pour POST/DELETE, vérifié par authenticateToken).
router.use(authenticateToken);

router.get('/config', push.getConfig);
router.post('/subscribe', pushRateLimiter, push.subscribe);
router.delete('/subscribe', pushRateLimiter, push.unsubscribe);

module.exports = router;
