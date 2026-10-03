const { pool } = require('../config/database');

async function listConversations(req, res, next) {
  try {
    const result = await pool.query(
      `
        SELECT c.id, c.created_at,
               json_agg(json_build_object(
                 'id', u.id,
                 'username', u.username,
                 'display_name', u.display_name,
                 'avatar_url', u.avatar_url
               )) AS participants
        FROM conversations c
        INNER JOIN conversation_members cm ON cm.conversation_id = c.id
        INNER JOIN users u ON u.id = cm.user_id
        WHERE c.id IN (
          SELECT conversation_id FROM conversation_members WHERE user_id = $1
        )
        GROUP BY c.id, c.created_at
        ORDER BY c.created_at DESC
      `,
      [req.user.id]
    );

    return res.status(200).json({
      success: true,
      data: {
        conversations: result.rows,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function createConversation(req, res, next) {
  try {
    const { recipient_id, username } = req.body || {};
    let targetUserId = recipient_id;

    if (!targetUserId && username) {
      const userResult = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'Recipient user was not found.',
          },
        });
      }
      targetUserId = userResult.rows[0].id;
    }

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Recipient is required.',
        },
      });
    }

    if (Number(targetUserId) === req.user.id) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'You cannot start a conversation with yourself.',
        },
      });
    }

    const existingConversation = await pool.query(
      `
        SELECT c.id
        FROM conversations c
        INNER JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
        INNER JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
        LIMIT 1
      `,
      [req.user.id, targetUserId]
    );

    if (existingConversation.rows.length > 0) {
      return res.status(200).json({
        success: true,
        data: {
          conversation: existingConversation.rows[0],
          created: false,
        },
      });
    }

    const conversationResult = await pool.query(
      'INSERT INTO conversations (created_at) VALUES (NOW()) RETURNING *'
    );

    const conversationId = conversationResult.rows[0].id;

    await pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ($1, $2, NOW()), ($3, $4, NOW())',
      [conversationId, req.user.id, conversationId, targetUserId]
    );

    return res.status(201).json({
      success: true,
      data: {
        conversation: conversationResult.rows[0],
        created: true,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function listMessages(req, res, next) {
  try {
    const { id } = req.params;

    const membership = await pool.query(
      'SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 LIMIT 1',
      [id, req.user.id]
    );

    if (membership.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You do not belong to this conversation.',
        },
      });
    }

    const result = await pool.query(
      `
        SELECT m.*, u.username AS sender_username, u.display_name AS sender_display_name
        FROM messages m
        INNER JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at ASC
      `,
      [id]
    );

    return res.status(200).json({
      success: true,
      data: {
        messages: result.rows,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function sendMessage(req, res, next) {
  try {
    const { id } = req.params;
    const { content } = req.body || {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Message content is required.',
        },
      });
    }

    const membership = await pool.query(
      'SELECT id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 LIMIT 1',
      [id, req.user.id]
    );

    if (membership.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You do not belong to this conversation.',
        },
      });
    }

    const recipient = await pool.query(
      `
        SELECT u.id, u.username
        FROM conversation_members cm
        INNER JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1 AND cm.user_id != $2
        LIMIT 1
      `,
      [id, req.user.id]
    );

    const messageResult = await pool.query(
      `
        INSERT INTO messages (conversation_id, sender_id, content, created_at, is_read)
        VALUES ($1, $2, $3, NOW(), false)
        RETURNING *
      `,
      [id, req.user.id, content.trim()]
    );

    if (recipient.rows.length > 0) {
      await pool.query(
        `
          INSERT INTO notifications (user_id, type, message, related_user_id, created_at)
          VALUES ($1, $2, $3, $4, NOW())
        `,
        [recipient.rows[0].id, 'message', `${req.user.username} sent you a message.`, req.user.id]
      );
    }

    return res.status(201).json({
      success: true,
      data: {
        message: messageResult.rows[0],
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listConversations,
  createConversation,
  listMessages,
  sendMessage,
};
