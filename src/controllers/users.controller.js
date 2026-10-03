const { pool } = require('../config/database');

function isValidAvatarUrl(value) {
  if (!value) {
    return true;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const {
    password_hash,
    ...publicUser
  } = user;

  return publicUser;
}

async function getUserByUsername(req, res, next) {
  try {
    const { username } = req.params;

    const result = await pool.query(
      `
        SELECT id, username, display_name, avatar_url, bio, created_at
        FROM users
        WHERE username = $1 AND is_active = true AND is_banned = false
        LIMIT 1
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User was not found.',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        user: result.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function updateCurrentUser(req, res, next) {
  try {
    const { display_name, bio, avatar_url } = req.body || {};
    const userId = req.user.id;

    const allowedFields = {};

    if (typeof display_name === 'string') {
      if (display_name.trim().length > 100) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_DISPLAY_NAME',
            message: 'Display name must be at most 100 characters.',
          },
        });
      }
      allowedFields.display_name = display_name.trim();
    }

    if (typeof bio === 'string') {
      if (bio.trim().length > 500) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_BIO',
            message: 'Bio must be at most 500 characters.',
          },
        });
      }
      allowedFields.bio = bio.trim();
    }

    if (typeof avatar_url === 'string') {
      if (avatar_url.length > 2048 || !isValidAvatarUrl(avatar_url.trim())) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_AVATAR_URL',
            message: 'Avatar URL must be a valid HTTP(S) URL of at most 2,048 characters.',
          },
        });
      }
      allowedFields.avatar_url = avatar_url.trim();
    }

    if (Object.keys(allowedFields).length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'No valid profile fields were provided.',
        },
      });
    }

    const columns = Object.keys(allowedFields)
      .map((key, index) => `${key} = $${index + 1}`)
      .join(', ');

    const values = Object.values(allowedFields);
    values.push(userId);

    const updateResult = await pool.query(
      `
        UPDATE users
        SET ${columns}, updated_at = NOW()
        WHERE id = $${values.length}
        RETURNING id, username, email, display_name, avatar_url, bio, created_at, updated_at, is_active, is_banned
      `,
      values
    );

    return res.status(200).json({
      success: true,
      data: {
        user: updateResult.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function followUser(req, res, next) {
  try {
    const { username } = req.params;
    const followerId = req.user.id;

    const targetResult = await pool.query(
      'SELECT id, username FROM users WHERE username = $1 LIMIT 1',
      [username]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User was not found.',
        },
      });
    }

    if (targetResult.rows[0].id === followerId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'You cannot follow yourself.',
        },
      });
    }

    const existing = await pool.query(
      'SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, targetResult.rows[0].id]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json({
        success: true,
        data: {
          followed: true,
          message: 'You are already following this user.',
        },
      });
    }

    await pool.query(
      'INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1, $2, NOW())',
      [followerId, targetResult.rows[0].id]
    );

    await pool.query(
      `
        INSERT INTO notifications (user_id, type, message, related_user_id, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `,
      [targetResult.rows[0].id, 'follow', `${req.user.username} started following you.`, followerId]
    );

    return res.status(200).json({
      success: true,
      data: {
        followed: true,
        message: 'User followed successfully.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function unfollowUser(req, res, next) {
  try {
    const { username } = req.params;
    const followerId = req.user.id;

    const targetResult = await pool.query(
      'SELECT id FROM users WHERE username = $1 LIMIT 1',
      [username]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User was not found.',
        },
      });
    }

    const result = await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [followerId, targetResult.rows[0].id]
    );

    return res.status(200).json({
      success: true,
      data: {
        followed: false,
        message: result.rowCount > 0 ? 'User unfollowed successfully.' : 'You were not following this user.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getUserFollowers(req, res, next) {
  try {
    const { username } = req.params;

    const userResult = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User was not found.',
        },
      });
    }

    const result = await pool.query(
      `
        SELECT u.id, u.username, u.display_name, u.avatar_url
        FROM follows f
        INNER JOIN users u ON u.id = f.follower_id
        WHERE f.following_id = $1
        ORDER BY f.created_at DESC
      `,
      [userResult.rows[0].id]
    );

    return res.status(200).json({
      success: true,
      data: {
        followers: result.rows,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getUserFollowing(req, res, next) {
  try {
    const { username } = req.params;

    const userResult = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User was not found.',
        },
      });
    }

    const result = await pool.query(
      `
        SELECT u.id, u.username, u.display_name, u.avatar_url
        FROM follows f
        INNER JOIN users u ON u.id = f.following_id
        WHERE f.follower_id = $1
        ORDER BY f.created_at DESC
      `,
      [userResult.rows[0].id]
    );

    return res.status(200).json({
      success: true,
      data: {
        following: result.rows,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getUserByUsername,
  updateCurrentUser,
  sanitizeUser,
  followUser,
  unfollowUser,
  getUserFollowers,
  getUserFollowing,
};
