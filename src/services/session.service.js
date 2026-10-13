const crypto = require('crypto');
const { pool } = require('../config/database');
const {
  deriveKey,
  isSecureRequest,
  SESSION_COOKIE_SECURE,
  SESSION_COOKIE_PLAIN,
  SESSION_POLICY,
} = require('../config/security');
const { getClientIp } = require('../utils/network');
const { safeEqual } = require('../utils/network');
const realtime = require('./realtime.service');

/*
 * Sessions serveur.
 *
 * - Identifiant : 32 octets aléatoires (crypto.randomBytes), envoyé
 *   UNIQUEMENT dans un cookie HttpOnly ; seul son SHA-256 est stocké.
 * - Expiration absolue (expires_at) + expiration après inactivité
 *   (last_seen_at + idle_timeout_seconds).
 * - Jeton CSRF = HMAC(clé dédiée, hash de session) : lié à la session,
 *   jamais stocké en clair, invalide dès que la session change.
 */

const TOUCH_INTERVAL_SECONDS = 60;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function csrfTokenFor(tokenHash) {
  return crypto.createHmac('sha256', deriveKey('csrf')).update(tokenHash).digest('base64url');
}

function isValidCsrfToken(tokenHash, provided) {
  return typeof provided === 'string' && provided.length > 0 && safeEqual(provided, csrfTokenFor(tokenHash));
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

/** Lit l'identifiant de session (le cookie __Host- est prioritaire). */
function readSessionToken(req) {
  const cookies = parseCookies(req.get('cookie'));
  const token = cookies[SESSION_COOKIE_SECURE] || cookies[SESSION_COOKIE_PLAIN] || '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const secure = isSecureRequest(req);
  res.cookie(secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

function clearSessionCookies(req, res) {
  res.clearCookie(SESSION_COOKIE_PLAIN, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.clearCookie(SESSION_COOKIE_SECURE, { httpOnly: true, sameSite: 'lax', path: '/', secure: true });
}

/**
 * Crée une nouvelle session (toujours un identifiant neuf : pas de fixation
 * possible). Retourne { token, csrfToken }.
 */
async function createSession(req, res, user, { role = 'USER', mfaPending = false, db = pool } = {}) {
  const policy = mfaPending
    ? SESSION_POLICY.mfaPending
    : (role !== 'USER' ? SESSION_POLICY.admin : SESSION_POLICY.user);

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const csrfToken = csrfTokenFor(tokenHash);

  await db.query(
    `
      INSERT INTO sessions (user_id, token_hash, csrf_token_hash, user_agent, ip_address,
                            expires_at, last_seen_at, idle_timeout_seconds, mfa_pending)
      VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6), NOW(), $7, $8)
    `,
    [
      user.id,
      tokenHash,
      sha256(csrfToken),
      (req.get('user-agent') || '').slice(0, 300) || null,
      getClientIp(req) || null,
      policy.absoluteSeconds,
      policy.idleSeconds,
      mfaPending,
    ]
  );

  setSessionCookie(req, res, token, policy.absoluteSeconds);
  return { token, tokenHash, csrfToken };
}

/**
 * Charge la session active et son utilisateur. null si absente, expirée
 * (absolue ou inactivité), révoquée, ou compte suspendu / banni.
 */
async function loadSession(req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const tokenHash = sha256(token);

  const result = await pool.query(
    `
      SELECT s.id AS session_id, s.mfa_pending, s.last_seen_at,
             u.id, u.username, u.email, u.display_name, u.first_name, u.last_name,
             u.avatar_url, u.bio, u.created_at, u.updated_at, u.is_active, u.is_banned,
             u.email_verified_at, u.mfa_enabled,
             COALESCE(a.role, 'USER') AS role
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      LEFT JOIN admins a ON a.user_id = u.id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND s.last_seen_at + make_interval(secs => s.idle_timeout_seconds) > NOW()
        AND u.is_active = true
        AND u.is_banned = false
    `,
    [tokenHash]
  );

  const row = result.rows[0];
  if (!row) return null;

  // Prolonge la fenêtre d'inactivité (au plus une écriture par minute).
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_SECONDS * 1000) {
    pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [row.session_id]).catch(() => {});
  }

  const { session_id: sessionId, mfa_pending: mfaPending, last_seen_at: _seen, ...user } = row;
  return { sessionId, tokenHash, mfaPending, user };
}

async function revokeSession(sessionId, reason, db = pool) {
  await db.query(
    'UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
    [sessionId, reason]
  );
  // Le flux temps réel de cette session est fermé immédiatement.
  realtime.closeSession(sessionId, reason);
}

/** Révoque toutes les sessions d'un compte (sauf éventuellement une). */
async function revokeAllSessions(userId, reason, { exceptSessionId = null, db = pool } = {}) {
  const result = await db.query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL AND ($3::int IS NULL OR id <> $3::int)`,
    [userId, reason, exceptSessionId]
  );
  realtime.closeUser(userId, reason, { exceptSessionId });
  return result.rowCount;
}

/** Révoque la session éventuellement présente dans la requête (rotation). */
async function revokeRequestSession(req, reason) {
  const token = readSessionToken(req);
  if (!token) return;
  await pool.query(
    'UPDATE sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256(token), reason]
  );
  realtime.closeSessionByHash(sha256(token), reason);
}

module.exports = {
  createSession,
  loadSession,
  revokeSession,
  revokeAllSessions,
  revokeRequestSession,
  readSessionToken,
  clearSessionCookies,
  csrfTokenFor,
  isValidCsrfToken,
  sha256,
};
