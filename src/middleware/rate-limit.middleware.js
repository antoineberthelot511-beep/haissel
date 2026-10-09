const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getClientIp } = require('../utils/network');

// La clé repose sur l'IP réelle du client (socket, ou X-Real-IP uniquement
// si la requête est authentifiée comme venant du proxy Nginx).
const keyGenerator = (req) => ipKeyGenerator(getClientIp(req) || 'unknown');

function limiter({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
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

module.exports = {
  authRateLimiter,
  generalRateLimiter,
  redirectRateLimiter,
  webhookRateLimiter,
};
