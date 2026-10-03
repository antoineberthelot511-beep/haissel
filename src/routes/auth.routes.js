const express = require('express');
const { register, login, logout, me } = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { authRateLimiter } = require('../middleware/rate-limit.middleware');

const router = express.Router();

router.post('/register', authRateLimiter, register);
router.post('/login', authRateLimiter, login);
router.post('/logout', authenticateToken, logout);
router.get('/me', authenticateToken, me);

module.exports = router;
