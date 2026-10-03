const express = require('express');
const { createReport, listReports, updateReportStatus } = require('../controllers/reports.controller');
const { authenticateToken, requireRole } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/', authenticateToken, createReport);
router.get('/', authenticateToken, requireRole('MODERATOR', 'ADMIN'), listReports);
router.patch('/:id/status', authenticateToken, requireRole('MODERATOR', 'ADMIN'), updateReportStatus);

module.exports = router;
