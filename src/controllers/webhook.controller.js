const crypto = require('crypto');
const { sendError } = require('../utils/http');
const { safeEqual } = require('../utils/network');
const { logger } = require('../utils/logger');
const { recordConversion, ConversionError } = require('../services/conversion.service');

/*
 * POST /api/webhooks/affiliate/:provider
 *
 * En-têtes requis :
 *   X-Haissel-Timestamp : horodatage UNIX (secondes)
 *   X-Haissel-Signature : sha256=<hex HMAC-SHA256(secret, `${timestamp}.${corps brut}`)>
 *
 * Secret : AFFILIATE_WEBHOOK_SECRET_<PROVIDER> (ex. _PARTNER_A) sinon
 * AFFILIATE_WEBHOOK_SECRET. Sans secret configuré, le webhook est désactivé.
 *
 * Corps JSON :
 *   { "external_reference": "ORDER-123", "code": "HAI-XXXXXXXX",
 *     "amount_cents": 1250, "currency": "EUR",
 *     "status": "pending|approved|rejected|cancelled", "click_id": 42 }
 */

const TIMESTAMP_TOLERANCE_SECONDS = 300;

function getProviderSecret(provider) {
  const specific = process.env[`AFFILIATE_WEBHOOK_SECRET_${provider.toUpperCase().replace(/-/g, '_')}`];
  const secret = specific || process.env.AFFILIATE_WEBHOOK_SECRET || '';
  return Buffer.byteLength(secret, 'utf8') >= 32 ? secret : null;
}

function computeSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

async function handleAffiliateWebhook(req, res, next) {
  const provider = String(req.params.provider || '').toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(provider)) {
    return sendError(res, 404, 'UNKNOWN_PROVIDER', 'Fournisseur inconnu.');
  }

  const secret = getProviderSecret(provider);
  if (!secret) {
    logger.warn('Webhook received for unconfigured provider', { provider });
    return sendError(res, 404, 'UNKNOWN_PROVIDER', 'Fournisseur inconnu.');
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
  if (!rawBody || rawBody.length === 0) {
    return sendError(res, 400, 'INVALID_PAYLOAD', 'Corps JSON requis.');
  }

  const timestamp = String(req.get('x-haissel-timestamp') || '');
  const signatureHeader = String(req.get('x-haissel-signature') || '');
  const now = Math.floor(Date.now() / 1000);

  if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) {
    logger.warn('Webhook rejected: invalid timestamp', { provider });
    return sendError(res, 401, 'INVALID_TIMESTAMP', 'Horodatage invalide ou expiré.');
  }

  const expected = `sha256=${computeSignature(secret, timestamp, rawBody)}`;
  if (!safeEqual(signatureHeader, expected)) {
    logger.warn('Webhook rejected: invalid signature', { provider });
    return sendError(res, 401, 'INVALID_SIGNATURE', 'Signature invalide.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return sendError(res, 400, 'INVALID_PAYLOAD', 'JSON invalide.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return sendError(res, 400, 'INVALID_PAYLOAD', 'JSON invalide.');
  }

  logger.info('Webhook received', { provider, reference: String(payload.external_reference || '').slice(0, 120) });

  try {
    const { conversion, created, changed } = await recordConversion({ ...payload, provider });

    return res.status(created ? 201 : 200).json({
      success: true,
      data: {
        conversion_id: conversion.id,
        status: conversion.status,
        created,
        duplicate: !created && !changed,
      },
    });
  } catch (error) {
    if (error instanceof ConversionError) {
      logger.warn('Webhook conversion refused', { provider, code: error.code });
      return sendError(res, error.status, error.code, error.message);
    }
    return next(error);
  }
}

module.exports = {
  handleAffiliateWebhook,
  computeSignature,
  TIMESTAMP_TOLERANCE_SECONDS,
};
