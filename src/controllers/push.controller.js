const push = require('../services/push.service');
const { getVapidConfig } = require('../config/security');
const { sendError } = require('../utils/http');
const { logger } = require('../utils/logger');

/** GET /api/push/config : { enabled, public_key } (clé PUBLIQUE uniquement). */
function getConfig(req, res) {
  const vapid = getVapidConfig();
  return res.status(200).json({ success: true, data: { enabled: vapid.enabled, public_key: vapid.enabled ? vapid.publicKey : null } });
}

function readSubscription(body) {
  const endpoint = body?.endpoint;
  if (!push.isAllowedEndpoint(endpoint)) return { error: 'Service de notification non pris en charge.' };
  if (!push.isValidKeys(body?.keys)) return { error: 'Abonnement invalide.' };
  return { subscription: { endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } } };
}

/** POST /api/push/subscribe : enregistre (ou met à jour) l'appareil du membre connecté. */
async function subscribe(req, res, next) {
  try {
    if (!push.isEnabled()) return sendError(res, 503, 'PUSH_DISABLED', 'Notifications indisponibles pour le moment.');
    const { subscription, error } = readSubscription(req.body);
    if (error) return sendError(res, 400, 'INVALID_SUBSCRIPTION', error);
    await push.saveSubscription(req.user.id, subscription, req.get('user-agent'));
    return res.status(201).json({ success: true });
  } catch (error) {
    return next(error);
  }
}

/** DELETE /api/push/subscribe : retire l'abonnement de cet endpoint (s'il est au membre). */
async function unsubscribe(req, res, next) {
  try {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return sendError(res, 400, 'INVALID_SUBSCRIPTION', 'Abonnement invalide.');
    const removed = await push.removeSubscription(req.user.id, endpoint);
    return res.status(200).json({ success: true, data: { removed } });
  } catch (error) {
    return next(error);
  }
}

/** POST /api/admin/push/test : notification de test vers les appareils de l'admin. */
async function sendTest(req, res, next) {
  try {
    if (!push.isEnabled()) return sendError(res, 503, 'PUSH_DISABLED', 'Notifications Web Push non configurées (clés VAPID).');
    const outcome = await push.sendToUser(req.user.id, {
      title: 'HAISSEL', body: 'Notification de test : tout fonctionne.', url: '/app', tag: 'test',
    });
    const sent = outcome.results.filter((r) => r === 'sent').length;
    logger.info('Admin action', { adminId: req.user.id, action: 'push.test', sent });
    return res.status(200).json({ success: true, data: { devices: outcome.results.length, sent, timeout: Boolean(outcome.timeout) } });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getConfig, subscribe, unsubscribe, sendTest };
