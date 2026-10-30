const { sendError } = require('../utils/http');
const { revenueReport } = require('../services/offer-tracking.service');

/*
 * GET /api/admin/revenue[?month=AAAA-MM][&format=csv]
 *
 * Tableau « Revenus » (console admin uniquement) : par offre de l'équipe et
 * par mois, clics suivis, conversions (en attente / validées / refusées /
 * à vérifier), taux de conversion et gains estimés de HAISSEL. Rien de ceci
 * n'est jamais envoyé à un membre.
 */
const CSV_COLUMNS = [
  ['month', 'Mois'], ['offer_id', 'Offre (id)'], ['title', 'Offre'], ['clicks', 'Clics'],
  ['pending', 'En attente'], ['approved', 'Validées'], ['rejected', 'Refusées'], ['to_review', 'À vérifier'],
  ['conversion_rate', 'Taux de conversion (%)'], ['estimated_eur', 'Gains estimés (EUR)'],
];

/** Cellule CSV : guillemets doublés, et neutralisation des formules (=, +, -, @). */
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const lines = [CSV_COLUMNS.map(([, label]) => csvCell(label)).join(';')];
  for (const row of rows) {
    const values = { ...row, estimated_eur: (row.estimated_cents / 100).toFixed(2) };
    lines.push(CSV_COLUMNS.map(([key]) => csvCell(values[key])).join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

async function getRevenue(req, res, next) {
  try {
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : null;
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendError(res, 400, 'INVALID_MONTH', 'Mois attendu au format AAAA-MM.');
    const rows = await revenueReport({ month });
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="haissel-revenus${month ? `-${month}` : ''}.csv"`);
      return res.status(200).send(toCsv(rows));
    }
    const totals = rows.reduce((sum, row) => ({
      clicks: sum.clicks + row.clicks, conversions: sum.conversions + row.conversions,
      approved: sum.approved + row.approved, estimated_cents: sum.estimated_cents + row.estimated_cents,
    }), { clicks: 0, conversions: 0, approved: 0, estimated_cents: 0 });
    return res.status(200).json({ success: true, data: { items: rows, totals } });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getRevenue, toCsv, csvCell };
