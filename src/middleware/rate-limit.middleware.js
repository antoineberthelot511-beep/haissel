const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getClientIp } = require('../utils/network');

// La clé repose sur l'IP réelle du client (socket, ou X-Real-IP uniquement
// si la requête est authentifiée comme venant du proxy Nginx).
const keyGenerator = (req) => ipKeyGenerator(getClientIp(req) || 'unknown');

// Après authentification : clé = compte (un administrateur ne contourne pas
// la limite en changeant d'adresse).
const userKeyGenerator = (req) => (req.user ? `user:${req.user.id}` : keyGenerator(req));

function limiter({ windowMs, limit, message, skipSuccessfulRequests = false, byUser = false }) {
  return rateLimit({
    windowMs,
    limit,
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

// Connexion / inscription : seules les tentatives échouées sont comptées.
const authRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Trop de tentatives. Réessayez dans quelques minutes.',
});

const registerRateLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: "Trop d'inscriptions depuis cette adresse. Réessayez plus tard.",
});

// Vérification d'e-mail, renvoi, mot de passe oublié, réinitialisation.
const accountRecoveryRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Trop de demandes. Réessayez dans quelques minutes.',
});

const mfaRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Trop de codes incorrects. Réessayez dans quelques minutes.',
});

const generalRateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 300,
  message: 'Trop de requêtes. Veuillez ralentir.',
});

const redirectRateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Trop de clics. Veuillez réessayer plus tard.',
});

const webhookRateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 120,
  message: 'Trop de requêtes webhook.',
});

// Diffusion de notifications : 5 par minute et 30 par heure par administrateur.
const broadcastBurstLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 5,
  byUser: true,
  message: 'Trop de diffusions. Attendez une minute avant de renvoyer une notification.',
});

const broadcastHourlyLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  byUser: true,
  message: 'Limite horaire de diffusions atteinte. Réessayez plus tard.',
});

// Ouverture du flux temps réel : empêche les boucles de reconnexion agressives.
const streamRateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Trop de reconnexions. Réessayez dans une minute.',
});

module.exports = {
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
