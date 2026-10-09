const crypto = require('crypto');
const { pool } = require('../config/database');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I
const CODE_LENGTH = 8; // 32^8 ≈ 1,1e12 combinaisons
const CODE_PATTERN = /^[A-Z0-9-]{6,40}$/;
const CLICK_DEDUP_WINDOW_MINUTES = 10;

function generateAffiliateCode() {
  let code = 'HAI-';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidCode(value) {
  return CODE_PATTERN.test(normalizeCode(value));
}

/**
 * Seules les URL http(s) absolues sont acceptées comme destination.
 */
function isSafeOfferUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch (error) {
    return false;
  }
}

/**
 * Remplace les marqueurs optionnels {click_id} et {code} de l'URL d'offre,
 * pour que le partenaire puisse renvoyer ces valeurs dans son webhook.
 */
function buildDestinationUrl(offerUrl, { clickId, code }) {
  return offerUrl
    .replace(/\{click_id\}/g, encodeURIComponent(String(clickId || '')))
    .replace(/\{code\}/g, encodeURIComponent(code));
}

/**
 * Retourne le code de l'utilisateur pour une offre active, en le créant si
 * nécessaire. Sûr en cas de requêtes concurrentes (contrainte unique
 * user_id + affiliate_link_id).
 */
async function ensureUserAffiliateCode(userId, offerId) {
  const offer = await pool.query(
    'SELECT id FROM affiliate_links WHERE id = $1 AND is_active = true',
    [offerId]
  );
  if (offer.rows.length === 0) return null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await pool.query(
        `
          INSERT INTO user_affiliate_codes (user_id, affiliate_link_id, code, created_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (user_id, affiliate_link_id) DO NOTHING
          RETURNING id, code
        `,
        [userId, offerId, generateAffiliateCode()]
      );
      if (result.rows.length > 0) return result.rows[0];

      const existing = await pool.query(
        'SELECT id, code FROM user_affiliate_codes WHERE user_id = $1 AND affiliate_link_id = $2',
        [userId, offerId]
      );
      return existing.rows[0];
    } catch (error) {
      // Collision (très improbable) sur la colonne code : nouvel essai.
      if (error.code !== '23505') throw error;
    }
  }

  throw new Error('Could not generate a unique affiliate code.');
}

/**
 * Résout un code public vers son offre active et son affilié actif.
 */
async function findActiveCode(code) {
  const result = await pool.query(
    `
      SELECT uac.id AS user_affiliate_code_id, uac.user_id, uac.affiliate_link_id, a.url
      FROM user_affiliate_codes uac
      INNER JOIN affiliate_links a ON a.id = uac.affiliate_link_id
      INNER JOIN users u ON u.id = uac.user_id
      WHERE uac.code = $1
        AND a.is_active = true
        AND u.is_active = true
        AND u.is_banned = false
    `,
    [code]
  );
  return result.rows[0] || null;
}

/**
 * Enregistre un clic, sauf si la même IP a déjà cliqué sur ce code dans la
 * fenêtre de dédoublonnage. Retourne l'id du clic (nouveau ou existant).
 */
async function recordClick({ codeRow, ipHash, ipAddress, userAgent, referrer }) {
  const inserted = await pool.query(
    `
      INSERT INTO clicks (user_id, affiliate_link_id, user_affiliate_code_id, ip_address, ip_hash,
                          user_agent, referrer, created_at)
      SELECT $1::int, $2::int, $3::int, $4::text, $5::text, $6::text, $7::text, NOW()
      WHERE $5::text IS NULL OR NOT EXISTS (
        SELECT 1 FROM clicks
        WHERE user_affiliate_code_id = $3::int
          AND ip_hash = $5::text
          AND created_at > NOW() - ($8::text || ' minutes')::interval
      )
      RETURNING id
    `,
    [
      codeRow.user_id,
      codeRow.affiliate_link_id,
      codeRow.user_affiliate_code_id,
      ipAddress,
      ipHash,
      userAgent,
      referrer,
      String(CLICK_DEDUP_WINDOW_MINUTES),
    ]
  );

  if (inserted.rows.length > 0) {
    return { clickId: inserted.rows[0].id, counted: true };
  }

  const previous = await pool.query(
    `SELECT id FROM clicks WHERE user_affiliate_code_id = $1 AND ip_hash = $2
     ORDER BY created_at DESC LIMIT 1`,
    [codeRow.user_affiliate_code_id, ipHash]
  );
  return { clickId: previous.rows[0]?.id || null, counted: false };
}

module.exports = {
  generateAffiliateCode,
  normalizeCode,
  isValidCode,
  isSafeOfferUrl,
  buildDestinationUrl,
  ensureUserAffiliateCode,
  findActiveCode,
  recordClick,
  CLICK_DEDUP_WINDOW_MINUTES,
};
