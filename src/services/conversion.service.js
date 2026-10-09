const { withTransaction } = require('../config/database');
const { logger } = require('../utils/logger');

/*
 * Règles métier des conversions et des gains.
 *
 * Conversion : pending -> approved | rejected | cancelled
 *              approved -> cancelled (annulation/remboursement, si non payée)
 *              rejected, cancelled : statuts finaux
 *
 * Gain (earning) : créé UNIQUEMENT lorsqu'une conversion devient approved.
 *              pending (dû, non versé) -> paid | cancelled
 *
 * Idempotence : (provider, external_reference) est unique en base ; un même
 * événement reçu deux fois ne crée ni deuxième conversion ni deuxième gain.
 *
 * Aucune route utilisateur n'appelle ce service : seuls le webhook signé et
 * l'administration (locale + rôle ADMIN) peuvent créer une conversion.
 */

const CONVERSION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const EARNING_STATUSES = ['pending', 'paid', 'cancelled'];
const ALLOWED_CURRENCIES = ['EUR'];
const MAX_AMOUNT_CENTS = 1_000_000; // 10 000 € par conversion

const TRANSITIONS = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};

class ConversionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Valide et normalise une conversion entrante. Ne fait confiance à rien.
 */
function validateConversionInput(input) {
  const source = input || {};
  const fail = (code, message) => { throw new ConversionError(400, code, message); };

  const provider = String(source.provider || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(provider)) fail('INVALID_PROVIDER', 'Fournisseur invalide.');

  const externalReference = typeof source.external_reference === 'string'
    ? source.external_reference.trim() : '';
  if (!/^[A-Za-z0-9._:\-]{1,120}$/.test(externalReference)) {
    fail('INVALID_EXTERNAL_REFERENCE', 'Référence externe invalide.');
  }

  const code = String(source.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(code)) fail('INVALID_CODE', 'Code affilié invalide.');

  const amount = source.amount_cents;
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT_CENTS) {
    fail('INVALID_AMOUNT', `Le montant doit être un entier en centimes entre 0 et ${MAX_AMOUNT_CENTS}.`);
  }

  const currency = String(source.currency || 'EUR').trim().toUpperCase();
  if (!ALLOWED_CURRENCIES.includes(currency)) fail('INVALID_CURRENCY', 'Devise non prise en charge.');

  const status = String(source.status || 'pending').trim().toLowerCase();
  if (!CONVERSION_STATUSES.includes(status)) fail('INVALID_STATUS', 'Statut de conversion invalide.');

  let clickId = null;
  if (source.click_id !== undefined && source.click_id !== null && source.click_id !== '') {
    clickId = Number(source.click_id);
    if (!Number.isSafeInteger(clickId) || clickId <= 0 || clickId > 2147483647) {
      fail('INVALID_CLICK', 'Identifiant de clic invalide.');
    }
  }

  return {
    provider,
    externalReference,
    code,
    amountCents: amount,
    currency,
    status,
    clickId,
  };
}

async function createEarning(client, conversion) {
  await client.query(
    `
      INSERT INTO earnings (user_id, affiliate_link_id, user_affiliate_code_id, conversion_id,
                            amount_cents, currency, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
      ON CONFLICT (conversion_id) DO NOTHING
    `,
    [
      conversion.user_id,
      conversion.affiliate_link_id,
      conversion.user_affiliate_code_id,
      conversion.id,
      conversion.amount_cents,
      conversion.currency,
    ]
  );
}

/**
 * Applique une transition de statut à une conversion verrouillée (FOR UPDATE)
 * et répercute l'effet sur le gain associé, dans la transaction courante.
 */
async function transitionConversion(client, conversion, nextStatus) {
  if (conversion.status === nextStatus) {
    return { conversion, changed: false };
  }

  if (!(TRANSITIONS[conversion.status] || []).includes(nextStatus)) {
    throw new ConversionError(
      409,
      'INVALID_TRANSITION',
      `Transition impossible : ${conversion.status} → ${nextStatus}.`
    );
  }

  if (nextStatus === 'cancelled' && conversion.status === 'approved') {
    const paid = await client.query(
      "SELECT 1 FROM earnings WHERE conversion_id = $1 AND status = 'paid'",
      [conversion.id]
    );
    if (paid.rows.length > 0) {
      throw new ConversionError(409, 'EARNING_ALREADY_PAID', 'Le gain de cette conversion a déjà été versé.');
    }
  }

  const updated = await client.query(
    `
      UPDATE conversions
      SET status = $2, processed_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [conversion.id, nextStatus]
  );
  const result = updated.rows[0];

  if (nextStatus === 'approved') {
    await createEarning(client, result);
  } else {
    await client.query(
      "UPDATE earnings SET status = 'cancelled' WHERE conversion_id = $1 AND status = 'pending'",
      [conversion.id]
    );
  }

  return { conversion: result, changed: true };
}

/**
 * Enregistre (ou met à jour de façon idempotente) une conversion confirmée
 * par une source de confiance.
 *
 * @returns {{ conversion: object, created: boolean, changed: boolean }}
 */
async function recordConversion(rawInput) {
  const input = validateConversionInput(rawInput);

  return withTransaction(async (client) => {
    const codeResult = await client.query(
      `
        SELECT uac.id, uac.user_id, uac.affiliate_link_id
        FROM user_affiliate_codes uac
        WHERE uac.code = $1
      `,
      [input.code]
    );
    const affiliateCode = codeResult.rows[0];
    if (!affiliateCode) {
      throw new ConversionError(422, 'AFFILIATE_CODE_NOT_FOUND', 'Code affilié inconnu.');
    }

    // Le clic éventuel doit appartenir à ce code (donc au même affilié).
    if (input.clickId) {
      const click = await client.query(
        'SELECT id FROM clicks WHERE id = $1 AND user_affiliate_code_id = $2',
        [input.clickId, affiliateCode.id]
      );
      if (click.rows.length === 0) {
        throw new ConversionError(422, 'CLICK_MISMATCH', "Le clic ne correspond pas à ce code affilié.");
      }
    }

    // Insertion idempotente : la conversion est d'abord créée en pending,
    // puis passe au statut demandé via les transitions contrôlées.
    const inserted = await client.query(
      `
        INSERT INTO conversions (user_id, affiliate_link_id, user_affiliate_code_id, click_id,
                                 provider, external_reference, status, amount_cents, currency,
                                 created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NOW(), NOW())
        ON CONFLICT (provider, external_reference) DO NOTHING
        RETURNING *
      `,
      [
        affiliateCode.user_id,
        affiliateCode.affiliate_link_id,
        affiliateCode.id,
        input.clickId,
        input.provider,
        input.externalReference,
        input.amountCents,
        input.currency,
      ]
    );

    const created = inserted.rows.length > 0;
    const existing = await client.query(
      'SELECT * FROM conversions WHERE provider = $1 AND external_reference = $2 FOR UPDATE',
      [input.provider, input.externalReference]
    );
    const conversion = existing.rows[0];

    if (!created) {
      // Un même identifiant externe ne peut pas changer de code ni de montant.
      if (conversion.user_affiliate_code_id !== affiliateCode.id
        || conversion.amount_cents !== input.amountCents
        || conversion.currency !== input.currency) {
        throw new ConversionError(409, 'CONVERSION_CONFLICT', 'Cette référence externe existe déjà avec des données différentes.');
      }
      logger.info('Conversion already known', { conversionId: conversion.id, provider: input.provider });
    } else {
      logger.info('Conversion created', { conversionId: conversion.id, provider: input.provider });
    }

    const { conversion: finalConversion, changed } = await transitionConversion(client, conversion, input.status);

    return { conversion: finalConversion, created, changed: created || changed };
  });
}

/**
 * Changement de statut décidé par un administrateur (journalisé).
 */
async function updateConversionStatus(conversionId, nextStatus, adminUserId) {
  if (!CONVERSION_STATUSES.includes(nextStatus)) {
    throw new ConversionError(400, 'INVALID_STATUS', 'Statut de conversion invalide.');
  }

  return withTransaction(async (client) => {
    const current = await client.query('SELECT * FROM conversions WHERE id = $1 FOR UPDATE', [conversionId]);
    if (current.rows.length === 0) {
      throw new ConversionError(404, 'CONVERSION_NOT_FOUND', 'Conversion introuvable.');
    }

    const previousStatus = current.rows[0].status;
    const { conversion, changed } = await transitionConversion(client, current.rows[0], nextStatus);

    if (changed) {
      await client.query(
        `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details)
         VALUES ($1, 'conversion.status', 'conversion', $2, $3)`,
        [adminUserId, conversionId, JSON.stringify({ from: previousStatus, to: nextStatus })]
      );
    }

    return { conversion, changed };
  });
}

module.exports = {
  recordConversion,
  updateConversionStatus,
  validateConversionInput,
  ConversionError,
  CONVERSION_STATUSES,
  EARNING_STATUSES,
  ALLOWED_CURRENCIES,
  MAX_AMOUNT_CENTS,
};
