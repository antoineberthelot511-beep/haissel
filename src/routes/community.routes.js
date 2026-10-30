const express = require('express');
const community = require('../controllers/community.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireAdult } = require('../middleware/adult.middleware');
const { requireTurnstile } = require('../middleware/turnstile.middleware');

const router = express.Router();

// Offres des membres : session obligatoire pour toutes les routes.
router.use(authenticateToken);

router.get('/offers', community.listOffers);
router.get('/offers/mine', community.listMyOffers);
// Profil (privé) : liens de l'équipe que j'ai ouverts.
router.get('/offers/tried', community.listTriedOffers);
/*
 * Publier ou modifier une offre suppose un compte éditeur MyLead, donc
 * 18 ans. Le retrait reste permis à tous : un membre doit toujours pouvoir
 * supprimer ce qu'il a publié, même si sa déclaration a changé depuis.
 */
// La publication est le seul formulaire du site qui diffuse un lien à
// d'autres membres : elle est vérifiée comme les formulaires publics.
// Membre : fiche campagne ; lien affilié : ADMIN uniquement (voir le contrôleur).
router.post('/offers', requireAdult, requireTurnstile('publish'), community.createOffer);
router.patch('/offers/:id', requireAdult, community.updateOffer);
router.delete('/offers/:id', community.removeOffer);
// Republier une fiche campagne pour 24 h (auteur, sans nouvelle modération).
router.post('/offers/:id/renew', requireAdult, community.renewOffer);
router.post('/offers/:id/save', community.saveOffer);
router.delete('/offers/:id/save', community.unsaveOffer);
router.post('/offers/:id/report', community.reportOffer);
// Ouverture d'un lien affilié : l'URL n'est délivrée qu'ici, après contrôle.
router.get('/offers/:id/open', community.openOffer);
router.get('/members/:username', community.getMemberProfile);

module.exports = router;
