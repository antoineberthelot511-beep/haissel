/*
 * Messagerie membre ↔ équipe HAISSEL.
 *
 * Chaque membre a UNE conversation, avec l'équipe ; aucune route ne permet
 * d'écrire à un autre membre : le membre n'indique jamais de destinataire,
 * le serveur prend toujours SA conversation. Les ADMIN lisent toutes les
 * conversations et répondent au nom de l'équipe (console).
 *
 * Texte brut (2000 caractères maximum), affiché côté navigateur avec
 * textContent. Les conversations sont supprimées 12 mois après le dernier
 * échange (retention.service.js).
 */
const { pool, withTransaction } = require('../config/database');
const { sendError, parseId } = require('../utils/http');
const { logger } = require('../utils/logger');

const MAX_LENGTH = 2000;
const MEMBER_MESSAGES_PER_HOUR = 20;
const PAGE = 200;

function readContent(body) {
  const raw = typeof body?.content === 'string' ? body.content : '';
  // Texte brut : on retire seulement les caractères de contrôle (sauf retours à la ligne).
  const content = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!content) return { error: 'Écris un message avant d’envoyer.' };
  if (content.length > MAX_LENGTH) return { error: `Ton message dépasse ${MAX_LENGTH} caractères.` };
  return { content };
}

function formatMessage(row) {
  return { id: row.id, content: row.content, from_team: row.from_team, is_read: row.is_read, created_at: row.created_at };
}

async function listMessages(client, conversationId) {
  const { rows } = await client.query(
    `SELECT * FROM (
       SELECT id, content, from_team, is_read, created_at FROM messages
       WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${PAGE}
     ) recent ORDER BY created_at, id`,
    [conversationId]
  );
  return rows.map(formatMessage);
}

// ---------------------------------------------------------------------------
// Membre
// ---------------------------------------------------------------------------

/** GET /api/messages/team : la conversation du membre ; les réponses de l'équipe passent en « lues ». */
async function getTeamConversation(req, res, next) {
  try {
    const found = await pool.query('SELECT id FROM conversations WHERE member_id = $1', [req.user.id]);
    const conversation = found.rows[0];
    if (!conversation) return res.status(200).json({ success: true, data: { messages: [], unread: 0 } });
    await pool.query(
      'UPDATE messages SET is_read = true WHERE conversation_id = $1 AND from_team AND NOT is_read', [conversation.id]
    );
    return res.status(200).json({ success: true, data: { messages: await listMessages(pool, conversation.id), unread: 0 } });
  } catch (error) {
    return next(error);
  }
}

/*
 * GET /api/messages/unread : nombre de réponses de l'équipe non lues (pastille)
 * et dernier message (aperçu de la liste). Lecture seule : rien ne passe en « lu ».
 */
async function getUnreadCount(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.member_id = $1 AND m.from_team AND NOT m.is_read`,
      [req.user.id]
    );
    const last = await pool.query(
      `SELECT m.content, m.from_team, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.member_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
      [req.user.id]
    );
    const row = last.rows[0];
    return res.status(200).json({
      success: true,
      data: {
        unread: rows[0].n,
        last: row ? { content: row.content.slice(0, 120), from_team: row.from_team, created_at: row.created_at } : null,
      },
    });
  } catch (error) {
    return next(error);
  }
}

/** POST /api/messages/team : écrire à l'équipe. Aucun destinataire n'est lu dans la requête. */
async function sendToTeam(req, res, next) {
  try {
    const { content, error } = readContent(req.body);
    if (error) return sendError(res, 400, 'INVALID_MESSAGE', error, { field: 'content' });

    const outcome = await withTransaction(async (client) => {
      // Verrou par membre : deux envois simultanés ne contournent pas la limite.
      await client.query('SELECT pg_advisory_xact_lock(4210, $1)', [req.user.id]);
      const recent = await client.query(
        `SELECT COUNT(*)::int AS n FROM messages
         WHERE sender_id = $1 AND NOT from_team AND created_at > NOW() - INTERVAL '1 hour'`,
        [req.user.id]
      );
      if (recent.rows[0].n >= MEMBER_MESSAGES_PER_HOUR) return { limited: true };

      const conversation = await client.query(
        `INSERT INTO conversations (member_id, last_message_at) VALUES ($1, NOW())
         ON CONFLICT (member_id) WHERE member_id IS NOT NULL DO UPDATE SET last_message_at = NOW()
         RETURNING id`,
        [req.user.id]
      );
      const inserted = await client.query(
        `INSERT INTO messages (conversation_id, sender_id, content, from_team)
         VALUES ($1, $2, $3, false) RETURNING id, content, from_team, is_read, created_at`,
        [conversation.rows[0].id, req.user.id, content]
      );
      return { message: formatMessage(inserted.rows[0]) };
    });
    if (outcome.limited) {
      return sendError(res, 429, 'RATE_LIMITED',
        `Tu as envoyé ${MEMBER_MESSAGES_PER_HOUR} messages dans l’heure. Réessaie un peu plus tard.`);
    }
    return res.status(201).json({ success: true, data: { message: outcome.message } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Équipe (console ADMIN)
// ---------------------------------------------------------------------------

/** GET /api/admin/messages : toutes les conversations, non lues d'abord. */
async function adminListConversations(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.last_message_at, u.username,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND NOT m.from_team AND NOT m.is_read)::int AS unread,
              (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_content,
              (SELECT m.from_team FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_from_team
       FROM conversations c JOIN users u ON u.id = c.member_id
       WHERE c.member_id IS NOT NULL
       ORDER BY (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND NOT m.from_team AND NOT m.is_read) > 0 DESC,
                c.last_message_at DESC NULLS LAST
       LIMIT 200`
    );
    const items = rows.map((row) => ({
      id: row.id, username: row.username, unread: row.unread, last_message_at: row.last_message_at,
      preview: row.last_content ? row.last_content.slice(0, 120) : '', last_from_team: row.last_from_team,
    }));
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/admin/messages/:id : une conversation ; les messages du membre passent en « lus ». */
async function adminGetConversation(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Conversation invalide.');
    const found = await pool.query(
      `SELECT c.id, u.username FROM conversations c JOIN users u ON u.id = c.member_id
       WHERE c.id = $1 AND c.member_id IS NOT NULL`,
      [id]
    );
    if (!found.rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Conversation introuvable.');
    await pool.query('UPDATE messages SET is_read = true WHERE conversation_id = $1 AND NOT from_team AND NOT is_read', [id]);
    return res.status(200).json({
      success: true,
      data: { id, username: found.rows[0].username, messages: await listMessages(pool, id) },
    });
  } catch (error) {
    return next(error);
  }
}

/** POST /api/admin/messages/:id : répondre au nom de l'équipe. */
async function adminReply(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Conversation invalide.');
    const { content, error } = readContent(req.body);
    if (error) return sendError(res, 400, 'INVALID_MESSAGE', error, { field: 'content' });
    const message = await withTransaction(async (client) => {
      const updated = await client.query(
        'UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND member_id IS NOT NULL RETURNING id', [id]
      );
      if (!updated.rows[0]) return null;
      // Répondre vaut lecture des messages du membre.
      await client.query('UPDATE messages SET is_read = true WHERE conversation_id = $1 AND NOT from_team AND NOT is_read', [id]);
      const inserted = await client.query(
        `INSERT INTO messages (conversation_id, sender_id, content, from_team)
         VALUES ($1, $2, $3, true) RETURNING id, content, from_team, is_read, created_at`,
        [id, req.user.id, content]
      );
      return formatMessage(inserted.rows[0]);
    });
    if (!message) return sendError(res, 404, 'NOT_FOUND', 'Conversation introuvable.');
    logger.info('Admin action', { adminId: req.user.id, action: 'team_message.reply', targetId: id });
    return res.status(201).json({ success: true, data: { message } });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getTeamConversation,
  getUnreadCount,
  sendToTeam,
  adminListConversations,
  adminGetConversation,
  adminReply,
  MAX_LENGTH,
  MEMBER_MESSAGES_PER_HOUR,
};
