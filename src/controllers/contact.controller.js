/*
 * Formulaire de contact (/contact) : accessible avec ou sans compte.
 *
 *  - sujet dans une liste fermée, message de 20 à 2000 caractères (texte brut) ;
 *  - e-mail de réponse facultatif pour un membre connecté, obligatoire sinon ;
 *  - Turnstile (contact.routes), 3 envois par heure par IP (limiteur) et par
 *    compte (compté ici en base) ;
 *  - les ADMIN reçoivent une notification Web Push sans le contenu.
 * Les demandes sont supprimées 12 mois après l'envoi (retention.service).
 */
const { pool } = require('../config/database');
const { sendError, parseId } = require('../utils/http');
const { logger } = require('../utils/logger');
const { loadSession, isValidCsrfToken } = require('../services/session.service');
const push = require('../services/push.service');

const SUBJECTS = {
  question: 'Question',
  report: 'Signaler un contenu',
  privacy: 'Données personnelles (RGPD)',
  other: 'Autre',
};
const MESSAGE_MIN = 20;
const MESSAGE_MAX = 2000;
const PER_ACCOUNT_PER_HOUR = 3;
const PUSH_TIMEOUT_MS = 3000;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function validateContact(body, { signedIn }) {
  const source = body || {};
  const subject = typeof source.subject === 'string' ? source.subject : '';
  if (!Object.prototype.hasOwnProperty.call(SUBJECTS, subject)) {
    return { error: ['INVALID_SUBJECT', 'Choisis un sujet dans la liste.', 'subject'] };
  }
  const raw = typeof source.message === 'string' ? source.message : '';
  const message = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if ([...message].length < MESSAGE_MIN || [...message].length > MESSAGE_MAX) {
    return { error: ['INVALID_MESSAGE', `Ton message doit contenir entre ${MESSAGE_MIN} et ${MESSAGE_MAX} caractères.`, 'message'] };
  }
  const email = typeof source.reply_email === 'string' ? source.reply_email.trim().toLowerCase() : '';
  if (!email && !signedIn) {
    return { error: ['EMAIL_REQUIRED', 'Indique une adresse e-mail pour qu’on puisse te répondre.', 'reply_email'] };
  }
  if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) {
    return { error: ['INVALID_EMAIL', 'L’adresse e-mail est invalide.', 'reply_email'] };
  }
  return { value: { subject, message, replyEmail: email || null } };
}

/*
 * Membre connecté (facultatif) : la session est lue si elle existe, et le
 * jeton CSRF est alors exigé comme sur toute route authentifiée.
 */
async function optionalUser(req) {
  const session = await loadSession(req);
  if (!session || session.mfaPending) return { user: null };
  if (!isValidCsrfToken(session.tokenHash, req.get('x-csrf-token'))) return { csrfRejected: true };
  return { user: session.user };
}

async function notifyAdmins(requestId) {
  let timer;
  try {
    const admins = await pool.query(
      `SELECT a.user_id FROM admins a INNER JOIN users u ON u.id = a.user_id
       WHERE a.role = 'ADMIN' AND u.is_active AND NOT u.is_banned`
    );
    if (!admins.rows.length) return;
    // Sans le contenu : il ne transite pas par les services de notification.
    const message = { title: 'HAISSEL Admin', body: 'Nouvelle demande de contact', url: '/admin#contact', tag: `contact-${requestId}` };
    const all = Promise.all(admins.rows.map((row) => push.sendToUser(row.user_id, message, { urgency: 'high' }).catch(() => null)));
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, PUSH_TIMEOUT_MS); });
    await Promise.race([all, timeout]);
  } catch (error) {
    logger.warn('Contact push error', { requestId, error: error.message });
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/contact */
async function submit(req, res, next) {
  try {
    const { user, csrfRejected } = await optionalUser(req);
    if (csrfRejected) return sendError(res, 403, 'CSRF_REJECTED', 'Requête refusée. Recharge la page puis réessaie.');

    const { error, value } = validateContact(req.body, { signedIn: Boolean(user) });
    if (error) return sendError(res, 400, error[0], error[1], { field: error[2] });

    if (user) {
      const recent = await pool.query(
        `SELECT COUNT(*)::int AS n FROM contact_requests WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [user.id]
      );
      if (recent.rows[0].n >= PER_ACCOUNT_PER_HOUR) {
        return sendError(res, 429, 'TOO_MANY_REQUESTS', 'Tu as déjà envoyé 3 demandes cette heure-ci. Réessaie plus tard.');
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO contact_requests (user_id, subject, message, reply_email)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [user ? user.id : null, value.subject, value.message, value.replyEmail]
    );
    await notifyAdmins(rows[0].id);
    return res.status(201).json({ success: true, data: { id: rows[0].id } });
  } catch (error) {
    return next(error);
  }
}

function formatRequest(row) {
  return {
    id: row.id,
    subject: row.subject,
    subject_label: SUBJECTS[row.subject] || row.subject,
    message: row.message,
    reply_email: row.reply_email,
    username: row.username || null,
    account_email: row.account_email || null,
    created_at: row.created_at,
    handled_at: row.handled_at,
  };
}

/** GET /api/admin/contact : non traitées d'abord. */
async function adminList(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, u.username, u.email AS account_email
       FROM contact_requests c LEFT JOIN users u ON u.id = c.user_id
       ORDER BY (c.handled_at IS NULL) DESC, c.created_at DESC
       LIMIT 200`
    );
    return res.json({ success: true, data: { items: rows.map(formatRequest) } });
  } catch (error) {
    return next(error);
  }
}

/** POST /api/admin/contact/:id/handled */
async function adminMarkHandled(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (!id) return sendError(res, 400, 'INVALID_ID', 'Identifiant invalide.');
    const { rows } = await pool.query(
      `UPDATE contact_requests SET handled_at = COALESCE(handled_at, NOW()) WHERE id = $1 RETURNING id, handled_at`,
      [id]
    );
    if (!rows.length) return sendError(res, 404, 'NOT_FOUND', 'Demande introuvable.');
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return next(error);
  }
}

module.exports = { SUBJECTS, validateContact, submit, adminList, adminMarkHandled };
