const express = require('express');
const { getCommentsByPost, createComment, deleteComment } = require('../controllers/comments.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/posts/:id/comments', getCommentsByPost);
router.post('/posts/:id/comments', authenticateToken, createComment);
router.delete('/comments/:id', authenticateToken, deleteComment);

module.exports = router;
