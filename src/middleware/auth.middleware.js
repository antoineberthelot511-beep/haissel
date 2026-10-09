const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { sendError } = require('../utils/http');
const { isLocalRequest } = require('../utils/network');
const { logger } = require('../utils/logger');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }
  return secret;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Vérifie le JWT (signature + expiration) PUIS la session en base :
 * session non révoquée, non expirée, compte actif et non banni.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentification requise.');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
  } catch (error) {
    return sendError(res, 401, 'INVALID_TOKEN', 'Session invalide ou expirée. Veuillez vous reconnecter.');
  }

  const userId = Number(decoded.sub);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return sendError(res, 401, 'INVALID_TOKEN', 'Session invalide ou expirée. Veuillez vous reconnecter.');
  }

  try {
    const tokenHash = hashToken(token);
    const result = await pool.query(
      `
        SELECT u.id, u.username, u.email, u.display_name, u.avatar_url, u.bio,
               u.created_at, u.updated_at, u.is_active, u.is_banned,
               COALESCE(a.role, 'USER') AS role
        FROM sessions s
        INNER JOIN users u ON u.id = s.user_id
        LEFT JOIN admins a ON a.user_id = u.id
        WHERE s.token_hash = $1
          AND s.user_id = $2
          AND s.revoked_at IS NULL
          AND s.expires_at > NOW()
          AND u.is_active = true
          AND u.is_banned = false
        LIMIT 1
      `,
      [tokenHash, userId]
    );

    if (result.rows.length === 0) {
      return sendError(res, 401, 'SESSION_EXPIRED', 'Session invalide ou expirée. Veuillez vous reconnecter.');
    }

    req.user = result.rows[0];
    req.userRole = String(req.user.role).toUpperCase();
    req.tokenHash = tokenHash;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Le rôle provient de la table admins (lue par authenticateToken à chaque
 * requête) ; il n'est jamais lu depuis le JWT ni depuis le client.
 */
function requireRole(...allowedRoles) {
  const allowed = allowedRoles.map((role) => role.toUpperCase());

  return function checkRole(req, res, next) {
    if (!req.user) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentification requise.');
    }

    if (!allowed.includes(req.userRole)) {
      logger.warn('Forbidden role access', { userId: req.user.id, path: req.originalUrl });
      return sendError(res, 403, 'FORBIDDEN', 'Accès administrateur refusé.');
    }

    return next();
  };
}

const ensureAdmin = requireRole('ADMIN');

/**
 * L'administration n'est accessible que depuis la machine serveur.
 */
function requireLocalAdmin(req, res, next) {
  if (!isLocalRequest(req)) {
    logger.warn('Admin access attempt from non-local address', { path: req.originalUrl });
    return sendError(res, 403, 'ADMIN_LOCAL_ONLY', 'Administration accessible uniquement depuis le serveur.');
  }
  return next();
}

module.exports = {
  authenticateToken,
  requireRole,
  ensureAdmin,
  requireLocalAdmin,
  hashToken,
  getJwtSecret,
};
