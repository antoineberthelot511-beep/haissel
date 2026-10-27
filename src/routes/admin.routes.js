const express = require('express');
const admin = require('../controllers/admin.controller');
const broadcast = require('../controllers/broadcast.controller');
const learn = require('../controllers/learn.controller');
const community = require('../controllers/community.controller');
const messages = require('../controllers/messages.controller');
const push = require('../controllers/push.controller');
const { broadcastBurstLimiter, broadcastHourlyLimiter, pushRateLimiter } = require('../middleware/rate-limit.middleware');
const {
  requireLocalAdmin,
  authenticateToken,
  ensureAdmin,
} = require('../middleware/auth.middleware');
const { requireInternalAffiliation } = require('../middleware/feature.middleware');

const router = express.Router();

// Triple protection appliquée à TOUTES les routes de ce routeur :
// 1. requête locale  2. session valide  3. rôle ADMIN (table admins)
router.use(requireLocalAdmin, authenticateToken, ensureAdmin);

router.get('/overview', admin.getAdminOverview);
router.get('/network', admin.getNetworkInfo);
router.get('/stats', admin.getAdminOverview);

router.get('/users', admin.listUsers);
router.patch('/users/:id/status', admin.updateUserStatus);
// Remet la question sur l’âge à zéro : seul recours contre le délai de 30 jours.
router.post('/users/:id/adult-declaration/reset', admin.resetAdultDeclaration);

/*
 * Catalogue des liens publiés et leurs clics : fonctionnalité ACTIVE du site
 * (écrans « Liens » et « Clics », redirection /go/:id). Sans rapport avec le
 * moteur d'affiliation interne gelé ci-dessous, qui porte sur les codes
 * personnels HAI-XXXXXXXX.
 */
router.get('/affiliates', admin.listAffiliateLinks);
router.post('/affiliates', admin.createAffiliateLink);
router.patch('/affiliates/:id', admin.updateAffiliateLink);

router.get('/clicks', admin.listClicks);

/*
 * Conversions et gains : moteur d'affiliation interne, gelé par défaut
 * (ENABLE_INTERNAL_AFFILIATION). Les tables conversions et earnings restent
 * intactes ; seules ces routes cessent de répondre.
 */
router.get('/conversions', requireInternalAffiliation, admin.listConversions);
router.post('/conversions', requireInternalAffiliation, admin.createManualConversion);
router.patch('/conversions/:id/status', requireInternalAffiliation, admin.changeConversionStatus);

router.get('/earnings', requireInternalAffiliation, admin.listEarnings);
router.patch('/earnings/:id/pay', requireInternalAffiliation, admin.markEarningPaid);

router.get('/actions', admin.listAdminActions);

// Centre de notifications (diffusion aux utilisateurs connectés au flux SSE).
router.get('/notifications', broadcast.listBroadcasts);
router.get('/notifications/presence', broadcast.getPresence);
router.post('/notifications', broadcastBurstLimiter, broadcastHourlyLimiter, broadcast.sendBroadcast);
// « M'envoyer une notification de test » : appareils de l'admin connecté uniquement.
router.post('/push/test', pushRateLimiter, push.sendTest);

// Espace pédagogique : contenus, opportunités, réglages du parrainage.
for (const [path, handlers] of [['content', learn.content], ['opportunities', learn.opportunity]]) {
  router.get(`/learn/${path}`, handlers.list);
  router.post(`/learn/${path}`, handlers.create);
  router.patch(`/learn/${path}/:id`, handlers.update);
  router.post(`/learn/${path}/:id/verify`, handlers.verify);
  router.post(`/learn/${path}/:id/status`, handlers.setStatus);
}
router.get('/learn/settings', learn.getSettings);
router.put('/learn/settings', learn.updateSettings);

// Modération des offres publiées par les membres.
router.get('/community/offers', community.adminListOffers);
router.post('/community/offers/:id/moderate', community.adminModerateOffer);
router.post('/community/offers/:id/extend', community.adminExtendOffer);

// Messagerie : conversations des membres avec l'équipe.
router.get('/messages', messages.adminListConversations);
router.get('/messages/:id', messages.adminGetConversation);
router.post('/messages/:id', messages.adminReply);

/*
 * Catégories des offres (table offer_categories). L'identifiant n'est pas
 * modifiable : il est inscrit dans les offres existantes.
 */
router.get('/community/categories', community.adminListCategories);
router.post('/community/categories', community.adminCreateCategory);
router.patch('/community/categories/:slug', community.adminUpdateCategory);
router.delete('/community/categories/:slug', community.adminDeleteCategory);

module.exports = router;
