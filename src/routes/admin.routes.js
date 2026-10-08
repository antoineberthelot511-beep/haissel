const express = require('express');
const {
  getAdminOverview,
  listUsers,
  updateUserStatus,
  listAffiliateLinks,
  createAffiliateLink,
  listAdminStats,
} = require('../controllers/admin.controller');
const { authenticateToken, ensureAdmin } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/overview', authenticateToken, ensureAdmin, getAdminOverview);
router.get('/users', authenticateToken, ensureAdmin, listUsers);
router.patch('/users/:id/status', authenticateToken, ensureAdmin, updateUserStatus);
router.get('/affiliates', authenticateToken, ensureAdmin, listAffiliateLinks);
router.post('/affiliates', authenticateToken, ensureAdmin, createAffiliateLink);
router.get('/stats', authenticateToken, ensureAdmin, listAdminStats);

module.exports = router;
