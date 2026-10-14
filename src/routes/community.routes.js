const express = require('express');
const community = require('../controllers/community.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

// Offres des membres : session obligatoire pour toutes les routes.
router.use(authenticateToken);

router.get('/offers', community.listOffers);
router.get('/offers/mine', community.listMyOffers);
router.post('/offers', community.createOffer);
router.patch('/offers/:id', community.updateOffer);
router.delete('/offers/:id', community.removeOffer);
router.post('/offers/:id/save', community.saveOffer);
router.delete('/offers/:id/save', community.unsaveOffer);
router.post('/offers/:id/report', community.reportOffer);
router.get('/members/:username', community.getMemberProfile);

module.exports = router;
