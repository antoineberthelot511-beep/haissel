const express = require('express');
const learn = require('../controllers/learn.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

// Espace pédagogique : lecture des éléments publiés, membres connectés.
router.get('/content', authenticateToken, learn.listPublishedContent);
router.get('/opportunities', authenticateToken, learn.listPublishedOpportunities);
router.get('/referral', authenticateToken, learn.getReferral);

module.exports = router;
