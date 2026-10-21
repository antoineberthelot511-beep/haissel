const crypto = require('crypto');
const express = require('express');
const { purgeExpiredData } = require('../services/retention.service');
const { sendError } = require('../utils/http');
const { logger } = require('../utils/logger');

/*
 * Tâches planifiées déclenchées de l'extérieur.
 *
 * En local et sous Docker, la purge de rétention tourne dans le processus
 * (setInterval, voir startRetentionJob). Sur Vercel il n'y a pas de processus
 * permanent : rien ne tourne entre deux requêtes, donc la purge doit être
 * appelée par le planificateur de Vercel (« crons » dans vercel.json).
 *
 * Authentification : en-tête `Authorization: Bearer ${CRON_SECRET}`. Vercel
 * ajoute lui-même cet en-tête à ses appels de cron dès que la variable
 * CRON_SECRET existe dans le projet.
 *
 * Cette route n'est PAS protégée par une session : c'est un secret partagé,
 * comparé à temps constant. Sans CRON_SECRET configuré, elle répond 404 et
 * ne révèle donc pas son existence.
 */

const router = express.Router();

/** Comparaison à temps constant : la longueur ne fuit pas par la durée. */
function secretMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireCronSecret(req, res, next) {
  const expected = String(process.env.CRON_SECRET || '');
  // Non configuré : la route n'existe pas.
  if (!expected) return sendError(res, 404, 'NOT_FOUND', 'Ressource introuvable.');

  const header = String(req.get('authorization') || '');
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix) || !secretMatches(header.slice(prefix.length), expected)) {
    logger.warn('Internal cron call rejected', { path: req.originalUrl });
    return sendError(res, 401, 'UNAUTHORIZED', 'Authentification requise.');
  }
  return next();
}

/*
 * GET et POST tous les deux : les crons de Vercel n'émettent que des requêtes
 * GET, mais un appel manuel (curl, supervision) est plus naturel en POST.
 */
async function runRetention(req, res, next) {
  try {
    await purgeExpiredData();
    logger.info('Retention purge executed via internal route');
    return res.status(200).json({ success: true, data: { purged: true } });
  } catch (error) {
    return next(error);
  }
}

router.get('/retention', requireCronSecret, runRetention);
router.post('/retention', requireCronSecret, runRetention);

module.exports = router;
