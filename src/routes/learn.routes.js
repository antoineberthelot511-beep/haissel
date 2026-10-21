const express = require('express');
const learn = require('../controllers/learn.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireAdult } = require('../middleware/adult.middleware');

const router = express.Router();

// Espace pédagogique : lecture des éléments publiés, membres connectés.
router.get('/content', authenticateToken, learn.listPublishedContent);
router.get('/opportunities', authenticateToken, learn.listPublishedOpportunities);
/*
 * Guides et opportunités restent accessibles à tous : ce sont des contenus
 * pédagogiques. Le lien de parrainage, lui, mène à la création d'un compte
 * éditeur MyLead : 18 ans exigés.
 */
router.get('/referral', authenticateToken, requireAdult, learn.getReferral);

module.exports = router;
