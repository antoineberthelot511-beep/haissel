const crypto = require('crypto');
const { logger } = require('../utils/logger');

/*
 * Cloudflare Turnstile (protection anti-robot des formulaires).
 *
 * - TURNSTILE_SITE_KEY : publique, transmise au navigateur via /api/auth/config.
 * - TURNSTILE_SECRET_KEY : secrète, utilisée UNIQUEMENT ici, côté serveur.
 * Sans les deux clés, la protection est inactive (avertissement au démarrage).
 *
 * Chaque jeton est vérifié auprès de l'API Siteverify : Cloudflare refuse un
 * jeton absent, invalide, expiré (300 s) ou déjà utilisé (timeout-or-duplicate).
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 8000;
const TOKEN_MAX_LENGTH = 2048;

// Clés de test officielles : elles valident ou refusent tout jeton.
const TEST_KEY_PATTERN = /^[123]x0{20,}[A-Z]{2}$/;

const getSiteKey = () => String(process.env.TURNSTILE_SITE_KEY || '').trim();
const getSecretKey = () => String(process.env.TURNSTILE_SECRET_KEY || '').trim();
const isTurnstileEnabled = () => Boolean(getSiteKey() && getSecretKey());
const isTestKey = (value) => TEST_KEY_PATTERN.test(String(value || '').trim());

/**
 * @returns {Promise<{ success: boolean, errorCodes: string[] }>}
 * Panne réseau : échec (fail closed) avec le code « internal-error ».
 */
async function verifyTurnstileToken(token, { remoteIp, expectedAction, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX_LENGTH) {
    return { success: false, errorCodes: ['missing-input-response'] };
  }

  const body = new URLSearchParams({
    secret: getSecretKey(),
    response: token,
    idempotency_key: crypto.randomUUID(),
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  let data;
  try {
    const response = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    data = await response.json();
  } catch (error) {
    logger.error('Turnstile siteverify unreachable', { error: error.message });
    return { success: false, errorCodes: ['internal-error'] };
  }

  const errorCodes = Array.isArray(data?.['error-codes']) ? data['error-codes'].map(String) : [];
  if (data?.success !== true) {
    return { success: false, errorCodes: errorCodes.length ? errorCodes : ['invalid-input-response'] };
  }
  // Un jeton émis pour un autre formulaire n'est pas accepté ici.
  if (expectedAction && data.action && data.action !== expectedAction) {
    return { success: false, errorCodes: ['action-mismatch'] };
  }
  return { success: true, errorCodes: [] };
}

module.exports = { getSiteKey, isTurnstileEnabled, isTestKey, verifyTurnstileToken, SITEVERIFY_URL };
