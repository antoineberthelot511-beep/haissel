const { logger } = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorMiddleware(err, req, res, next) {
  // Erreurs client produites par Express/body-parser (JSON invalide, corps trop gros…)
  const clientStatus = Number(err.status || err.statusCode);
  if (err.expose && clientStatus >= 400 && clientStatus < 500) {
    const message = err.type === 'entity.too.large'
      ? 'Requête trop volumineuse.'
      : 'Requête invalide.';
    return res.status(clientStatus).json({
      success: false,
      error: { code: 'INVALID_REQUEST', message },
    });
  }

  // Le détail technique reste dans les logs serveur, jamais dans la réponse.
  logger.error('Request failed', {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    error: err.message,
    code: err.code,
  });
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test' && err.stack) {
    console.error(err.stack);
  }

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Une erreur est survenue.',
    },
  });
}

module.exports = {
  errorMiddleware,
};
