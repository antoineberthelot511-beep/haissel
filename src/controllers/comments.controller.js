const { pool } = require('../config/database');

async function getCommentsByPost(req, res, next) {
  try {
    const { id } = req.params;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const postExists = await pool.query('SELECT id FROM posts WHERE id = $1', [id]);
    if (postExists.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'POST_NOT_FOUND',
          message: 'Post was not found.',
        },
      });
    }

    const query = `
      SELECT
        c.id,
        c.post_id,
        c.user_id,
        c.content,
        c.created_at,
        u.username AS author_username,
        u.display_name AS author_display_name,
        u.avatar_url AS author_avatar_url
      FROM comments c
      INNER JOIN users u ON u.id = c.user_id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [id, limit, offset]);

    return res.status(200).json({
      success: true,
      data: {
        comments: result.rows,
        pagination: { page, limit },
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function createComment(req, res, next) {
  try {
    const { id } = req.params;
    const { content } = req.body || {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Comment content is required.',
        },
      });
    }

    if (content.trim().length > 1000) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Comment content must be at most 1,000 characters.',
        },
      });
    }

    const postExists = await pool.query('SELECT id FROM posts WHERE id = $1', [id]);
    if (postExists.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'POST_NOT_FOUND',
          message: 'Post was not found.',
        },
      });
    }

    const query = `
      INSERT INTO comments (post_id, user_id, content, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING *
    `;

    const result = await pool.query(query, [id, req.user.id, content.trim()]);

    return res.status(201).json({
      success: true,
      data: {
        comment: result.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteComment(req, res, next) {
  try {
    const { id } = req.params;

    const commentResult = await pool.query('SELECT user_id FROM comments WHERE id = $1', [id]);
    if (commentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'COMMENT_NOT_FOUND',
          message: 'Comment was not found.',
        },
      });
    }

    if (commentResult.rows[0].user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You can only delete your own comments.',
        },
      });
    }

    await pool.query('DELETE FROM comments WHERE id = $1', [id]);

    return res.status(200).json({
      success: true,
      data: {
        message: 'Comment deleted successfully.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getCommentsByPost,
  createComment,
  deleteComment,
};
