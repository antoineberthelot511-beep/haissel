const { pool } = require('../config/database');

function formatPostRow(post) {
  return {
    id: post.id,
    user_id: post.user_id,
    content: post.content,
    image_url: post.image_url,
    created_at: post.created_at,
    updated_at: post.updated_at,
    author: post.author
      ? {
          id: post.author_id,
          username: post.author_username,
          display_name: post.author_display_name,
          avatar_url: post.author_avatar_url,
        }
      : null,
    likes_count: Number(post.likes_count || 0),
    comments_count: Number(post.comments_count || 0),
  };
}

async function listPosts(req, res, next) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const query = `
      SELECT
        p.id,
        p.user_id,
        p.content,
        p.image_url,
        p.created_at,
        p.updated_at,
        u.id AS author_id,
        u.username AS author_username,
        u.display_name AS author_display_name,
        u.avatar_url AS author_avatar_url,
        COUNT(DISTINCT l.id) AS likes_count,
        COUNT(DISTINCT c.id) AS comments_count
      FROM posts p
      INNER JOIN users u ON u.id = p.user_id
      LEFT JOIN likes l ON l.post_id = p.id
      LEFT JOIN comments c ON c.post_id = p.id
      GROUP BY p.id, u.id, u.username, u.display_name, u.avatar_url
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);

    return res.status(200).json({
      success: true,
      data: {
        posts: result.rows.map(formatPostRow),
        pagination: { page, limit },
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function getPostById(req, res, next) {
  try {
    const { id } = req.params;

    const query = `
      SELECT
        p.id,
        p.user_id,
        p.content,
        p.image_url,
        p.created_at,
        p.updated_at,
        u.id AS author_id,
        u.username AS author_username,
        u.display_name AS author_display_name,
        u.avatar_url AS author_avatar_url,
        COUNT(DISTINCT l.id) AS likes_count,
        COUNT(DISTINCT c.id) AS comments_count
      FROM posts p
      INNER JOIN users u ON u.id = p.user_id
      LEFT JOIN likes l ON l.post_id = p.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.id = $1
      GROUP BY p.id, u.id, u.username, u.display_name, u.avatar_url
      LIMIT 1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'POST_NOT_FOUND',
          message: 'Post was not found.',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        post: formatPostRow(result.rows[0]),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function createPost(req, res, next) {
  try {
    const { content, image_url } = req.body || {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Post content is required.',
        },
      });
    }

    const trimmedContent = content.trim();
    if (trimmedContent.length > 2000 || !isValidImageUrl(image_url)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Post content must be at most 2,000 characters and image_url must be a valid HTTP(S) URL.',
        },
      });
    }

    const query = `
      INSERT INTO posts (user_id, content, image_url, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING *
    `;

    const result = await pool.query(query, [req.user.id, trimmedContent, image_url || null]);

    const post = result.rows[0];

    return res.status(201).json({
      success: true,
      data: {
        post: formatPostRow({
          ...post,
          author: null,
          likes_count: 0,
          comments_count: 0,
        }),
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function updatePost(req, res, next) {
  try {
    const { id } = req.params;
    const { content, image_url } = req.body || {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Post content is required.',
        },
      });
    }

    if (content.trim().length > 2000 || !isValidImageUrl(image_url)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Post content must be at most 2,000 characters and image_url must be a valid HTTP(S) URL.',
        },
      });
    }

    const existing = await pool.query('SELECT user_id FROM posts WHERE id = $1', [id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'POST_NOT_FOUND',
          message: 'Post was not found.',
        },
      });
    }

    if (existing.rows[0].user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You can only update your own posts.',
        },
      });
    }

    const result = await pool.query(
      `
        UPDATE posts
        SET content = $1, image_url = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `,
      [content.trim(), image_url || null, id]
    );

    return res.status(200).json({
      success: true,
      data: {
        post: formatPostRow({
          ...result.rows[0],
          author: null,
          likes_count: 0,
          comments_count: 0,
        }),
      },
    });
  } catch (error) {
    return next(error);
  }
}

function isValidImageUrl(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }

  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

async function deletePost(req, res, next) {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT user_id FROM posts WHERE id = $1', [id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'POST_NOT_FOUND',
          message: 'Post was not found.',
        },
      });
    }

    if (existing.rows[0].user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You can only delete your own posts.',
        },
      });
    }

    await pool.query('DELETE FROM posts WHERE id = $1', [id]);

    return res.status(200).json({
      success: true,
      data: {
        message: 'Post deleted successfully.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function likePost(req, res, next) {
  try {
    const { id } = req.params;

    const postCheck = await pool.query('SELECT id FROM posts WHERE id = $1', [id]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'POST_NOT_FOUND',
          message: 'Post was not found.',
        },
      });
    }

    await pool.query(
      `
        INSERT INTO likes (post_id, user_id, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (post_id, user_id) DO NOTHING
      `,
      [id, req.user.id]
    );

    return res.status(200).json({
      success: true,
      data: {
        message: 'Post liked successfully.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function unlikePost(req, res, next) {
  try {
    const { id } = req.params;

    await pool.query(
      'DELETE FROM likes WHERE post_id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    return res.status(200).json({
      success: true,
      data: {
        message: 'Like removed successfully.',
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listPosts,
  getPostById,
  createPost,
  updatePost,
  deletePost,
  likePost,
  unlikePost,
};
