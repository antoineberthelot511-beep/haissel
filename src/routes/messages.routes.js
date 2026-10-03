const express = require('express');
const {
  listConversations,
  createConversation,
  listMessages,
  sendMessage,
} = require('../controllers/messages.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/', authenticateToken, listConversations);
router.post('/', authenticateToken, createConversation);
router.get('/:id/messages', authenticateToken, listMessages);
router.post('/:id/messages', authenticateToken, sendMessage);

module.exports = router;
