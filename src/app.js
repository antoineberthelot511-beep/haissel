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
const { generalRateLimiter } = require('./middleware/rate-limit.middleware');
const { errorMiddleware } = require('./middleware/error.middleware');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost',
    credentials: true,
  })
);
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(generalRateLimiter);

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

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

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/posts', postsRouter);
app.use('/api', commentsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/conversations', messagesRouter);
app.use('/api/reports', reportsRouter);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found.',
    },
  });
});

app.use(errorMiddleware);

const startServer = async () => {
  const jwtSecret = process.env.JWT_SECRET || '';
  const isPlaceholderSecret = /change_me|replace_with|local-development/i.test(jwtSecret);
  if (
    Buffer.byteLength(jwtSecret, 'utf8') < 32
    || (process.env.NODE_ENV === 'production' && isPlaceholderSecret)
  ) {
    console.error('JWT_SECRET must be a unique secret of at least 32 bytes; example values are not allowed in production.');
    process.exit(1);
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });

  try {
    await testConnection();
    console.log('PostgreSQL connection successful.');
  } catch (error) {
    console.error('PostgreSQL connection unavailable. The server is running in degraded mode.', error.message);
  }

  const shutdown = () => {
    server.close(async () => {
      try {
        await pool.end();
        process.exit(0);
      } catch (error) {
        console.error('Error while closing PostgreSQL connections:', error.message);
        process.exit(1);
      }
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

startServer();

module.exports = { app, pool };
