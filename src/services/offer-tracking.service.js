const crypto = require('crypto');
const { pool, withTransaction } = require('../config/database');
const { deriveKey } = require('../config/security');

/*
 * Suivi des liens de l'équipe (offres « affiliate ») et conversions MyLead.
 *
 *  - identifiant de suivi opaque : HMAC-SHA256 (clé dérivée « offer-subid »)
 *    du couple membre + offre, 32 caractères hexadécimaux. Ni l'identifiant
 *    ni l'e-mail du membre n'apparaissent dans l'URL ou en base ;
 *  - il est ajouté à l'URL dans le paramètre choisi par l'admin (subid_param) ;
 *  - un clic suivi au plus par membre, par offre et par 24 h ; les comptes
 *    ADMIN ne génèrent aucun clic suivi (voir openOffer) ;
 *  - conversion : reliée au clic par le sous-identifiant ; statuts en attente,
 *    validée, refusée ; « à vérifier » si plusieurs conversions de la même
 *    offre viennent du même membre (même identifiant) ou de la même IP hachée.
 *    Rien n'est versé aux membres.
 */
const CLICK_WINDOW_HOURS = 24;
const SUBID_PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const STATUSES = { pending: 'pending', approved: 'approved', validated: 'approved', rejected: 'rejected', refused: 'rejected', cancelled: 'rejected' };

class TrackingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Identifiant de suivi opaque du couple membre + offre. */
function trackingId(userId, offerId) {
  return crypto.createHmac('sha256', deriveKey('offer-subid')).update(`${Number(userId)}:${Number(offerId)}`).digest('hex').slice(0, 32);
}

/** URL de destination avec le sous-identifiant (paramètre choisi par l'admin). */
function withSubid(url, param, subid) {
  if (!param || !SUBID_PARAM_PATTERN.test(param)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(param, subid);
    return parsed.toString();
  } catch (error) {
    return url;
  }
}

/** Enregistre un clic suivi, sauf s'il y en a déjà un pour ce membre et cette offre depuis 24 h. */
async function recordClick({ offerId, subid, ipHash }) {
  const { rows } = await pool.query(
    `INSERT INTO offer_clicks (offer_id, subid, ip_hash)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM offer_clicks WHERE offer_id = $1 AND subid = $2 AND created_at > NOW() - make_interval(hours => $4)
     )
     RETURNING id`,
    [offerId, subid, ipHash, CLICK_WINDOW_HOURS]
  );
  return { recorded: rows.length > 0, clickId: rows[0]?.id || null };
}

function readConversion(payload) {
  const reference = typeof payload.external_reference === 'string' ? payload.external_reference.trim() : '';
  if (!reference || reference.length > 255) throw new TrackingError('INVALID_REFERENCE', 'external_reference requis (255 caractères au plus).');
  const subid = typeof payload.subid === 'string' ? payload.subid.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{32}$/.test(subid)) throw new TrackingError('INVALID_SUBID', 'Sous-identifiant invalide.');
  const status = STATUSES[String(payload.status || 'pending').toLowerCase()];
  if (!status) throw new TrackingError('INVALID_STATUS', 'Statut inconnu.');
  const amount = payload.amount_cents === undefined ? 0 : payload.amount_cents;
  if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000) throw new TrackingError('INVALID_AMOUNT', 'Montant invalide.');
  const currency = payload.currency === undefined ? 'EUR' : String(payload.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TrackingError('INVALID_CURRENCY', 'Devise invalide.');
  return { reference, subid, status, amount, currency };
}

/*
 * Conversion reçue du réseau (webhook « mylead »). Idempotente par
 * (fournisseur, référence) : un second envoi met seulement le statut à jour.
 */
async function recordOfferConversion(payload, provider) {
  const value = readConversion(payload || {});
  return withTransaction(async (client) => {
    const click = (await client.query(
      'SELECT id, offer_id, ip_hash FROM offer_clicks WHERE subid = $1 ORDER BY created_at DESC LIMIT 1',
      [value.subid]
    )).rows[0];
    if (!click) throw new TrackingError('UNKNOWN_SUBID', 'Aucun clic ne correspond à ce sous-identifiant.', 422);

    const existing = (await client.query(
      'SELECT * FROM offer_conversions WHERE provider = $1 AND external_reference = $2 FOR UPDATE',
      [provider, value.reference]
    )).rows[0];
    let conversion;
    let created = false;
    if (existing) {
      conversion = (await client.query(
        `UPDATE offer_conversions SET status = $2, amount_cents = $3, currency = $4, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [existing.id, value.status, value.amount, value.currency]
      )).rows[0];
    } else {
      created = true;
      conversion = (await client.query(
        `INSERT INTO offer_conversions (provider, external_reference, offer_id, click_id, subid, ip_hash, status, amount_cents, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [provider, value.reference, click.offer_id, click.id, value.subid, click.ip_hash, value.status, value.amount, value.currency]
      )).rows[0];
    }

    // Anti-fraude : plusieurs conversions de la même offre, même membre ou même IP hachée → à vérifier.
    const flagged = await client.query(
      `UPDATE offer_conversions c SET needs_review = true
       WHERE c.offer_id = $1 AND (c.subid = $2 OR ($3::text IS NOT NULL AND c.ip_hash = $3))
         AND (SELECT COUNT(*) FROM offer_conversions d
              WHERE d.offer_id = $1 AND (d.subid = $2 OR ($3::text IS NOT NULL AND d.ip_hash = $3))) > 1
       RETURNING c.id`,
      [click.offer_id, value.subid, click.ip_hash]
    );
    if (flagged.rows.some((row) => row.id === conversion.id)) conversion.needs_review = true;
    return { conversion, created };
  });
}

/*
 * Tableau « Revenus » : par offre et par mois, clics, conversions par statut,
 * taux de conversion (conversions / clics) et gains estimés (en attente +
 * validées, en centimes). Mois au format AAAA-MM ; sans mois : tous.
 */
async function revenueReport({ month = null } = {}) {
  const { rows } = await pool.query(
    `WITH months AS (
       SELECT offer_id, to_char(created_at, 'YYYY-MM') AS month FROM offer_clicks
       UNION SELECT offer_id, to_char(created_at, 'YYYY-MM') FROM offer_conversions WHERE offer_id IS NOT NULL
     )
     SELECT m.offer_id, o.title, m.month,
            (SELECT COUNT(*) FROM offer_clicks k WHERE k.offer_id = m.offer_id AND to_char(k.created_at, 'YYYY-MM') = m.month)::int AS clicks,
            COUNT(c.id) FILTER (WHERE c.status = 'pending')::int AS pending,
            COUNT(c.id) FILTER (WHERE c.status = 'approved')::int AS approved,
            COUNT(c.id) FILTER (WHERE c.status = 'rejected')::int AS rejected,
            COUNT(c.id) FILTER (WHERE c.needs_review)::int AS to_review,
            COALESCE(SUM(c.amount_cents) FILTER (WHERE c.status IN ('pending', 'approved')), 0)::int AS estimated_cents
     FROM months m
     JOIN member_offers o ON o.id = m.offer_id
     LEFT JOIN offer_conversions c ON c.offer_id = m.offer_id AND to_char(c.created_at, 'YYYY-MM') = m.month
     WHERE ($1::text IS NULL OR m.month = $1)
     GROUP BY m.offer_id, o.title, m.month
     ORDER BY m.month DESC, o.title`,
    [month]
  );
  return rows.map((row) => {
    const conversions = row.pending + row.approved + row.rejected;
    return { ...row, conversions, conversion_rate: row.clicks ? Math.round((conversions / row.clicks) * 1000) / 10 : 0 };
  });
}

/*
 * Offres essayées par un membre (liens de l'équipe qu'il a ouverts), pour son
 * profil (privé). Aucun lien stocké entre le membre et le clic : on recalcule
 * ses identifiants opaques pour chaque offre de l'équipe.
 */
async function triedOffers(userId) {
  const offers = (await pool.query("SELECT id FROM member_offers WHERE kind = 'affiliate'")).rows;
  if (!offers.length) return [];
  const bySubid = new Map(offers.map((offer) => [trackingId(userId, offer.id), offer.id]));
  const { rows } = await pool.query(
    'SELECT subid, MAX(created_at) AS last_at FROM offer_clicks WHERE subid = ANY($1::text[]) GROUP BY subid ORDER BY MAX(created_at) DESC',
    [[...bySubid.keys()]]
  );
  return rows.map((row) => ({ offer_id: bySubid.get(row.subid.trim()), last_at: row.last_at }));
}

module.exports = {
  CLICK_WINDOW_HOURS, SUBID_PARAM_PATTERN, TrackingError,
  trackingId, withSubid, recordClick, recordOfferConversion, revenueReport, triedOffers,
};
