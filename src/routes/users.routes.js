const express = require('express');
const {
  getUserByUsername,
  updateCurrentUser,
  followUser,
  unfollowUser,
  getUserFollowers,
  getUserFollowing,
} = require('../controllers/users.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const router = express.Router();

router.patch('/me', authenticateToken, updateCurrentUser);
router.post('/:username/follow', authenticateToken, followUser);
router.delete('/:username/follow', authenticateToken, unfollowUser);
router.get('/:username/followers', getUserFollowers);
router.get('/:username/following', getUserFollowing);
router.get('/:username', getUserByUsername);

module.exports = router;
