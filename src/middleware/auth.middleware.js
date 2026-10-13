const { sendError } = require('../utils/http');
const { isLocalRequest } = require('../utils/network');
const { logger } = require('../utils/logger');
const { isAdminMfaRequired } = require('../config/security');
const { loadSession, isValidCsrfToken } = require('../services/session.service');

/*
 * Authentification par session serveur (cookie HttpOnly).
 *
 * À chaque requête protégée :
 *  1. la session est relue en base (non révoquée, non expirée, compte actif
 *     et non banni) ;
 *  2. pour toute méthode qui modifie l'état, le jeton CSRF lié à la session
 *     (en-tête X-CSRF-Token) est exigé ;
 *  3. le rôle provient de la table admins, jamais du client ;
 *  4. un compte privilégié n'est accepté que depuis la machine serveur.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function authenticate({ allowMfaPending = false } = {}) {
  return async function authenticateRequest(req, res, next) {
    try {
      const session = await loadSession(req);
      if (!session) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Authentification requise.');
      }

      if (!SAFE_METHODS.has(req.method) && !isValidCsrfToken(session.tokenHash, req.get('x-csrf-token'))) {
        logger.warn('CSRF token rejected', { path: req.originalUrl, userId: session.user.id });
        return sendError(res, 403, 'CSRF_REJECTED', 'Requête refusée. Rechargez la page puis réessayez.');
      }

      if (session.mfaPending && !allowMfaPending) {
        return sendError(res, 401, 'MFA_REQUIRED', 'Code de double authentification requis.');
      }

      req.user = session.user;
      req.userRole = String(session.user.role).toUpperCase();
      req.session = { id: session.sessionId, tokenHash: session.tokenHash, mfaPending: session.mfaPending };

      // Un compte privilégié n'est jamais utilisable depuis le réseau local.
      if (req.userRole !== 'USER' && !isLocalRequest(req)) {
        return sendError(res, 403, 'ADMIN_LOCAL_ONLY', 'Ce compte ne peut être utilisé que depuis le serveur.');
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

const authenticateToken = authenticate();

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

const requireAdminRole = requireRole('ADMIN');

/** Rôle ADMIN + double authentification active (sauf ADMIN_REQUIRE_MFA=false). */
function ensureAdmin(req, res, next) {
  return requireAdminRole(req, res, () => {
    if (isAdminMfaRequired() && !req.user.mfa_enabled) {
      return sendError(res, 403, 'MFA_SETUP_REQUIRED', 'Activez la double authentification pour accéder à l’administration.');
    }
    return next();
  });
}

function requireLocalAdmin(req, res, next) {
  if (!isLocalRequest(req)) {
    logger.warn('Admin access attempt from non-local address', { path: req.originalUrl });
    return sendError(res, 403, 'ADMIN_LOCAL_ONLY', 'Administration accessible uniquement depuis le serveur.');
  }
  return next();
}

module.exports = {
  authenticate,
  authenticateToken,
  requireRole,
  ensureAdmin,
  requireLocalAdmin,
};
