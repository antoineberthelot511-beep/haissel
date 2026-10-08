const { pool } = require('../config/database');

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidCode(value) {
  return /^[A-Z0-9-]{6,80}$/.test(normalizeCode(value));
}

function parsePagination(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

function generateAffiliateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = 'HAI-';
  for (let index = 0; index < 8; index += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function ensureUserAffiliateCode(userId, affiliateLinkId) {
  const existing = await pool.query(
    'SELECT id, code FROM user_affiliate_codes WHERE user_id = $1 AND affiliate_link_id = $2 LIMIT 1',
    [userId, affiliateLinkId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  let code = generateAffiliateCode();
  let attempts = 0;
  while (attempts < 10) {
    const inserted = await pool.query(
      'INSERT INTO user_affiliate_codes (user_id, affiliate_link_id, code, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (code) DO NOTHING RETURNING id, code',
      [userId, affiliateLinkId, code]
    );

    if (inserted.rows.length > 0) {
      return inserted.rows[0];
    }

    code = generateAffiliateCode();
    attempts += 1;
  }

  throw new Error('Could not generate a unique affiliate code.');
}

async function listAffiliateOffers(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req);
    const userId = req.user.id;

    const activeOffers = await pool.query(
      `
        SELECT id, name, url, description, is_active, created_at
        FROM affiliate_links
        WHERE is_active = true
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const items = await Promise.all(activeOffers.rows.map(async (offer) => {
      const codeData = await ensureUserAffiliateCode(userId, offer.id);
      const statRow = await pool.query(
        `
          SELECT COALESCE(s.total_clicks, 0)::int AS total_clicks,
                 COALESCE(s.total_conversions, 0)::int AS total_conversions,
                 COALESCE(s.total_amount_cents, 0)::int AS total_amount_cents
          FROM stats s
          WHERE s.user_id = $1 AND s.user_affiliate_code_id = $2
          LIMIT 1
        `,
        [userId, codeData.id]
      );

      return {
        id: offer.id,
        name: offer.name,
        url: offer.url,
        description: offer.description,
        is_active: offer.is_active,
        created_at: offer.created_at,
        code_id: codeData.id,
        code: codeData.code,
        total_clicks: Number(statRow.rows[0]?.total_clicks || 0),
        total_conversions: Number(statRow.rows[0]?.total_conversions || 0),
        total_amount_cents: Number(statRow.rows[0]?.total_amount_cents || 0),
      };
    }));

    return res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, offset },
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getMyAffiliateStats(req, res, next) {
  try {
    const userId = req.user.id;

    const [codesResult, statsResult, earningsResult] = await Promise.all([
      pool.query(
        `
          SELECT uac.id AS code_id, uac.code, a.name AS offer_name, a.url,
                 COALESCE(s.total_clicks, 0)::int AS total_clicks,
                 COALESCE(s.total_conversions, 0)::int AS total_conversions,
                 COALESCE(s.total_amount_cents, 0)::int AS total_amount_cents
          FROM user_affiliate_codes uac
          INNER JOIN affiliate_links a ON a.id = uac.affiliate_link_id
          LEFT JOIN stats s ON s.user_affiliate_code_id = uac.id AND s.user_id = $1
          WHERE uac.user_id = $1
          ORDER BY uac.created_at DESC
        `,
        [userId]
      ),
      pool.query(
        `
          SELECT COALESCE(SUM(total_clicks), 0)::int AS total_clicks,
                 COALESCE(SUM(total_conversions), 0)::int AS total_conversions
          FROM stats
          WHERE user_id = $1
        `,
        [userId]
      ),
      pool.query(
        `
          SELECT COALESCE(SUM(amount_cents), 0)::int AS total_earnings
          FROM earnings
          WHERE user_id = $1
        `,
        [userId]
      )
    ]);

    const totalClicks = Number(statsResult.rows[0]?.total_clicks || 0);
    const totalConversions = Number(statsResult.rows[0]?.total_conversions || 0);
    const totalEarnings = Number(earningsResult.rows[0]?.total_earnings || 0);

    return res.status(200).json({
      success: true,
      data: {
        codes: codesResult.rows,
        total_clicks: totalClicks,
        total_conversions: totalConversions,
        total_earnings: totalEarnings,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getAffiliateRedirect(req, res, next) {
  try {
    const code = normalizeCode(req.params.code);
    if (!isValidCode(code)) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'AFFILIATE_CODE_NOT_FOUND',
          message: 'Affiliate code was not found.',
        },
      });
    }

    const result = await pool.query(
      `
        SELECT uac.id AS user_affiliate_code_id, uac.user_id, uac.affiliate_link_id, a.url
        FROM user_affiliate_codes uac
        INNER JOIN affiliate_links a ON a.id = uac.affiliate_link_id
        WHERE uac.code = $1 AND a.is_active = true
        LIMIT 1
      `,
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'AFFILIATE_CODE_NOT_FOUND',
          message: 'Affiliate code was not found.',
        },
      });
    }

    const row = result.rows[0];
    const clickResult = await pool.query(
      `
        INSERT INTO clicks (user_id, affiliate_link_id, user_affiliate_code_id, ip_address, user_agent, referrer, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING id
      `,
      [row.user_id, row.affiliate_link_id, row.user_affiliate_code_id, req.ip || null, req.get('user-agent') || null, req.get('referer') || null]
    );

    await pool.query(
      `
        INSERT INTO stats (user_id, affiliate_link_id, user_affiliate_code_id, total_clicks, total_conversions, total_amount_cents, updated_at)
        VALUES ($1, $2, $3, 1, 0, 0, NOW())
        ON CONFLICT (user_id, affiliate_link_id, user_affiliate_code_id)
        DO UPDATE SET
          total_clicks = stats.total_clicks + 1,
          updated_at = NOW()
      `,
      [row.user_id, row.affiliate_link_id, row.user_affiliate_code_id]
    );

    if (clickResult.rows[0]?.id) {
      // keep the click reference in a lightweight way for downstream conversion tracking
    }

    return res.redirect(302, row.url);
  } catch (error) {
    return next(error);
  }
}

async function createConversion(req, res, next) {
  try {
    const { code, click_id, amount_cents, currency, external_reference } = req.body || {};
    const userId = req.user.id;

    if (!code || !isValidCode(code)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_CODE',
          message: 'Affiliate code is required.',
        },
      });
    }

    const normalizedAmount = Number(amount_cents);
    if (!Number.isInteger(normalizedAmount) || normalizedAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: 'amount_cents must be a positive integer.',
        },
      });
    }

    const normalizedCode = normalizeCode(code);
    const codeResult = await pool.query(
      `
        SELECT uac.id AS user_affiliate_code_id, uac.user_id, uac.affiliate_link_id
        FROM user_affiliate_codes uac
        WHERE uac.code = $1 AND uac.user_id = $2
        LIMIT 1
      `,
      [normalizedCode, userId]
    );

    if (codeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'AFFILIATE_CODE_NOT_FOUND',
          message: 'Affiliate code was not found for this user.',
        },
      });
    }

    const affiliateMeta = codeResult.rows[0];
    const clickRef = Number(click_id || 0);
    const conversionResult = await pool.query(
      `
        INSERT INTO conversions (
          user_id,
          affiliate_link_id,
          user_affiliate_code_id,
          click_id,
          external_reference,
          status,
          amount_cents,
          currency,
          created_at,
          processed_at
        )
        VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7, NOW(), NOW())
        RETURNING id, user_id, affiliate_link_id, user_affiliate_code_id, amount_cents, currency, status
      `,
      [userId, affiliateMeta.affiliate_link_id, affiliateMeta.user_affiliate_code_id, clickRef > 0 ? clickRef : null, external_reference || null, normalizedAmount, (currency || 'EUR').toUpperCase()]
    );

    const conversion = conversionResult.rows[0];

    await pool.query(
      `
        INSERT INTO earnings (user_id, affiliate_link_id, user_affiliate_code_id, conversion_id, amount_cents, currency, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
      `,
      [userId, affiliateMeta.affiliate_link_id, affiliateMeta.user_affiliate_code_id, conversion.id, normalizedAmount, (currency || 'EUR').toUpperCase()]
    );

    await pool.query(
      `
        INSERT INTO stats (user_id, affiliate_link_id, user_affiliate_code_id, total_clicks, total_conversions, total_amount_cents, updated_at)
        VALUES ($1, $2, $3, 0, 1, $4, NOW())
        ON CONFLICT (user_id, affiliate_link_id, user_affiliate_code_id)
        DO UPDATE SET
          total_conversions = stats.total_conversions + 1,
          total_amount_cents = stats.total_amount_cents + EXCLUDED.total_amount_cents,
          updated_at = NOW()
      `,
      [userId, affiliateMeta.affiliate_link_id, affiliateMeta.user_affiliate_code_id, normalizedAmount]
    );

    return res.status(201).json({
      success: true,
      data: {
        conversion: conversion,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listAffiliateOffers,
  getMyAffiliateStats,
  getAffiliateRedirect,
  createConversion,
};
