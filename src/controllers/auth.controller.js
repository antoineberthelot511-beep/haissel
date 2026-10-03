const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/database');

const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;

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

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }

  return secret;
}

async function createSession(user, req) {
  const token = jwt.sign(
    { sub: user.id, username: user.username },
    getJwtSecret(),
    { expiresIn: SESSION_DURATION_SECONDS }
  );
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await pool.query(
    `
      INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
    `,
    [user.id, tokenHash, req.get('user-agent') || null, req.ip || null]
  );

  return token;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function register(req, res, next) {
  try {
    const { username, email, password, display_name } = req.body || {};

    if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Username, email and password are required.',
        },
      });
    }

    const normalizedUsername = username.trim().toLowerCase();
    const normalizedEmail = email.trim().toLowerCase();

    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_USERNAME',
          message: 'Username must be between 3 and 30 characters.',
        },
      });
    }

    if (normalizedEmail.length > 255 || !validateEmail(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_EMAIL',
          message: 'Email address is invalid.',
        },
      });
    }

    const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN;
    if (allowedDomain && normalizedEmail.split('@')[1] !== allowedDomain.toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'EMAIL_DOMAIN_NOT_ALLOWED',
          message: `Only ${allowedDomain} addresses are allowed.`,
        },
      });
    }

    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (passwordBytes < 8 || passwordBytes > 72) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PASSWORD',
          message: 'Password must be between 8 and 72 bytes long.',
        },
      });
    }

    if (display_name !== undefined && (typeof display_name !== 'string' || display_name.trim().length > 100)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_DISPLAY_NAME',
          message: 'Display name must be a string of at most 100 characters.',
        },
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const insertResult = await pool.query(
      `
        INSERT INTO users (username, email, password_hash, display_name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING id, username, email, display_name, avatar_url, bio, created_at, updated_at, is_active, is_banned
      `,
      [normalizedUsername, normalizedEmail, passwordHash, display_name?.trim() || normalizedUsername]
    );

    const user = insertResult.rows[0];
    const token = await createSession(user, req);

    return res.status(201).json({
      success: true,
      data: {
        user: sanitizeUser(user),
        token,
      },
    });
  } catch (error) {
    if (error.code === '23505') {
      const field = error.detail && error.detail.includes('email') ? 'email' : 'username';

      return res.status(409).json({
        success: false,
        error: {
          code: 'USER_ALREADY_EXISTS',
          message: `${field === 'email' ? 'Email' : 'Username'} already exists.`,
        },
      });
    }

    return next(error);
  }
}

async function login(req, res, next) {
  try {
    const { identifier, password } = req.body || {};

    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim() || !password) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Identifier and password are required.',
        },
      });
    }

    const userQuery = `
      SELECT id, username, email, password_hash, display_name, avatar_url, bio, created_at, updated_at, is_active, is_banned
      FROM users
      WHERE username = $1 OR email = $2
      LIMIT 1
    `;

    const result = await pool.query(userQuery, [identifier.trim().toLowerCase(), identifier.trim().toLowerCase()]);

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials.',
        },
      });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match || !user.is_active || user.is_banned) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials.',
        },
      });
    }

    const token = await createSession(user, req);

    return res.status(200).json({
      success: true,
      data: {
        user: sanitizeUser(user),
        token,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function logout(req, res, next) {
  try {
  await pool.query(
    'UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
    [req.tokenHash]
  );

  return res.status(200).json({
    success: true,
    data: {
      message: 'Logged out successfully.',
    },
  });
  } catch (error) {
  return next(error);
  }
}

async function me(req, res) {
  return res.status(200).json({
    success: true,
    data: {
      user: sanitizeUser(req.user),
    },
  });
}

module.exports = {
  register,
  login,
  logout,
  me,
};
