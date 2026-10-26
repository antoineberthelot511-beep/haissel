const { pool } = require('../config/database');

/*
 * GET /api/messages/activity : page « Activité » du membre. LECTURE SEULE : chaque
 * événement est déduit d'une table existante, rien n'est écrit.
 *
 *  - offer_published : fiche campagne validée (member_offers.moderated_at) ;
 *  - offer_rejected  : fiche refusée (moderated_at, note de modération) ;
 *  - offer_removed   : fiche retirée par l'équipe (décision de modération « remove ») ;
 *  - story_extended  : story prolongée par l'équipe (admin_actions) ;
 *  - story_expired   : story arrivée au bout de ses 24 h (expires_at passé) ;
 *  - team_message    : réponse de l'équipe (messages.from_team) ;
 *  - announcement    : message de l'équipe diffusé à tous (notification_recipients).
 *
 * « Lu / non lu » est gardé par le navigateur (date de dernière visite) :
 * aucune colonne ni migration. Fenêtre de 60 jours, 50 éléments au plus.
 */
const WINDOW_DAYS = 60;
const MAX_ITEMS = 50;

const ACTIVITY_SQL = `
  SELECT * FROM (
    SELECT 'offer_published' AS type, o.id::text AS ref, o.moderated_at AS at, o.title, NULL::text AS detail, NULL::text AS url
    FROM member_offers o
    WHERE o.user_id = $1 AND o.kind = 'campaign' AND o.status = 'published' AND o.moderated_at IS NOT NULL
    UNION ALL
    SELECT 'offer_rejected', o.id::text, o.moderated_at, o.title, o.moderation_note, NULL
    FROM member_offers o
    WHERE o.user_id = $1 AND o.status = 'rejected' AND o.moderated_at IS NOT NULL
    UNION ALL
    SELECT 'offer_removed', o.id::text, o.moderated_at, o.title, o.moderation_note, NULL
    FROM member_offers o
    WHERE o.user_id = $1 AND o.status = 'removed' AND o.moderated_at IS NOT NULL
      AND o.moderated_by IS NOT NULL AND o.moderated_by <> o.user_id
      -- Retrait par l'équipe : moderated_at et updated_at posés ensemble. Un
      -- retrait par l'auteur ne touche que updated_at (moderated_at = validation).
      AND o.moderated_at = o.updated_at
    UNION ALL
    SELECT 'story_extended', o.id::text || ':' || a.id::text, a.created_at, o.title, NULL, NULL
    FROM admin_actions a JOIN member_offers o ON o.id = a.target_id
    WHERE a.action = 'member_offer.extend' AND a.target_type = 'member_offer' AND o.user_id = $1
    UNION ALL
    SELECT 'story_expired', o.id::text, o.expires_at, o.title, NULL, NULL
    FROM member_offers o
    WHERE o.user_id = $1 AND o.kind = 'campaign' AND o.status = 'published' AND o.expires_at <= NOW()
    UNION ALL
    SELECT 'team_message', m.id::text, m.created_at, NULL, left(m.content, 120), NULL
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.member_id = $1 AND m.from_team
    UNION ALL
    SELECT 'announcement', b.public_id::text, b.created_at, b.title, b.message, b.target_url
    FROM notification_recipients r JOIN notification_broadcasts b ON b.id = r.broadcast_id
    WHERE r.user_id = $1
  ) events
  WHERE at IS NOT NULL AND at > NOW() - make_interval(days => ${WINDOW_DAYS})
  ORDER BY at DESC, ref DESC
  LIMIT ${MAX_ITEMS}`;

// Liens des annonces : même liste blanche que les notifications (liens internes).
const ALLOWED_URL = /^\/(?:app|mes-affilies|go\/\d{1,10})?(?:#[A-Za-z0-9_-]{1,40})?$/;

async function listActivity(req, res, next) {
  try {
    const { rows } = await pool.query(ACTIVITY_SQL, [req.user.id]);
    const items = rows.map((row) => {
      const offerId = row.type.startsWith('offer_') || row.type.startsWith('story_')
        ? Number.parseInt(row.ref, 10) : null;
      return {
        id: `${row.type}:${row.ref}`,
        type: row.type,
        at: row.at,
        title: row.title,
        detail: row.detail,
        offer_id: offerId,
        url: row.url && ALLOWED_URL.test(row.url) ? row.url : null,
      };
    });
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    return next(error);
  }
}

module.exports = { listActivity, WINDOW_DAYS, MAX_ITEMS };
