const { pool } = require('../config/database');

function parsePagination(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

async function getAdminOverview(req, res, next) {
  try {
    const [usersResult, offersResult, reportsResult, earningsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total_users FROM users`),
      pool.query(`SELECT COUNT(*)::int AS total_offers FROM affiliate_links`),
      pool.query(`SELECT COUNT(*)::int AS total_reports FROM reports`),
      pool.query(`SELECT COALESCE(SUM(amount_cents), 0)::int AS total_earnings FROM earnings WHERE status = 'pending'`)
    ]);

    return res.status(200).json({
      success: true,
      data: {
        users: usersResult.rows[0]?.total_users || 0,
        offers: offersResult.rows[0]?.total_offers || 0,
        reports: reportsResult.rows[0]?.total_reports || 0,
        pending_earnings: earningsResult.rows[0]?.total_earnings || 0,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listUsers(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req);
    const search = String(req.query.search || '').trim();

    const query = `
      SELECT id, username, email, display_name, avatar_url, bio, created_at, updated_at, is_active, is_banned
      FROM users
      WHERE ($1 = '' OR username ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [search, limit, offset]);
    return res.status(200).json({
      success: true,
      data: {
        users: result.rows,
        pagination: { page, limit, offset },
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function updateUserStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { is_active, is_banned } = req.body || {};

    if (typeof is_active !== 'boolean' && typeof is_banned !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'is_active or is_banned must be a boolean.',
        },
      });
    }

    const fields = [];
    const values = [];

    if (typeof is_active === 'boolean') {
      fields.push(`is_active = $${fields.length + 1}`);
      values.push(is_active);
    }

    if (typeof is_banned === 'boolean') {
      fields.push(`is_banned = $${fields.length + 1}`);
      values.push(is_banned);
    }

    fields.push(`updated_at = NOW()`);
    values.push(Number(id));

    const result = await pool.query(
      `
        UPDATE users
        SET ${fields.join(', ')}
        WHERE id = $${values.length}
        RETURNING id, username, email, is_active, is_banned, updated_at
      `,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User was not found.',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        user: result.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listAffiliateLinks(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req);
    const result = await pool.query(
      `
        SELECT id, name, url, description, is_active, created_at, updated_at
        FROM affiliate_links
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    return res.status(200).json({
      success: true,
      data: {
        items: result.rows,
        pagination: { page, limit, offset },
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function createAffiliateLink(req, res, next) {
  try {
    const { name, url, description } = req.body || {};

    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_NAME',
          message: 'Affiliate name must be between 2 and 120 characters.',
        },
      });
    }

    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_URL',
          message: 'Affiliate URL must be a valid HTTP(S) URL.',
        },
      });
    }

    const result = await pool.query(
      `
        INSERT INTO affiliate_links (name, url, description, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, true, NOW(), NOW())
        RETURNING id, name, url, description, is_active, created_at
      `,
      [name.trim(), url.trim(), typeof description === 'string' ? description.trim() : null]
    );

    return res.status(201).json({
      success: true,
      data: {
        offer: result.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listAdminStats(req, res, next) {
  try {
    const result = await pool.query(
      `
        SELECT COALESCE(COUNT(DISTINCT u.id), 0)::int AS total_users,
               COALESCE(SUM(CASE WHEN u.is_active THEN 1 ELSE 0 END), 0)::int AS active_users,
               COALESCE(SUM(CASE WHEN u.is_banned THEN 1 ELSE 0 END), 0)::int AS banned_users,
               COALESCE(SUM(COALESCE(s.total_clicks, 0)), 0)::int AS total_clicks,
               COALESCE(SUM(COALESCE(s.total_conversions, 0)), 0)::int AS total_conversions,
               COALESCE(SUM(COALESCE(s.total_amount_cents, 0)), 0)::int AS total_amount_cents
        FROM users u
        LEFT JOIN stats s ON s.user_id = u.id
      `
    );

    return res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAdminOverview,
  listUsers,
  updateUserStatus,
  listAffiliateLinks,
  createAffiliateLink,
  listAdminStats,
};
