const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const { pool, testConnection } = require('./config/database');
const { findMissingTables } = require('./db/migrator');
const { logger } = require('./utils/logger');
const { isLocalRequest } = require('./utils/network');

const authRouter = require('./routes/auth.routes');
const affiliateRouter = require('./routes/affiliate.routes');
const adminRouter = require('./routes/admin.routes');
const webhookRouter = require('./routes/webhook.routes');

const { generalRateLimiter, redirectRateLimiter } = require('./middleware/rate-limit.middleware');
const { errorMiddleware } = require('./middleware/error.middleware');
const { requireLocalAdmin } = require('./middleware/auth.middleware');
const { getAffiliateRedirect } = require('./controllers/affiliate.controller');

const app = express();
const port = Number(process.env.PORT || 3000);

const frontendPath = path.join(__dirname, '../frontend');
const userPagePath = path.join(frontendPath, 'index.html');
const adminPagePath = path.join(frontendPath, 'admin.html');

/*
 * ============================================================
 * SÉCURITÉ
 * ============================================================
 */

app.disable('x-powered-by');

/*
 * Le serveur est joint directement (npm start) : les en-têtes X-Forwarded-*
 * ne sont jamais pris en compte. Derrière Nginx (Docker), l'IP réelle est
 * transmise via un en-tête authentifié par PROXY_SHARED_SECRET
 * (voir src/utils/network.js).
 */
app.set('trust proxy', false);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // Le site est servi en HTTP sur le réseau local : forcer HTTPS
      // empêcherait le chargement du CSS et du JS.
      upgradeInsecureRequests: null,
    },
  },
  // HSTS n'a de sens qu'en HTTPS.
  strictTransportSecurity: false,
}));

/*
 * Le frontend est servi par ce même serveur (same-origin) : aucun en-tête
 * CORS n'est nécessaire. CORS_ORIGINS (liste séparée par des virgules)
 * permet d'autoriser explicitement d'autres origines si besoin.
 */
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => /^https?:\/\/[^\s/]+$/.test(origin));

if (corsOrigins.length > 0) {
  app.use(cors({ origin: corsOrigins, credentials: false }));
}

/*
 * Webhooks : montés AVANT express.json, car la signature HMAC porte sur le
 * corps brut.
 */
app.use('/api/webhooks', webhookRouter);

app.use(express.json({ limit: '16kb' }));
app.use(generalRateLimiter);

// Pas de cache : évite qu'un navigateur conserve une ancienne interface.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/*
 * ============================================================
 * PAGES
 * ============================================================
 *
 * localhost / 127.0.0.1  -> administration
 * IP du réseau local     -> espace utilisateur
 */

// Les fichiers de l'interface admin ne sont jamais servis au réseau local.
// Le chemin est décodé et comparé sans casse (le système de fichiers Windows
// ne distingue pas /ADMIN.HTML de /admin.html).
function isAdminPath(rawPath) {
  try {
    return /admin/i.test(decodeURIComponent(rawPath));
  } catch (error) {
    return true;
  }
}

app.use((req, res, next) => {
  if (isAdminPath(req.path) && !isLocalRequest(req)) {
    return requireLocalAdmin(req, res, next);
  }
  return next();
});

app.get('/', (req, res) => {
  res.sendFile(isLocalRequest(req) ? adminPagePath : userPagePath);
});

app.get(['/admin', '/admin.html'], requireLocalAdmin, (req, res) => {
  res.sendFile(adminPagePath);
});

// Espace utilisateur accessible aussi depuis le serveur (tests, démonstration).
app.get(['/app', '/mes-affilies'], (req, res) => {
  res.sendFile(userPagePath);
});

app.use(express.static(frontendPath, {
  index: false,
  etag: false,
  lastModified: false,
}));

/*
 * ============================================================
 * LIEN AFFILIÉ
 * ============================================================
 */

app.get('/r/:code', redirectRateLimiter, getAffiliateRedirect);

/*
 * ============================================================
 * API
 * ============================================================
 */

app.get('/api/health', async (req, res) => {
  try {
    await testConnection();
    const missingTables = await findMissingTables(pool);

    res.status(missingTables.length ? 503 : 200).json({
      success: missingTables.length === 0,
      status: missingTables.length ? 'degraded' : 'ok',
      database: 'connected',
      schema: missingTables.length ? 'migrations_required' : 'ok',
    });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({
      success: false,
      status: 'degraded',
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Base de données indisponible.',
      },
    });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/affiliate', affiliateRouter);
app.use('/api/admin', adminRouter);

/*
 * Anciennes API du réseau social (publications, commentaires, messages…).
 * Non utilisées par l'interface actuelle : désactivées par défaut pour
 * réduire la surface d'attaque. Les tables restent intactes en base.
 */
if (process.env.ENABLE_LEGACY_SOCIAL_API === 'true') {
  app.use('/api/users', require('./routes/users.routes'));
  app.use('/api/posts', require('./routes/posts.routes'));
  app.use('/api', require('./routes/comments.routes'));
  app.use('/api/notifications', require('./routes/notifications.routes'));
  app.use('/api/conversations', require('./routes/messages.routes'));
  app.use('/api/reports', require('./routes/reports.routes'));
}

/*
 * ============================================================
 * 404 / ERREURS
 * ============================================================
 */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Ressource introuvable.',
    },
  });
});

app.use(errorMiddleware);

/*
 * ============================================================
 * DÉMARRAGE
 * ============================================================
 */

function checkSecrets() {
  const jwtSecret = process.env.JWT_SECRET || '';
  const isPlaceholder = /change_me|replace_with|local-development|remplacer/i.test(jwtSecret);

  if (Buffer.byteLength(jwtSecret, 'utf8') < 32 || (process.env.NODE_ENV === 'production' && isPlaceholder)) {
    logger.error('JWT_SECRET must be a unique secret of at least 32 bytes; example values are not allowed in production.');
    process.exit(1);
  }
}

const startServer = async () => {
  checkSecrets();

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info(`Server listening on http://0.0.0.0:${port} (admin: http://localhost:${port})`);
  });

  try {
    await testConnection();
    logger.info('PostgreSQL connection successful.');
    const missingTables = await findMissingTables(pool);
    if (missingTables.length > 0) {
      logger.error(`Database schema incomplete (missing: ${missingTables.join(', ')}). Run: npm run migrate`);
    }
  } catch (error) {
    logger.error('PostgreSQL connection unavailable. The server is running in degraded mode.', { error: error.message });
  }

  const shutdown = () => {
    server.close(async () => {
      try {
        await pool.end();
        process.exit(0);
      } catch (error) {
        logger.error('Error while closing PostgreSQL connections', { error: error.message });
        process.exit(1);
      }
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  pool,
};
