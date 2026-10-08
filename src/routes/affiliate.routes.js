const express = require('express');
const {
  listAffiliateOffers,
  getMyAffiliateStats,
  getAffiliateRedirect,
  createConversion,
} = require('../controllers/affiliate.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/', authenticateToken, listAffiliateOffers);
router.get('/stats', authenticateToken, getMyAffiliateStats);
router.post('/conversion', authenticateToken, createConversion);
router.get('/:code', getAffiliateRedirect);

module.exports = router;
