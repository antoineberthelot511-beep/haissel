const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { getJwtSecret, hashToken } = require('../middleware/auth.middleware');
const { sendError } = require('../utils/http');
const { getClientIp } = require('../utils/network');
const { logger } = require('../utils/logger');

const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;
const BCRYPT_ROUNDS = 12;
// Hash factice : la vérification prend le même temps que l'utilisateur
// existe ou non (évite l'énumération des comptes par mesure du temps).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('haissel-timing-protection', BCRYPT_ROUNDS);

const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PUBLIC_USER_COLUMNS = 'id, username, email, display_name, avatar_url, bio, created_at, updated_at, is_active, is_banned';

function sanitizeUser(user, role) {
  if (!user) return null;
  const { password_hash: _passwordHash, ...publicUser } = user;
  return { ...publicUser, role: (role || publicUser.role || 'USER').toUpperCase() };
}

async function createSession(user, req) {
  const token = jwt.sign(
    { sub: String(user.id), jti: crypto.randomUUID() },
    getJwtSecret(),
    { expiresIn: SESSION_DURATION_SECONDS, algorithm: 'HS256' }
  );

  await pool.query(
    `
      INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)
    `,
    [
      user.id,
      hashToken(token),
      (req.get('user-agent') || '').slice(0, 500) || null,
      getClientIp(req) || null,
      String(SESSION_DURATION_SECONDS),
    ]
  );

  return token;
}

async function getRole(userId) {
  const result = await pool.query('SELECT role FROM admins WHERE user_id = $1', [userId]);
  return result.rows[0]?.role || 'USER';
}

function validateRegistration(body) {
  const {
    username, email, password, confirm_password: confirmPassword,
    display_name: displayName, first_name: firstName, last_name: lastName,
  } = body || {};

  if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    return { error: ['INVALID_REQUEST', "Nom d'utilisateur, e-mail et mot de passe sont obligatoires."] };
  }
  if (typeof confirmPassword !== 'string' || password !== confirmPassword) {
    return { error: ['PASSWORD_MISMATCH', 'La confirmation du mot de passe ne correspond pas.'] };
  }

  const normalizedUsername = username.trim().toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();
  const optional = (value) => (typeof value === 'string' ? value.trim() : '');
  const fullName = optional(displayName)
    || `${optional(firstName)} ${optional(lastName)}`.trim()
    || normalizedUsername;

  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return { error: ['INVALID_USERNAME', "Le nom d'utilisateur doit contenir 3 à 30 caractères : lettres minuscules, chiffres ou _."] };
  }
  if (normalizedEmail.length > 255 || !EMAIL_PATTERN.test(normalizedEmail)) {
    return { error: ['INVALID_EMAIL', "L'adresse e-mail est invalide."] };
  }

  const allowedDomain = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
  if (allowedDomain && normalizedEmail.split('@')[1] !== allowedDomain) {
    return { error: ['EMAIL_DOMAIN_NOT_ALLOWED', `Seules les adresses @${allowedDomain} sont acceptées.`] };
  }

  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes < 8 || passwordBytes > 72) {
    return { error: ['INVALID_PASSWORD', 'Le mot de passe doit contenir entre 8 et 72 caractères.'] };
  }
  if (fullName.length > 100) {
    return { error: ['INVALID_DISPLAY_NAME', 'Le nom affiché ne doit pas dépasser 100 caractères.'] };
  }

  return {
    value: {
      username: normalizedUsername,
      email: normalizedEmail,
      password,
      displayName: fullName,
    },
  };
}

async function register(req, res, next) {
  try {
    const { error, value } = validateRegistration(req.body);
    if (error) return sendError(res, 400, error[0], error[1]);

    const passwordHash = await bcrypt.hash(value.password, BCRYPT_ROUNDS);
    const insertResult = await pool.query(
      `
        INSERT INTO users (username, email, password_hash, display_name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING ${PUBLIC_USER_COLUMNS}
      `,
      [value.username, value.email, passwordHash, value.displayName]
    );

    const user = insertResult.rows[0];
    const token = await createSession(user, req);
    logger.info('User registered', { userId: user.id });

    return res.status(201).json({
      success: true,
      data: { user: sanitizeUser(user, 'USER'), token },
    });
  } catch (error) {
    if (error.code === '23505') {
      const isEmail = String(error.constraint || error.detail || '').includes('email');
      return sendError(
        res,
        409,
        'USER_ALREADY_EXISTS',
        isEmail ? 'Cette adresse e-mail est déjà utilisée.' : "Ce nom d'utilisateur est déjà pris."
      );
    }
    return next(error);
  }
}

async function login(req, res, next) {
  try {
    const { identifier, password } = req.body || {};

    if (typeof identifier !== 'string' || typeof password !== 'string'
      || !identifier.trim() || !password || identifier.length > 255 || password.length > 200) {
      return sendError(res, 400, 'INVALID_REQUEST', 'Identifiant et mot de passe obligatoires.');
    }

    const normalized = identifier.trim().toLowerCase();
    const result = await pool.query(
      `
        SELECT ${PUBLIC_USER_COLUMNS}, password_hash
        FROM users
        WHERE username = $1 OR email = $1
        LIMIT 1
      `,
      [normalized]
    );

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);

    if (!user || !match) {
      logger.warn('Failed login attempt', { ip: getClientIp(req) });
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Identifiants incorrects.');
    }

    // Le statut n'est révélé qu'après un mot de passe correct.
    if (user.is_banned) {
      return sendError(res, 403, 'ACCOUNT_BANNED', 'Ce compte a été banni.');
    }
    if (!user.is_active) {
      return sendError(res, 403, 'ACCOUNT_DISABLED', 'Ce compte est suspendu.');
    }

    const [token, role] = await Promise.all([createSession(user, req), getRole(user.id)]);

    return res.status(200).json({
      success: true,
      data: { user: sanitizeUser(user, role), token },
    });
  } catch (error) {
    return next(error);
  }
}

async function logout(req, res, next) {
  try {
    await pool.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [req.tokenHash]
    );

    return res.status(200).json({
      success: true,
      data: { message: 'Déconnexion effectuée.' },
    });
  } catch (error) {
    return next(error);
  }
}

function me(req, res) {
  return res.status(200).json({
    success: true,
    data: { user: sanitizeUser(req.user, req.userRole) },
  });
}

module.exports = {
  register,
  login,
  logout,
  me,
  SESSION_DURATION_SECONDS,
};
