const crypto = require('crypto');
const { pool } = require('../config/database');

/*
 * Jetons à usage unique (vérification d'e-mail, réinitialisation).
 * - 32 octets aléatoires ; seul le SHA-256 est stocké ;
 * - durée de validité limitée ; consommation atomique (un seul usage) ;
 * - la création d'un nouveau jeton invalide les précédents du même type ;
 * - au plus MAX_PER_HOUR créations par compte et par heure.
 */

const TTL_SECONDS = {
  verify_email: 24 * 3600,
  reset_password: 30 * 60,
};
const MAX_PER_HOUR = 3;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function isWellFormedToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * @returns {Promise<string|null>} le jeton en clair (à envoyer par e-mail),
 * ou null si la limite horaire est atteinte.
 */
async function issueToken(userId, purpose) {
  const recent = await pool.query(
    `SELECT COUNT(*)::int AS n FROM auth_tokens
     WHERE user_id = $1 AND purpose = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId, purpose]
  );
  if (recent.rows[0].n >= MAX_PER_HOUR) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE auth_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
      [userId, purpose]
    );
    await client.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))`,
      [userId, purpose, sha256(token), TTL_SECONDS[purpose]]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return token;
}

/**
 * Consomme un jeton valide (non expiré, non utilisé) de façon atomique.
 * @returns {Promise<number|null>} l'id utilisateur, ou null.
 */
async function consumeToken(token, purpose, db = pool) {
  if (!isWellFormedToken(token)) return null;
  const result = await db.query(
    `UPDATE auth_tokens SET used_at = NOW()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [sha256(token), purpose]
  );
  return result.rows[0]?.user_id || null;
}

/** Lit un jeton valide sans le consommer (contrôles préalables). */
async function peekToken(token, purpose) {
  if (!isWellFormedToken(token)) return null;
  const result = await pool.query(
    `SELECT user_id FROM auth_tokens
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()`,
    [sha256(token), purpose]
  );
  return result.rows[0]?.user_id || null;
}

module.exports = {
  peekToken,
  issueToken,
  consumeToken,
  isWellFormedToken,
  TTL_SECONDS,
};
