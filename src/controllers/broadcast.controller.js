const crypto = require('crypto');
const { pool } = require('../config/database');
const realtime = require('../services/realtime.service');
const { isVercel } = require('../config/security');
const { sendError, parsePagination } = require('../utils/http');
const { logger } = require('../utils/logger');

/*
 * Centre de notifications administrateur.
 *
 * - GET  /api/notifications/stream      flux SSE de l'utilisateur connecté
 * - GET  /api/notifications/poll        interrogation régulière (Vercel)
 * - POST /api/notifications/:id/ack     accusé d'affichage envoyé par le client
 * - POST /api/admin/notifications       diffusion (admin uniquement)
 * - GET  /api/admin/notifications       historique
 * - GET  /api/admin/notifications/presence
 *
 * Le contenu est du TEXTE BRUT : il n'est jamais interprété comme du HTML,
 * ni par le serveur ni par les clients (textContent). Aucune commande n'est
 * transmise aux postes : seulement titre, message, date et un lien interne.
 */

const LIMITS = { title: 80, message: 500, url: 200 };

// Liens internes autorisés (espace utilisateur uniquement).
const ALLOWED_URL = /^\/(?:app|mes-affilies|go\/\d{1,10})?(?:#[A-Za-z0-9_-]{1,40})?$/;

// Caractères de contrôle (tabulations et sauts de ligne sont normalisés à
// part), espaces invisibles et caractères bidirectionnels utilisables pour tromper l'affichage.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function normalizeText(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return null;
  let text = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  text = multiline
    ? text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n')
    : text.replace(/\s+/g, ' ');
  return text.trim();
}

/** Valide le corps d'une diffusion. Retourne { value } ou { error }. */
function validateBroadcast(body) {
  const input = body && typeof body === 'object' ? body : {};
  const title = normalizeText(input.title);
  const message = normalizeText(input.message, { multiline: true });

  if (!title) return { error: 'Le titre est obligatoire.' };
  if ([...title].length > LIMITS.title) return { error: `Le titre ne doit pas dépasser ${LIMITS.title} caractères.` };
  if (!message) return { error: 'Le message est obligatoire.' };
  if ([...message].length > LIMITS.message) return { error: `Le message ne doit pas dépasser ${LIMITS.message} caractères.` };

  const target = input.target === undefined ? 'connected_users' : input.target;
  if (target !== 'connected_users') return { error: 'Cible invalide.' };

  let url = null;
  if (input.url !== undefined && input.url !== null && input.url !== '') {
    if (typeof input.url !== 'string' || input.url.length > LIMITS.url) {
      return { error: `L'adresse de destination ne doit pas dépasser ${LIMITS.url} caractères.` };
    }
    const candidate = input.url.trim();
    if (!ALLOWED_URL.test(candidate)) {
      return { error: 'Destination invalide : seuls les liens internes /app, /mes-affilies ou /go/<id> sont autorisés.' };
    }
    url = candidate;
  }

  return { value: { title, message, url, target } };
}

// ---------------------------------------------------------------------------
// Flux SSE
// ---------------------------------------------------------------------------

function openStream(req, res) {
  const connection = realtime.register({
    req,
    res,
    userId: req.user.id,
    sessionId: req.session.id,
    tokenHash: req.session.tokenHash,
  });
  if (!connection) {
    return sendError(res, 503, 'REALTIME_FULL', 'Trop de connexions temps réel. Réessayez plus tard.');
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Nginx : pas de mise en tampon, sinon les événements arrivent en retard.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  // retry : délai de reconnexion conseillé au navigateur (ms).
  res.write('retry: 5000\n\n');
  realtime.writeEvent(connection, 'ready', { connection_id: connection.id });
  return undefined;
}

async function acknowledge(req, res, next) {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Identifiant invalide.');
    }
    const mode = (req.body || {}).mode;
    if (mode !== 'system' && mode !== 'in_app') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Mode d’affichage invalide.');
    }

    // Seul un destinataire réel peut confirmer, et une seule fois.
    const result = await pool.query(
      `
        UPDATE notification_recipients r
        SET displayed_at = NOW(), display_mode = $3
        FROM notification_broadcasts b
        WHERE b.id = r.broadcast_id AND b.public_id = $1 AND r.user_id = $2
          AND r.displayed_at IS NULL
        RETURNING r.broadcast_id
      `,
      [id, req.user.id, mode]
    );
    return res.status(200).json({ success: true, data: { recorded: result.rowCount === 1 } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Interrogation régulière (Vercel)
// ---------------------------------------------------------------------------

/*
 * Sur Vercel, plusieurs instances répondent sans mémoire partagée : le
 * registre des flux SSE d'une instance ne connaît pas les connexions des
 * autres, donc le flux ne peut pas servir de canal de diffusion. Le client
 * interroge cet endpoint toutes les 45 s (voir frontend/notifications.js).
 *
 * « since » est le curseur rendu par l'appel précédent (notification_broadcasts.id,
 * une simple séquence interne). Sans « since », aucun élément n'est renvoyé :
 * seul le curseur courant est communiqué, pour que l'ouverture d'un onglet
 * n'affiche pas d'un coup tout l'historique. Le comportement reste celui du
 * SSE : on ne reçoit que ce qui est diffusé pendant que la page est ouverte.
 */
const POLL_MAX_ITEMS = 20;

async function pollNotifications(req, res, next) {
  try {
    const raw = Number.parseInt(req.query.since, 10);
    const hasCursor = Number.isInteger(raw) && raw >= 0;

    if (!hasCursor) {
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(broadcast_id), 0)::int AS cursor
         FROM notification_recipients WHERE user_id = $1`,
        [req.user.id]
      );
      return res.status(200).json({ success: true, data: { items: [], cursor: rows[0].cursor } });
    }

    const { rows } = await pool.query(
      `
        SELECT b.id AS cursor, b.public_id AS id, b.title, b.message,
               b.target_url AS url, b.created_at
        FROM notification_recipients r
        INNER JOIN notification_broadcasts b ON b.id = r.broadcast_id
        WHERE r.user_id = $1 AND b.id > $2
        ORDER BY b.id ASC
        LIMIT $3
      `,
      [req.user.id, raw, POLL_MAX_ITEMS]
    );

    return res.status(200).json({
      success: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          message: row.message,
          url: row.url,
          sent_at: row.created_at.toISOString(),
        })),
        cursor: rows.length ? rows[rows.length - 1].cursor : raw,
      },
    });
  } catch (error) {
    return next(error);
  }
}

/*
 * Destinataires d'une diffusion en mode interrogation : les utilisateurs dont
 * une session est encore valide. Même filtre que realtime.revalidateSessions()
 * — session non révoquée, non expirée, hors délai d'inactivité, compte actif
 * et non banni — pour que les deux modes visent la même population.
 *
 * DIFFÉRENCE ASSUMÉE avec le SSE : « session valide » est plus large que
 * « onglet ouvert ». Quelqu'un dont l'onglet est fermé mais la session encore
 * valide verra la notification à sa prochaine visite (dans les 45 s). Sans
 * mémoire partagée, aucune instance ne peut savoir quels onglets sont ouverts.
 */
async function sessionRecipients() {
  const { rows } = await pool.query(
    `
      SELECT DISTINCT s.user_id
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL
        AND s.mfa_pending = false
        AND s.expires_at > NOW()
        AND s.last_seen_at + make_interval(secs => s.idle_timeout_seconds) > NOW()
        AND u.is_active = true
        AND u.is_banned = false
    `
  );
  return rows.map((row) => row.user_id);
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

function statusFor(stats) {
  if (stats.connectedUserIds.length === 0) return 'no_recipients';
  if (stats.deliveredUserIds.length === 0) return 'failed';
  if (stats.failedConnections > 0) return 'partial';
  return 'delivered';
}

async function sendBroadcast(req, res, next) {
  const { value, error } = validateBroadcast(req.body);
  if (error) return sendError(res, 400, 'VALIDATION_ERROR', error);

  const publicId = crypto.randomUUID();
  let broadcastId;

  try {
    const inserted = await pool.query(
      `INSERT INTO notification_broadcasts (public_id, admin_user_id, title, message, target_url, target)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [publicId, req.user.id, value.title, value.message, value.url, value.target]
    );
    broadcastId = inserted.rows[0].id;

    const event = {
      id: publicId,
      title: value.title,
      message: value.message,
      url: value.url,
      sent_at: inserted.rows[0].created_at.toISOString(),
    };

    /*
     * Deux canaux :
     *  - SSE (local, Docker) : écriture immédiate dans les flux ouverts, les
     *    statistiques viennent des connexions réellement servies ;
     *  - interrogation (Vercel) : rien à écrire, la diffusion consiste à
     *    enregistrer les destinataires, que leur navigateur viendra chercher
     *    dans les 45 s. « delivered_connections » reste à 0 : aucun onglet
     *    n'est joignable directement, et un faux chiffre serait trompeur.
     */
    let stats;
    try {
      if (isVercel()) {
        const userIds = await sessionRecipients();
        stats = {
          connectedUserIds: userIds,
          deliveredUserIds: userIds,
          deliveredConnections: 0,
          failedConnections: 0,
        };
      } else {
        stats = await realtime.broadcast('admin-notification', event, publicId);
      }
    } catch (broadcastError) {
      await pool.query(
        "UPDATE notification_broadcasts SET status = 'failed', completed_at = NOW() WHERE id = $1",
        [broadcastId]
      );
      logger.error('Notification broadcast failed', { broadcastId, error: broadcastError.message });
      return sendError(res, 500, 'BROADCAST_FAILED', 'La diffusion a échoué. Aucune notification n’a été envoyée.');
    }

    const status = statusFor(stats);
    await pool.query(
      `UPDATE notification_broadcasts
       SET connected_users = $2, delivered_users = $3, delivered_connections = $4,
           failed_connections = $5, status = $6, completed_at = NOW()
       WHERE id = $1`,
      [broadcastId, stats.connectedUserIds.length, stats.deliveredUserIds.length,
        stats.deliveredConnections, stats.failedConnections, status]
    );
    if (stats.deliveredUserIds.length > 0) {
      await pool.query(
        `INSERT INTO notification_recipients (broadcast_id, user_id)
         SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
        [broadcastId, stats.deliveredUserIds]
      );
    }
    await pool.query(
      `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details)
       VALUES ($1, 'notification.broadcast', 'notification_broadcast', $2, $3)`,
      [req.user.id, broadcastId, JSON.stringify({ status, delivered_users: stats.deliveredUserIds.length })]
    );
    logger.info('Notification broadcast', { adminId: req.user.id, broadcastId, status });

    return res.status(201).json({
      success: true,
      data: {
        broadcast: {
          id: publicId,
          status,
          mode: isVercel() ? 'poll' : 'sse',
          connected_users: stats.connectedUserIds.length,
          delivered_users: stats.deliveredUserIds.length,
          delivered_connections: stats.deliveredConnections,
          failed_connections: stats.failedConnections,
        },
      },
    });
  } catch (dbError) {
    return next(dbError);
  }
}

async function listBroadcasts(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query, 50);
    const result = await pool.query(
      `
        SELECT b.public_id AS id, b.title, b.message, b.target_url AS url, b.status,
               b.connected_users, b.delivered_users, b.delivered_connections, b.failed_connections,
               b.created_at, u.username AS admin_username,
               (SELECT COUNT(*)::int FROM notification_recipients r
                 WHERE r.broadcast_id = b.id AND r.displayed_at IS NOT NULL) AS displayed_users
        FROM notification_broadcasts b
        LEFT JOIN users u ON u.id = b.admin_user_id
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );
    return res.status(200).json({ success: true, data: { items: result.rows, pagination: { page, limit } } });
  } catch (error) {
    return next(error);
  }
}

/*
 * Présence : le nombre d'utilisateurs connectés vient du registre en mémoire
 * des flux SSE. Sur Vercel, chaque instance n'a que ses propres connexions,
 * donc aucun chiffre global n'existe. On le dit explicitement plutôt que de
 * renvoyer le compte partiel d'une instance, qui serait faux.
 */
function getPresence(req, res) {
  if (isVercel()) {
    return res.status(200).json({
      success: true,
      data: {
        available: false,
        mode: 'poll',
        poll_interval_seconds: 45,
        limits: LIMITS,
      },
    });
  }
  return res.status(200).json({
    success: true,
    data: { available: true, mode: 'sse', ...realtime.presence(), limits: LIMITS },
  });
}

module.exports = {
  openStream,
  pollNotifications,
  acknowledge,
  sendBroadcast,
  listBroadcasts,
  getPresence,
  validateBroadcast,
  LIMITS,
};
