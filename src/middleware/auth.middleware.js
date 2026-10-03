const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/database');

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication token is required.',
      },
    });
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
    }

    const decoded = jwt.verify(token, secret);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const userQuery = `
      SELECT u.id, u.username, u.email, u.display_name, u.avatar_url, u.bio,
             u.created_at, u.updated_at, u.is_active, u.is_banned
      FROM users u
      INNER JOIN sessions s ON s.user_id = u.id
      WHERE u.id = $1
        AND s.token_hash = $2
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.is_active = true
        AND u.is_banned = false
    `;

    pool.query(userQuery, [decoded.sub || decoded.id, tokenHash])
      .then((result) => {
        if (result.rows.length === 0) {
          return res.status(401).json({
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'User no longer exists.',
            },
          });
        }

        req.user = result.rows[0];
        req.tokenHash = tokenHash;
        return next();
      })
      .catch((error) => next(error));
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired authentication token.',
      },
    });
  }
}

function requireRole(...allowedRoles) {
  return async function checkRole(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
        },
      });
    }

    try {
      const roleResult = await pool.query(
        'SELECT role FROM admins WHERE user_id = $1 LIMIT 1',
        [req.user.id]
      );

      const userRole = roleResult.rows[0]?.role || 'USER';

      if (!allowedRoles.includes(userRole.toUpperCase())) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have sufficient permissions.',
          },
        });
      }

      req.userRole = userRole;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  authenticateToken,
  requireRole,
};
