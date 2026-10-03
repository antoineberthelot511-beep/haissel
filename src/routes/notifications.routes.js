const express = require('express');
const { listNotifications, markNotificationAsRead } = require('../controllers/notifications.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/', authenticateToken, listNotifications);
router.patch('/:id/read', authenticateToken, markNotificationAsRead);

module.exports = router;
