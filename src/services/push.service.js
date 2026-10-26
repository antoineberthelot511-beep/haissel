const webpush = require('web-push');
const { pool } = require('../config/database');
const { getVapidConfig } = require('../config/security');
const { logger } = require('../utils/logger');

/*
 * Notifications Web Push (app fermée, téléphone verrouillé).
 *
 * - Le serveur envoie une requête vers l'endpoint fourni par le navigateur :
 *   d'où la liste blanche stricte des services de notification (SSRF).
 * - Sur Vercel, la fonction s'arrête à la fin de la réponse : l'envoi est
 *   TOUJOURS attendu, avec un plafond global de 3 s, jamais lancé en arrière-plan.
 * - Contenu discret (visible sur l'écran verrouillé) : jamais le texte d'un
 *   message. Endpoints et clés ne sont jamais journalisés.
 */

const MAX_DEVICES_PER_USER = 10;
const MAX_FAILURES = 5;
const SEND_TIMEOUT_MS = 3000;
const TTL_SECONDS = 24 * 3600;

const ALLOWED_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const ALLOWED_HOST_SUFFIXES = ['.notify.windows.com'];

function isAllowedEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch (error) { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.includes(host)
    || ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

// Clés du navigateur, en base64url : p256dh = point P-256 non compressé (65 octets, 0x04…), auth = 16 octets.
function decodeKey(value, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/=+$/, ''), 'base64url');
}

function isValidKeys(keys) {
  const p256dh = decodeKey(keys?.p256dh, 100);
  const auth = decodeKey(keys?.auth, 32);
  return Boolean(p256dh && p256dh.length === 65 && p256dh[0] === 0x04 && auth && auth.length === 16);
}

// Même liste blanche que sw.js et les annonces : liens internes uniquement.
const ALLOWED_URL = /^\/(?:app|mes-affilies|go\/\d{1,10})?(?:#[A-Za-z0-9_-]{1,40})?$/;

/** Chemin relatif interne uniquement (« /app#messages ») ; sinon /app. */
function safeUrl(value) {
  return typeof value === 'string' && ALLOWED_URL.test(value) ? value : '/app';
}

function truncate(text, max) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Contenu exact envoyé au service de notification (sans texte de message). */
function buildPayload({ title, body, url, tag }) {
  return JSON.stringify({
    title: truncate(title || 'HAISSEL', 60),
    body: truncate(body, 120),
    url: safeUrl(url),
    tag: typeof tag === 'string' && /^[a-z0-9:_-]{1,40}$/i.test(tag) ? tag : 'haissel',
  });
}

// Remplaçable dans les tests : aucune requête réseau réelle.
let sender = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
function setSender(fn) { sender = fn; }

function isEnabled() {
  return getVapidConfig().enabled;
}

async function saveSubscription(userId, { endpoint, keys }, userAgent) {
  const ua = String(userAgent || '').slice(0, 200) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Un endpoint appartient à un seul compte : un appareil partagé change de propriétaire.
    await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent, failure_count = 0`,
      [userId, endpoint, keys.p256dh, keys.auth, ua]
    );
    // 10 appareils au plus : on retire les plus anciens.
    await client.query(
      `DELETE FROM push_subscriptions WHERE id IN (
         SELECT id FROM push_subscriptions WHERE user_id = $1
         ORDER BY created_at DESC, id DESC OFFSET $2)`,
      [userId, MAX_DEVICES_PER_USER]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function removeSubscription(userId, endpoint) {
  const result = await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
  return result.rowCount;
}

async function sendOne(row, payload, vapid) {
  try {
    await sender(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      payload,
      {
        TTL: TTL_SECONDS,
        urgency: 'normal',
        timeout: SEND_TIMEOUT_MS,
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      }
    );
    await pool.query('UPDATE push_subscriptions SET last_success_at = NOW(), failure_count = 0 WHERE id = $1', [row.id]);
    return 'sent';
  } catch (error) {
    const status = error && error.statusCode;
    if (status === 404 || status === 410) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
      return 'expired';
    }
    // Jamais l'endpoint ni les clés : l'identifiant de ligne suffit.
    logger.warn('Push failed', { subscriptionId: row.id, status: status || null });
    await pool.query('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1', [row.id]);
    await pool.query('DELETE FROM push_subscriptions WHERE id = $1 AND failure_count > $2', [row.id, MAX_FAILURES]);
    return 'failed';
  }
}

/**
 * Envoie à tous les appareils du membre. Ne lève jamais : un échec de push ne
 * doit pas faire échouer l'action qui l'a déclenché. Attendu par l'appelant,
 * plafonné à 3 s au total.
 */
async function sendToUser(userId, message) {
  const vapid = getVapidConfig();
  if (!vapid.enabled) return { skipped: true, results: [] };
  let timer;
  try {
    const { rows } = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    if (!rows.length) return { skipped: false, results: [] };
    const payload = buildPayload(message);
    const all = Promise.all(rows.map((row) => sendOne(row, payload, vapid).catch(() => 'failed')));
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), SEND_TIMEOUT_MS); });
    const results = await Promise.race([all, timeout]);
    if (results === 'timeout') {
      logger.warn('Push timeout', { userId, devices: rows.length });
      return { skipped: false, results: [], timeout: true };
    }
    return { skipped: false, results };
  } catch (error) {
    logger.warn('Push error', { userId, error: error.message });
    return { skipped: false, results: [], error: true };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isEnabled,
  isAllowedEndpoint,
  isValidKeys,
  safeUrl,
  buildPayload,
  saveSubscription,
  removeSubscription,
  sendToUser,
  setSender,
  MAX_DEVICES_PER_USER,
  MAX_FAILURES,
};
