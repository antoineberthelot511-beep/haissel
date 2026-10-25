const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const { pool, testConnection } = require('./config/database');
const { findMissingTables } = require('./db/migrator');
const { logger } = require('./utils/logger');
const { validateSecurityConfig } = require('./config/security');
const { csrfOriginCheck } = require('./middleware/csrf.middleware');
const { isLocalRequest, isAdminAccessAllowed } = require('./utils/network');

const authRouter = require('./routes/auth.routes');
const affiliateRouter = require('./routes/affiliate.routes');
const adminRouter = require('./routes/admin.routes');
const learnRouter = require('./routes/learn.routes');
const communityRouter = require('./routes/community.routes');
const messagesRouter = require('./routes/messages.routes');
const webhookRouter = require('./routes/webhook.routes');
const realtimeRouter = require('./routes/realtime.routes');
const internalRouter = require('./routes/internal.routes');
const realtime = require('./services/realtime.service');
const { startRetentionJob } = require('./services/retention.service');

const { generalRateLimiter, redirectRateLimiter } = require('./middleware/rate-limit.middleware');
const { errorMiddleware } = require('./middleware/error.middleware');
const { requireLocalAdmin, authenticateToken } = require('./middleware/auth.middleware');
const { getAffiliateRedirect } = require('./controllers/affiliate.controller');
const { listLinks, goToLink } = require('./controllers/links.controller');

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

/*
 * Vercel : la fonction est appelée par le proxy de Vercel, qui termine le
 * HTTPS et réécrit X-Forwarded-For / X-Forwarded-Proto (un client ne peut
 * pas les imposer). On s'y fie uniquement dans ce mode : protocole correct
 * pour le contrôle CSRF et le cookie Secure, IP réelle pour les limites.
 */
const onVercel = process.env.VERCEL === '1';
if (onVercel) {
  app.set('trust proxy', true);

  // Pas de process.exit possible : une configuration dangereuse bloque
  // toutes les requêtes (sans jamais révéler de valeur secrète).
  const { errors, warnings } = validateSecurityConfig();
  for (const warning of warnings) logger.warn(warning);
  for (const error of errors) logger.error(`Configuration invalide : ${error}`);
  if (errors.length) {
    app.use((req, res) => res.status(503).json({
      success: false,
      error: { code: 'SERVER_MISCONFIGURED', message: 'Serveur mal configuré : consultez les journaux Vercel.' },
    }));
  }
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // Cloudflare Turnstile : script + iframe du widget anti-robot.
      scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
      frameSrc: ['https://challenges.cloudflare.com'],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
      // Pas d'upgrade-insecure-requests : sur le réseau local en HTTP, il
      // empêcherait le chargement du CSS et du JS.
    },
  },
  // HSTS seulement si le site est réellement servi en HTTPS (voir README).
  strictTransportSecurity: process.env.COOKIE_SECURE === 'true'
    ? { maxAge: 15552000, includeSubDomains: false }
    : false,
  referrerPolicy: { policy: 'no-referrer' },
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

/*
 * Tâches planifiées : montées AVANT csrfOriginCheck et la limite générale.
 * Un planificateur (cron Vercel) n'est pas un navigateur — il n'envoie ni
 * Origin ni jeton CSRF — et ne doit pas être refusé pour cette raison.
 * L'authentification se fait par le secret partagé CRON_SECRET.
 */
app.use('/api/internal', internalRouter);

// Défense CSRF : origine / Fetch Metadata pour toute requête qui modifie l'état.
app.use(csrfOriginCheck);

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
  if (isAdminPath(req.path) && !isAdminAccessAllowed(req)) {
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

// Polices auto-hébergées (aucune requête vers Google Fonts, voir frontend/fonts.css).
const FONT_PACKAGES = {
  anton: '@fontsource/anton',
  archivo: '@fontsource/archivo',
  fraunces: '@fontsource-variable/fraunces',
  'ibm-plex-mono': '@fontsource/ibm-plex-mono',
  'ibm-plex-sans': '@fontsource/ibm-plex-sans',
  orbitron: '@fontsource/orbitron',
  'plus-jakarta-sans': '@fontsource-variable/plus-jakarta-sans',
  'space-grotesk': '@fontsource/space-grotesk',
};
for (const [name, pkg] of Object.entries(FONT_PACKAGES)) {
  app.use(`/vendor/fonts/${name}`, express.static(path.dirname(require.resolve(`${pkg}/package.json`)), { index: false, maxAge: '30d' }));
}

app.use(express.static(frontendPath, {
  index: false,
  etag: false,
  lastModified: false,
}));

/*
 * Limite générale : posée APRÈS les fichiers statiques, volontairement.
 *
 * Sur Vercel, les compteurs vivent en base (table rate_limit_counters). Placée
 * avant express.static, cette limite déclenchait une écriture PostgreSQL pour
 * CHAQUE fichier servi — feuilles de style, scripts, polices, images. Une
 * seule ouverture de page en produisait une vingtaine, sans rien protéger :
 * ces fichiers sont publics, identiques pour tous, et mis en cache par le
 * réseau de diffusion de Vercel.
 *
 * Les fichiers statiques répondent donc avant d'être comptés. Tout ce qui
 * suit — redirections et API — reste couvert.
 */
app.use(generalRateLimiter);

/*
 * ============================================================
 * LIEN AFFILIÉ
 * ============================================================
 */

// Redirection canonique des codes personnels. JAMAIS gelée : les liens déjà
// partagés doivent continuer de fonctionner (voir ENABLE_INTERNAL_AFFILIATION).
app.get('/r/:code', redirectRateLimiter, getAffiliateRedirect);
app.get('/go/:id', redirectRateLimiter, goToLink);

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
app.get('/api/links', authenticateToken, listLinks);
app.use('/api/affiliate', affiliateRouter);
app.use('/api/learn', learnRouter);
app.use('/api/community', communityRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/admin', adminRouter);
// Flux temps réel (SSE) et accusés d'affichage des notifications admin.
app.use('/api/notifications', realtimeRouter);

/*
 * Fonctionnalité gelée : ENABLE_INTERNAL_AFFILIATION (moteur d'affiliation
 * interne — codes HAI-XXXXXXXX, conversions, gains, webhook signé). Le code
 * reste en place et les tables intactes ; seules les routes cessent de
 * répondre. Le gel n'est pas appliqué ici mais route par route
 * (requireInternalAffiliation), pour deux raisons : les redirections
 * /r/:code et /api/affiliate/HAI-… doivent rester actives quoi qu'il arrive,
 * et une route gelée doit répondre FEATURE_DISABLED plutôt que le NOT_FOUND
 * générique.
 *
 * Les anciennes API du réseau social (publications, commentaires, messages,
 * profils, signalements) et leur drapeau ENABLE_LEGACY_SOCIAL_API ont été
 * supprimés : plus aucun code ne les montait et l'interface ne les appelait
 * pas. Leurs tables restent en base (voir README).
 */

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
  // Échec sûr : le serveur refuse de démarrer avec une configuration
  // dangereuse. Les valeurs secrètes ne sont jamais affichées.
  const { errors, warnings } = validateSecurityConfig();
  for (const warning of warnings) logger.warn(warning);
  if (errors.length) {
    for (const error of errors) logger.error(`Configuration invalide : ${error}`);
    process.exit(1);
  }
}

const startServer = async () => {
  checkSecrets();

  /*
   * HTTPS natif facultatif (npm start sans Nginx) : HTTPS_CERT_FILE et
   * HTTPS_KEY_FILE désignent des fichiers HORS du dépôt (voir README,
   * « HTTPS sur le réseau local »). Sans eux : HTTP, adapté à localhost.
   */
  const certFile = process.env.HTTPS_CERT_FILE;
  const keyFile = process.env.HTTPS_KEY_FILE;
  const useHttps = Boolean(certFile && keyFile);
  const scheme = useHttps ? 'https' : 'http';
  const onListening = () => {
    logger.info(`Server listening on ${scheme}://0.0.0.0:${port} (admin: ${scheme}://localhost:${port})`);
    if (!useHttps) {
      logger.warn('HTTP mode: system notifications only work on http://localhost. Other LAN devices need HTTPS (see README).');
    }
  };

  let server;
  if (useHttps) {
    try {
      server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app)
        .listen(port, '0.0.0.0', onListening);
    } catch (error) {
      logger.error('Unable to read HTTPS certificate or key', { error: error.message });
      process.exit(1);
    }
  } else {
    server = app.listen(port, '0.0.0.0', onListening);
  }

  try {
    await testConnection();
    logger.info('PostgreSQL connection successful.');
    startRetentionJob();
    const missingTables = await findMissingTables(pool);
    if (missingTables.length > 0) {
      logger.error(`Database schema incomplete (missing: ${missingTables.join(', ')}). Run: npm run migrate`);
    }
  } catch (error) {
    logger.error('PostgreSQL connection unavailable. The server is running in degraded mode.', { error: error.message });
  }

  const shutdown = () => {
    // Les flux SSE restent ouverts indéfiniment : on les ferme d'abord,
    // sinon server.close() ne se termine jamais.
    realtime.closeAll();
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

// Vercel attend l'application Express comme export principal ;
// les tests et scripts utilisent { app, pool }.
module.exports = app;
module.exports.app = app;
module.exports.pool = pool;
