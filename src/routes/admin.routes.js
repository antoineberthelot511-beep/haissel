const express = require('express');
const admin = require('../controllers/admin.controller');
const broadcast = require('../controllers/broadcast.controller');
const { broadcastBurstLimiter, broadcastHourlyLimiter } = require('../middleware/rate-limit.middleware');
const {
  requireLocalAdmin,
  authenticateToken,
  ensureAdmin,
} = require('../middleware/auth.middleware');

const router = express.Router();

// Triple protection appliquée à TOUTES les routes de ce routeur :
// 1. requête locale  2. session valide  3. rôle ADMIN (table admins)
router.use(requireLocalAdmin, authenticateToken, ensureAdmin);

router.get('/overview', admin.getAdminOverview);
router.get('/network', admin.getNetworkInfo);
router.get('/stats', admin.getAdminOverview);

router.get('/users', admin.listUsers);
router.patch('/users/:id/status', admin.updateUserStatus);

router.get('/affiliates', admin.listAffiliateLinks);
router.post('/affiliates', admin.createAffiliateLink);
router.patch('/affiliates/:id', admin.updateAffiliateLink);

router.get('/clicks', admin.listClicks);

router.get('/conversions', admin.listConversions);
router.post('/conversions', admin.createManualConversion);
router.patch('/conversions/:id/status', admin.changeConversionStatus);

router.get('/earnings', admin.listEarnings);
router.patch('/earnings/:id/pay', admin.markEarningPaid);

router.get('/actions', admin.listAdminActions);

// Centre de notifications (diffusion aux utilisateurs connectés au flux SSE).
router.get('/notifications', broadcast.listBroadcasts);
router.get('/notifications/presence', broadcast.getPresence);
router.post('/notifications', broadcastBurstLimiter, broadcastHourlyLimiter, broadcast.sendBroadcast);

module.exports = router;
