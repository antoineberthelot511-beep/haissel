const express = require('express');
const messages = require('../controllers/messages.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

// Messagerie avec l'équipe : session obligatoire. Pas de route vers un
// autre membre : le serveur prend toujours la conversation du demandeur.
router.use(authenticateToken);

router.get('/team', messages.getTeamConversation);
router.post('/team', messages.sendToTeam);
router.get('/unread', messages.getUnreadCount);

module.exports = router;
