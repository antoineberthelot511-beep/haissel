const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

const { pool, testConnection } = require('./config/database');

const authRouter = require('./routes/auth.routes');
const usersRouter = require('./routes/users.routes');
const postsRouter = require('./routes/posts.routes');
const commentsRouter = require('./routes/comments.routes');
const notificationsRouter = require('./routes/notifications.routes');
const messagesRouter = require('./routes/messages.routes');
const reportsRouter = require('./routes/reports.routes');
const affiliateRouter = require('./routes/affiliate.routes');
const adminRouter = require('./routes/admin.routes');

const { generalRateLimiter } = require('./middleware/rate-limit.middleware');
const { errorMiddleware } = require('./middleware/error.middleware');
const {
  authenticateToken,
  ensureAdmin,
} = require('./middleware/auth.middleware');

dotenv.config({
  path: path.resolve(__dirname, '../.env'),
});

const app = express();
const port = Number(process.env.PORT || 3000);

const frontendPath = path.join(__dirname, '../frontend');
const userPagePath = path.join(frontendPath, 'index.html');
const adminPagePath = path.join(frontendPath, 'admin.html');

/*
 * ============================================================
 * UTILITAIRES RESEAU
 * ============================================================
 */

/**
 * Vérifie si la requête vient du même ordinateur.
 *
 * Les navigateurs peuvent utiliser :
 * - 127.0.0.1
 * - ::1
 * - ::ffff:127.0.0.1
 */
const isLocalRequest = (req) => {
  const remoteAddress = req.socket.remoteAddress;

  return (
    remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
  );
};

/**
 * Protège les interfaces et routes d'administration.
 *
 * L'administration doit rester accessible uniquement
 * depuis le mini-PC lui-même.
 */
const requireLocalAdmin = (req, res, next) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'ADMIN_LOCAL_ONLY',
        message: 'Administration accessible uniquement depuis le serveur.',
      },
    });
  }

  next();
};

/*
 * ============================================================
 * SECURITE / MIDDLEWARES
 * ============================================================
 */

app.use(helmet());

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost',
    credentials: true,
  })
);

/*
 * Le serveur fonctionne actuellement directement sur le réseau,
 * sans reverse proxy.
 *
 * Si Nginx est ajouté plus tard devant Node, cette configuration
 * devra être adaptée.
 */
app.set('trust proxy', false);

app.use(express.json({ limit: '16kb' }));

app.use(generalRateLimiter);

/*
 * Désactivation du cache pour éviter de garder une ancienne
 * version de l'interface dans le navigateur.
 */
app.use((req, res, next) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  next();
});

/*
 * ============================================================
 * INTERFACE ADMIN
 * ============================================================
 *
 * /admin.html est protégé AVANT express.static afin qu'un
 * appareil du Wi-Fi ne puisse pas simplement demander
 * directement ce fichier.
 */

app.get('/admin.html', requireLocalAdmin, (req, res) => {
  res.sendFile(adminPagePath);
});

/*
 * ============================================================
 * FICHIERS STATIQUES
 * ============================================================
 *
 * index:false est important :
 * Express ne doit pas servir automatiquement index.html
 * avant notre logique personnalisée sur "/".
 */
app.use(
  express.static(frontendPath, {
    index: false,
    maxAge: 0,
    etag: false,
    lastModified: false,
  })
);

/*
 * ============================================================
 * PAGE D'ACCUEIL
 * ============================================================
 *
 * localhost / 127.0.0.1
 *      -> ADMIN
 *
 * adresse LAN (192.168.1.36)
 *      -> SITE UTILISATEUR
 */

app.get('/', (req, res) => {
  if (isLocalRequest(req)) {
    return res.sendFile(adminPagePath);
  }

  return res.sendFile(userPagePath);
});

/*
 * ============================================================
 * API HEALTH
 * ============================================================
 */

app.get('/api/health', async (req, res) => {
  try {
    await testConnection();

    res.status(200).json({
      success: true,
      status: 'ok',
      database: 'connected',
    });
  } catch (error) {
    console.error('Health check failed:', error);

    res.status(503).json({
      success: false,
      status: 'degraded',
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database connection failed.',
      },
    });
  }
});

/*
 * ============================================================
 * API UTILISATEURS
 * ============================================================
 */

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/posts', postsRouter);
app.use('/api', commentsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/conversations', messagesRouter);
app.use('/api/reports', reportsRouter);

/*
 * ============================================================
 * API AFFILIATION
 * ============================================================
 */

app.use('/api/affiliate', affiliateRouter);
app.use('/api/affiliates', affiliateRouter);

/*
 * ============================================================
 * ADMINISTRATION
 * ============================================================
 *
 * Les API admin sont accessibles uniquement depuis localhost.
 */

app.use('/api/admin', requireLocalAdmin, adminRouter);

/*
 * ============================================================
 * PAGE ADMIN / ROUTES ADMIN
 * ============================================================
 */

app.get(
  '/admin',
  requireLocalAdmin,
  authenticateToken,
  ensureAdmin,
  (req, res) => {
    res.sendFile(adminPagePath);
  }
);

app.use('/admin', requireLocalAdmin, adminRouter);

/*
 * ============================================================
 * ESPACE AFFILIES
 * ============================================================
 */

app.get('/mes-affilies', authenticateToken, (req, res) => {
  res.sendFile(path.join(frontendPath, 'affiliates.html'));
});

/*
 * ============================================================
 * 404
 * ============================================================
 */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found.',
    },
  });
});

/*
 * ============================================================
 * GESTION DES ERREURS
 * ============================================================
 */

app.use(errorMiddleware);

/*
 * ============================================================
 * DEMARRAGE DU SERVEUR
 * ============================================================
 */

const startServer = async () => {
  const jwtSecret = process.env.JWT_SECRET || '';

  const isPlaceholderSecret =
    /change_me|replace_with|local-development/i.test(jwtSecret);

  if (
    Buffer.byteLength(jwtSecret, 'utf8') < 32
    || (
      process.env.NODE_ENV === 'production'
      && isPlaceholderSecret
    )
  ) {
    console.error(
      'JWT_SECRET must be a unique secret of at least 32 bytes; example values are not allowed in production.'
    );

    process.exit(1);
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(
      `Server running on http://0.0.0.0:${port}`
    );
  });

  try {
    await testConnection();

    console.log(
      'PostgreSQL connection successful.'
    );
  } catch (error) {
    console.error(
      'PostgreSQL connection unavailable. The server is running in degraded mode.',
      error.message
    );
  }

  const shutdown = () => {
    server.close(async () => {
      try {
        await pool.end();
        process.exit(0);
      } catch (error) {
        console.error(
          'Error while closing PostgreSQL connections:',
          error.message
        );

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