const { pool } = require('../config/database');

async function listNotifications(req, res, next) {
  try {
    const result = await pool.query(
      `
        SELECT n.*,
               u.username AS related_username,
               u.display_name AS related_display_name,
               p.content AS related_post_content
        FROM notifications n
        LEFT JOIN users u ON u.id = n.related_user_id
        LEFT JOIN posts p ON p.id = n.related_post_id
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
      `,
      [req.user.id]
    );

    return res.status(200).json({
      success: true,
      data: {
        notifications: result.rows,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationAsRead(req, res, next) {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOTIFICATION_NOT_FOUND',
          message: 'Notification was not found.',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        notification: result.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listNotifications,
  markNotificationAsRead,
};
