const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getClientIp } = require('../utils/network');
const { isVercel } = require('../config/security');
const { PostgresRateLimitStore } = require('./rate-limit.store');

// La clé repose sur l'IP réelle du client (socket, ou X-Real-IP uniquement
// si la requête est authentifiée comme venant du proxy Nginx).
const keyGenerator = (req) => ipKeyGenerator(getClientIp(req) || 'unknown');

// Après authentification : clé = compte (un administrateur ne contourne pas
// la limite en changeant d'adresse).
const userKeyGenerator = (req) => (req.user ? `user:${req.user.id}` : keyGenerator(req));

/*
 * Stockage des compteurs :
 *  - par défaut (npm start, Docker) : mémoire du processus, comme avant ;
 *  - sur Vercel : table rate_limit_counters, car plusieurs instances répondent
 *    en parallèle sans mémoire partagée — chacune ne compterait qu'une partie
 *    des requêtes et la limite réelle serait « limit × nombre d'instances ».
 *
 * « name » isole les compteurs d'un limiteur à l'autre : sans préfixe distinct,
 * les dix limiteurs partageraient une même ligne par adresse IP.
 */
function storeFor(name) {
  return isVercel() ? new PostgresRateLimitStore(name) : undefined;
}

function limiter({ name, windowMs, limit, message, skipSuccessfulRequests = false, byUser = false }) {
  return rateLimit({
    windowMs,
    limit,
    store: storeFor(name),
    keyGenerator: byUser ? userKeyGenerator : keyGenerator,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== 'true',
    message: {
      success: false,
      error: { code: 'TOO_MANY_REQUESTS', message },
    },
  });
}

/*
 * RÉSEAUX PARTAGÉS.
 *
 * Le public de HAISSEL est lycéen : le Wi-Fi d'un établissement, un partage de
 * connexion ou un réseau mobile font sortir des dizaines d'élèves par la même
 * adresse IP. Une limite basse par IP bloquait donc une classe entière pour
 * l'usage normal de quelques-uns.
 *
 * D'où le partage des rôles :
 *   - la limite par IP reste large. Elle n'empêche qu'un abus grossier
 *     (inondation depuis une seule connexion), pas le forçage d'un compte ;
 *   - sur la connexion, elle ne compte QUE les échecs
 *     (skipSuccessfulRequests) : trente élèves qui se connectent
 *     correctement d'affilée ne consomment rien ;
 *   - la vraie protection contre le forçage d'un compte précis est le
 *     ralentissement progressif par identifiant (utils/login-throttle.js),
 *     qui suit le COMPTE visé et non l'adresse : changer d'IP n'y échappe pas.
 */
const authRateLimiter = limiter({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  message: 'Trop de tentatives depuis cette connexion. Réessayez dans quelques minutes.',
});

const registerRateLimiter = limiter({
  name: 'register',
  windowMs: 60 * 60 * 1000,
  limit: 30,
  message: "Trop d'inscriptions depuis cette connexion. Réessayez plus tard.",
});

// Vérification d'e-mail, renvoi, mot de passe oublié, réinitialisation.
const accountRecoveryRateLimiter = limiter({
  name: 'recovery',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Trop de demandes. Réessayez dans quelques minutes.',
});

const mfaRateLimiter = limiter({
  name: 'mfa',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Trop de codes incorrects. Réessayez dans quelques minutes.',
});

const generalRateLimiter = limiter({
  name: 'general',
  windowMs: 60 * 1000,
  limit: 300,
  message: 'Trop de requêtes. Veuillez ralentir.',
});

const redirectRateLimiter = limiter({
  name: 'redirect',
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Trop de clics. Veuillez réessayer plus tard.',
});

const webhookRateLimiter = limiter({
  name: 'webhook',
  windowMs: 60 * 1000,
  limit: 120,
  message: 'Trop de requêtes webhook.',
});

// Diffusion de notifications : 5 par minute et 30 par heure par administrateur.
const broadcastBurstLimiter = limiter({
  name: 'broadcast-burst',
  windowMs: 60 * 1000,
  limit: 5,
  byUser: true,
  message: 'Trop de diffusions. Attendez une minute avant de renvoyer une notification.',
});

const broadcastHourlyLimiter = limiter({
  name: 'broadcast-hourly',
  windowMs: 60 * 60 * 1000,
  limit: 30,
  byUser: true,
  message: 'Limite horaire de diffusions atteinte. Réessayez plus tard.',
});

// Ouverture du flux temps réel : empêche les boucles de reconnexion agressives.
const streamRateLimiter = limiter({
  name: 'stream',
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Trop de reconnexions. Réessayez dans une minute.',
});

// Abonnement / désabonnement Web Push et notification de test : par compte.
const pushRateLimiter = limiter({
  name: 'push',
  windowMs: 15 * 60 * 1000,
  limit: 30,
  byUser: true,
  message: 'Trop de demandes de notifications. Réessaie dans quelques minutes.',
});

module.exports = {
  pushRateLimiter,
  broadcastBurstLimiter,
  broadcastHourlyLimiter,
  streamRateLimiter,
  authRateLimiter,
  registerRateLimiter,
  accountRecoveryRateLimiter,
  mfaRateLimiter,
  generalRateLimiter,
  redirectRateLimiter,
  webhookRateLimiter,
};
