const { pool } = require('../config/database');

async function createReport(req, res, next) {
  try {
    const { target_type, target_id, reason } = req.body || {};

    if (!target_type || !target_id || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'target_type, target_id and reason are required.',
        },
      });
    }

    if (!['post', 'comment', 'user', 'message'].includes(String(target_type).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TARGET_TYPE',
          message: 'target_type must be one of: post, comment, user, message.',
        },
      });
    }

    if (!Number.isInteger(Number(target_id))) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TARGET_ID',
          message: 'target_id must be an integer.',
        },
      });
    }

    if (Number(target_id) < 1 || reason.trim().length > 1000) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'target_id must be positive and reason must be at most 1,000 characters.',
        },
      });
    }

    const targetTables = {
      post: 'posts',
      comment: 'comments',
      user: 'users',
      message: 'messages',
    };
    const targetExists = await pool.query(
      `SELECT id FROM ${targetTables[String(target_type).toLowerCase()]} WHERE id = $1 LIMIT 1`,
      [Number(target_id)]
    );

    if (targetExists.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'REPORT_TARGET_NOT_FOUND',
          message: 'The item you are trying to report was not found.',
        },
      });
    }

    const result = await pool.query(
      `
        INSERT INTO reports (reporter_id, target_type, target_id, reason, status, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *
      `,
      [req.user.id, String(target_type).toLowerCase(), Number(target_id), reason.trim(), 'pending']
    );

    return res.status(201).json({
      success: true,
      data: {
        report: result.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listReports(req, res, next) {
  try {
    const result = await pool.query(
      `
        SELECT r.*, u.username AS reporter_username
        FROM reports r
        INNER JOIN users u ON u.id = r.reporter_id
        ORDER BY r.created_at DESC
      `
    );

    return res.status(200).json({
      success: true,
      data: {
        reports: result.rows,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function updateReportStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!status || !['pending', 'reviewing', 'resolved', 'dismissed'].includes(String(status).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'status must be one of: pending, reviewing, resolved, dismissed.',
        },
      });
    }

    const result = await pool.query(
      `
        UPDATE reports
        SET status = $1, resolved_at = CASE WHEN $1 IN ('resolved', 'dismissed') THEN NOW() ELSE NULL END
        WHERE id = $2
        RETURNING *
      `,
      [String(status).toLowerCase(), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'REPORT_NOT_FOUND',
          message: 'Report was not found.',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        report: result.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createReport,
  listReports,
  updateReportStatus,
};
