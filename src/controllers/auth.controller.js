const { pool, withTransaction } = require('../config/database');
const {
  isMailEnabled,
  isEmailVerificationRequired,
  isAdminMfaRequired,
  isVercel,
} = require('../config/security');
const { sendError } = require('../utils/http');
const { needsDeclaration, canDeclareAdult, ADULT_AGE } = require('../services/adult.service');
const { isAdminAccessAllowed } = require('../utils/network');
const throttle = require('../utils/login-throttle');
const {
  hashPassword,
  verifyPassword,
  checkPasswordPolicy,
  getDummyHash,
  PASSWORD_MIN,
  PASSWORD_MAX,
} = require('../services/password.service');
const {
  createSession,
  revokeSession,
  revokeAllSessions,
  revokeRequestSession,
  clearSessionCookies,
  csrfTokenFor,
} = require('../services/session.service');
const { issueToken, consumeToken, peekToken } = require('../services/auth-token.service');
const mail = require('../services/mail.service');
const mfa = require('../services/mfa.service');
const turnstile = require('../services/turnstile.service');
const { logSecurityEvent } = require('../services/security-log.service');

/*
 * Authentification HAISSEL.
 *
 * - Mots de passe Argon2id (password.service), migration progressive bcrypt.
 * - Session serveur dans un cookie HttpOnly ; aucun jeton n'est jamais
 *   renvoyé au JavaScript. Seul le jeton CSRF (non secret vis-à-vis de la
 *   page, mais lié à la session) est transmis.
 * - Messages génériques : l'existence d'un compte n'est jamais révélée avant
 *   la saisie du bon mot de passe.
 */

const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M} '’-]{0,59}$/u;
const MFA_MAX_FAILURES = 5;

const mfaFailures = new Map();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().normalize('NFC');
}

/** Liste blanche des champs exposés au navigateur. */
function publicUser(user, role) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    created_at: user.created_at,
    email_verified: Boolean(user.email_verified_at),
    mfa_enabled: Boolean(user.mfa_enabled),
    role: String(role || user.role || 'USER').toUpperCase(),
    /*
     * Déclaration de majorité. « null » signifie que la question n'a pas
     * encore été posée : l'interface doit alors la poser avant toute autre
     * chose. La date de naissance n'est jamais transmise : elle n'existe pas.
     */
    is_adult: user.is_adult === null || user.is_adult === undefined ? null : Boolean(user.is_adult),
    adult_declaration_required: needsDeclaration(user),
    // Feuille d'installation de l'app déjà fermée une fois (sur n'importe quel appareil).
    install_tuto_seen: Boolean(user.install_tuto_seen_at),
  };
}

async function getRole(userId) {
  const result = await pool.query('SELECT role FROM admins WHERE user_id = $1', [userId]);
  return String(result.rows[0]?.role || 'USER').toUpperCase();
}

const USER_COLUMNS = `id, username, email, display_name, first_name, last_name, created_at,
  is_active, is_banned, email_verified_at, mfa_enabled, password_hash,
  is_adult, adult_declared_at, install_tuto_seen_at`;

// ---------------------------------------------------------------------------
// Configuration publique (le frontend n'affiche que ce qui fonctionne)
// ---------------------------------------------------------------------------

function getAuthConfig(req, res) {
  return res.status(200).json({
    success: true,
    data: {
      email_enabled: isMailEnabled(),
      email_verification_required: isEmailVerificationRequired(),
      password_min_length: PASSWORD_MIN,
      password_max_length: PASSWORD_MAX,
      // Clé PUBLIQUE uniquement : la clé secrète ne quitte jamais le serveur.
      turnstile_site_key: turnstile.isTurnstileEnabled() ? turnstile.getSiteKey() : null,
      /*
       * Canal des notifications : « sse » (flux permanent) en local et sous
       * Docker, « poll » sur Vercel où plusieurs instances répondent sans
       * mémoire partagée. Le client choisit son mode d'après cette valeur.
       */
      realtime_mode: isVercel() ? 'poll' : 'sse',
      // Âge minimum pour un compte éditeur MyLead (voir adult.service).
      adult_age: ADULT_AGE,
    },
  });
}

// ---------------------------------------------------------------------------
// Inscription
// ---------------------------------------------------------------------------

function validateRegistration(body) {
  const source = body || {};
  const str = (value) => (typeof value === 'string' ? value : '');
  const firstName = str(source.first_name).trim();
  const lastName = str(source.last_name).trim();
  const username = str(source.username).trim().toLowerCase();
  const email = normalizeEmail(source.email);
  const password = str(source.password);
  const confirm = str(source.confirm_password);

  if (!NAME_PATTERN.test(firstName) || !NAME_PATTERN.test(lastName)) {
    return { error: ['INVALID_NAME', 'Prénom et nom : 1 à 60 lettres.'] };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { error: ['INVALID_USERNAME', 'Le pseudo doit contenir 3 à 30 caractères : lettres minuscules, chiffres ou _.'] };
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return { error: ['INVALID_EMAIL', "L'adresse e-mail est invalide."] };
  }
  const allowedDomain = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
  if (allowedDomain && email.split('@')[1] !== allowedDomain) {
    return { error: ['EMAIL_DOMAIN_NOT_ALLOWED', `Seules les adresses @${allowedDomain} sont acceptées.`] };
  }
  if (password !== confirm) {
    return { error: ['PASSWORD_MISMATCH', 'La confirmation du mot de passe ne correspond pas.'] };
  }
  const policyError = checkPasswordPolicy(password, { username, email });
  if (policyError) return { error: ['WEAK_PASSWORD', policyError] };

  /*
   * Majorité : réponse obligatoire, et strictement booléenne. Une valeur
   * absente, une chaîne ou un nombre sont refusés plutôt qu'interprétés :
   * « non répondu » ne doit jamais devenir « oui » par accident.
   */
  if (source.is_adult !== true && source.is_adult !== false) {
    return { error: ['ADULT_ANSWER_REQUIRED', `Indique si tu as ${ADULT_AGE} ans ou plus : la réponse est obligatoire.`] };
  }

  return {
    value: {
      firstName, lastName, username, email, password,
      displayName: `${firstName} ${lastName}`,
      isAdult: source.is_adult,
    },
  };
}

async function register(req, res, next) {
  try {
    const { error, value } = validateRegistration(req.body);
    if (error) return sendError(res, 400, error[0], error[1]);

    const passwordHash = await hashPassword(value.password);
    const verificationRequired = isEmailVerificationRequired();

    let user;
    try {
      const result = await pool.query(
        `
          INSERT INTO users (username, email, password_hash, display_name, first_name, last_name,
                             is_adult, adult_declared_at, password_changed_at, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW(), NOW())
          RETURNING ${USER_COLUMNS}
        `,
        [value.username, value.email, passwordHash, value.displayName, value.firstName, value.lastName,
          value.isAdult]
      );
      user = result.rows[0];
    } catch (insertError) {
      if (insertError.code !== '23505') throw insertError;
      const isEmail = /email/.test(String(insertError.constraint || insertError.detail || ''));

      if (isEmail && verificationRequired) {
        // Réponse identique à un succès : l'existence de l'adresse n'est pas révélée.
        await logSecurityEvent('register_duplicate_email', { req });
        return res.status(202).json({ success: true, data: { verification_required: true } });
      }
      return sendError(
        res,
        409,
        'USER_ALREADY_EXISTS',
        isEmail ? 'Cette adresse e-mail est déjà utilisée.' : 'Ce pseudo est déjà pris.'
      );
    }

    await logSecurityEvent('register', { req, userId: user.id });

    if (verificationRequired) {
      const token = await issueToken(user.id, 'verify_email');
      if (token) await mail.sendVerificationEmail(user, token);
      return res.status(202).json({ success: true, data: { verification_required: true } });
    }

    const { csrfToken } = await createSession(req, res, user, { role: 'USER' });
    return res.status(201).json({
      success: true,
      data: { user: publicUser(user, 'USER'), csrf_token: csrfToken, verification_required: false },
    });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Connexion (e-mail OU pseudo)
// ---------------------------------------------------------------------------

async function login(req, res, next) {
  try {
    const { identifier, password } = req.body || {};
    if (typeof identifier !== 'string' || typeof password !== 'string'
      || !identifier.trim() || !password || identifier.length > 254 || password.length > 1024) {
      return sendError(res, 400, 'INVALID_REQUEST', 'Adresse e-mail ou pseudo et mot de passe obligatoires.');
    }

    // « @ » présent = e-mail, sinon pseudo : un pseudo ne peut pas contenir
    // « @ » (contrainte SQL), aucune collision possible entre les deux.
    const normalized = normalizeEmail(identifier);
    const column = normalized.includes('@') ? 'email' : 'username';
    const throttleKey = `${column}:${normalized}`;

    const delay = await throttle.delayFor(throttleKey);
    if (delay) await throttle.sleep(delay);

    const result = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE ${column} = $1`, [normalized]);
    const user = result.rows[0];
    const { valid, needsRehash } = await verifyPassword(user ? user.password_hash : await getDummyHash(), password);

    if (!user || !valid) {
      await throttle.recordFailure(throttleKey);
      await logSecurityEvent('login_failed', { req, userId: user?.id || null, details: { by: column } });
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Identifiants incorrects.');
    }
    await throttle.recordSuccess(throttleKey);

    // Statut révélé seulement après un mot de passe correct.
    if (user.is_banned) {
      await logSecurityEvent('login_refused_banned', { req, userId: user.id });
      return sendError(res, 403, 'ACCOUNT_BANNED', 'Ce compte a été banni.');
    }
    if (!user.is_active) {
      await logSecurityEvent('login_refused_disabled', { req, userId: user.id });
      return sendError(res, 403, 'ACCOUNT_DISABLED', 'Ce compte est suspendu.');
    }

    const role = await getRole(user.id);
    if (role !== 'USER' && !isAdminAccessAllowed(req)) {
      await logSecurityEvent('admin_login_refused_remote', { req, userId: user.id });
      return sendError(res, 403, 'ADMIN_LOCAL_ONLY', 'Ce compte ne peut se connecter que depuis le serveur.');
    }

    if (isEmailVerificationRequired() && !user.email_verified_at) {
      return sendError(res, 403, 'EMAIL_NOT_VERIFIED', 'Confirmez votre adresse e-mail avant de vous connecter.');
    }

    if (needsRehash) {
      const newHash = await hashPassword(password);
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, newHash]);
      await logSecurityEvent('password_rehashed_argon2id', { req, userId: user.id });
    }

    // Rotation : toute session déjà présente dans ce navigateur est révoquée.
    await revokeRequestSession(req, 'rotated_on_login');

    if (user.mfa_enabled) {
      const { csrfToken } = await createSession(req, res, user, { role, mfaPending: true });
      await logSecurityEvent('login_password_ok_mfa_pending', { req, userId: user.id });
      return res.status(200).json({ success: true, data: { mfa_required: true, csrf_token: csrfToken } });
    }

    const { csrfToken } = await createSession(req, res, user, { role });
    await logSecurityEvent('login_success', { req, userId: user.id });
    return res.status(200).json({
      success: true,
      data: { user: publicUser(user, role), csrf_token: csrfToken, mfa_required: false },
    });
  } catch (error) {
    return next(error);
  }
}

/** Deuxième étape : code TOTP ou code de récupération. */
async function verifyMfaLogin(req, res, next) {
  try {
    if (!req.session.mfaPending) {
      return sendError(res, 400, 'MFA_NOT_PENDING', 'Aucune vérification en attente.');
    }
    const userId = req.user.id;
    const { code, recovery_code: recoveryCode } = req.body || {};

    const row = (await pool.query(
      'SELECT mfa_secret_enc, mfa_last_step FROM users WHERE id = $1 AND mfa_enabled = true',
      [userId]
    )).rows[0];

    let ok = false;
    if (row && typeof code === 'string' && code) {
      const step = mfa.verifyTotp(mfa.decryptSecret(row.mfa_secret_enc), code.replace(/\s/g, ''), row.mfa_last_step);
      if (step !== null) {
        // Anti-rejeu : le pas n'est accepté qu'une fois (mise à jour conditionnelle).
        const updated = await pool.query(
          'UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)',
          [userId, step]
        );
        ok = updated.rowCount === 1;
      }
    } else if (row && typeof recoveryCode === 'string' && recoveryCode) {
      const used = await pool.query(
        `UPDATE mfa_recovery_codes SET used_at = NOW()
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
        [userId, mfa.hashRecoveryCode(recoveryCode)]
      );
      ok = used.rowCount === 1;
      if (ok) await logSecurityEvent('mfa_recovery_code_used', { req, userId });
    }

    if (!ok) {
      const failures = (mfaFailures.get(req.session.id) || 0) + 1;
      mfaFailures.set(req.session.id, failures);
      await logSecurityEvent('mfa_failed', { req, userId });
      if (failures >= MFA_MAX_FAILURES) {
        mfaFailures.delete(req.session.id);
        await revokeSession(req.session.id, 'mfa_too_many_failures');
        clearSessionCookies(req, res);
        return sendError(res, 401, 'MFA_LOCKED', 'Trop de codes incorrects. Reconnectez-vous.');
      }
      return sendError(res, 401, 'INVALID_MFA_CODE', 'Code incorrect.');
    }

    mfaFailures.delete(req.session.id);
    await revokeSession(req.session.id, 'mfa_completed');
    const { csrfToken } = await createSession(req, res, req.user, { role: req.userRole });
    await logSecurityEvent('login_success', { req, userId, details: { mfa: true } });

    return res.status(200).json({
      success: true,
      data: { user: publicUser(req.user, req.userRole), csrf_token: csrfToken },
    });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Session courante / déconnexion
// ---------------------------------------------------------------------------

function me(req, res) {
  return res.status(200).json({
    success: true,
    data: {
      user: req.session.mfaPending ? null : publicUser(req.user, req.userRole),
      mfa_pending: req.session.mfaPending,
      csrf_token: csrfTokenFor(req.session.tokenHash),
      admin_mfa_required: req.userRole !== 'USER' && isAdminMfaRequired() && !req.user.mfa_enabled,
    },
  });
}


/*
 * Déclaration de majorité des comptes existants.
 *
 * Les comptes créés avant la mise en place ont is_adult à NULL : l'interface
 * pose la question à la connexion suivante et appelle cette route.
 *
 * La réponse reste modifiable : un membre qui avait 17 ans peut en avoir 18
 * l'année suivante, et le bloquer définitivement n'apporterait rien — il
 * s'agit d'une déclaration sur l'honneur, pas d'une vérification. Chaque
 * réponse est horodatée et journalisée.
 */
/**
 * POST /api/auth/install-tuto/seen : feuille d'installation fermée.
 * Mémorisé sur le compte : elle ne s'ouvrira plus d'elle-même, sur aucun
 * appareil. La première date est conservée.
 */
async function markInstallTutoSeen(req, res, next) {
  try {
    await pool.query(
      'UPDATE users SET install_tuto_seen_at = COALESCE(install_tuto_seen_at, NOW()) WHERE id = $1',
      [req.user.id]
    );
    return res.status(200).json({ success: true, data: { install_tuto_seen: true } });
  } catch (error) {
    return next(error);
  }
}

async function declareAdult(req, res, next) {
  try {
    const value = (req.body || {}).is_adult;
    if (value !== true && value !== false) {
      return sendError(res, 400, 'ADULT_ANSWER_REQUIRED',
        `Indique si tu as ${ADULT_AGE} ans ou plus : la réponse est obligatoire.`);
    }

    /*
     * Passage de « non » à « oui » : soumis à un délai, sinon la question
     * n'aurait aucune portée. L'inverse reste immédiat.
     */
    if (value === true) {
      const check = canDeclareAdult(req.user);
      if (!check.allowed) {
        await logSecurityEvent('adult_upgrade_refused', { req, userId: req.user.id });
        return sendError(res, 403, 'ADULT_CHANGE_TOO_SOON',
          `Tu as déclaré avoir moins de 18 ans il y a peu. Cette réponse ne peut pas être modifiée `
          + `avant ${check.daysLeft} jour(s). Si c'est une erreur, écris à l'administrateur du site `
          + `depuis les mentions légales : il peut remettre la question à zéro.`);
      }
    }

    const result = await pool.query(
      `UPDATE users SET is_adult = $2, adult_declared_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [req.user.id, value]
    );
    const user = result.rows[0];
    if (!user) return sendError(res, 404, 'NOT_FOUND', 'Compte introuvable.');

    await logSecurityEvent('adult_declared', { req, userId: req.user.id, details: { is_adult: value } });
    return res.status(200).json({ success: true, data: { user: publicUser(user, req.userRole) } });
  } catch (error) {
    return next(error);
  }
}

async function logout(req, res, next) {
  try {
    await revokeSession(req.session.id, 'logout');
    clearSessionCookies(req, res);
    await logSecurityEvent('logout', { req, userId: req.user.id });
    return res.status(200).json({ success: true, data: { message: 'Déconnexion effectuée.' } });
  } catch (error) {
    return next(error);
  }
}

async function logoutAll(req, res, next) {
  try {
    const count = await revokeAllSessions(req.user.id, 'logout_all');
    clearSessionCookies(req, res);
    await logSecurityEvent('logout_all', { req, userId: req.user.id, details: { sessions: count } });
    return res.status(200).json({ success: true, data: { revoked: count } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Vérification d'adresse e-mail
// ---------------------------------------------------------------------------

async function verifyEmail(req, res, next) {
  try {
    const userId = await consumeToken((req.body || {}).token, 'verify_email');
    if (!userId) {
      return sendError(res, 400, 'INVALID_TOKEN', 'Ce lien est invalide, expiré ou déjà utilisé.');
    }
    await pool.query(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1',
      [userId]
    );
    await logSecurityEvent('email_verified', { req, userId });
    return res.status(200).json({ success: true, data: { message: 'Adresse e-mail confirmée. Vous pouvez vous connecter.' } });
  } catch (error) {
    return next(error);
  }
}

const NEUTRAL_EMAIL_REPLY = 'Si un compte correspond à cette adresse, un e-mail vient d’être envoyé.';

async function resendVerification(req, res, next) {
  try {
    if (!isMailEnabled()) {
      return sendError(res, 503, 'MAIL_DISABLED', "L'envoi d'e-mails n'est pas configuré sur ce serveur.");
    }
    const email = normalizeEmail((req.body || {}).email);
    if (EMAIL_PATTERN.test(email)) {
      const user = (await pool.query(
        'SELECT id, email FROM users WHERE email = $1 AND email_verified_at IS NULL AND is_active AND NOT is_banned',
        [email]
      )).rows[0];
      if (user) {
        const token = await issueToken(user.id, 'verify_email');
        if (token) await mail.sendVerificationEmail(user, token);
      }
    }
    return res.status(202).json({ success: true, data: { message: NEUTRAL_EMAIL_REPLY } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Mot de passe oublié / réinitialisation
// ---------------------------------------------------------------------------

async function forgotPassword(req, res, next) {
  try {
    if (!isMailEnabled()) {
      return sendError(res, 503, 'MAIL_DISABLED', "L'envoi d'e-mails n'est pas configuré : contactez l'administrateur.");
    }
    const email = normalizeEmail((req.body || {}).email);
    if (EMAIL_PATTERN.test(email)) {
      const user = (await pool.query(
        'SELECT id, email FROM users WHERE email = $1 AND is_active AND NOT is_banned',
        [email]
      )).rows[0];
      if (user) {
        const token = await issueToken(user.id, 'reset_password');
        if (token) await mail.sendPasswordResetEmail(user, token);
        await logSecurityEvent('password_reset_requested', { req, userId: user.id });
      }
    }
    // Réponse identique, que le compte existe ou non.
    return res.status(202).json({ success: true, data: { message: NEUTRAL_EMAIL_REPLY } });
  } catch (error) {
    return next(error);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token, password, confirm_password: confirm } = req.body || {};
    const invalid = () => sendError(res, 400, 'INVALID_TOKEN', 'Ce lien est invalide, expiré ou déjà utilisé.');

    const userId = await peekToken(token, 'reset_password');
    if (!userId) return invalid();

    const user = (await pool.query('SELECT id, username, email FROM users WHERE id = $1', [userId])).rows[0];
    if (typeof password !== 'string' || password !== confirm) {
      return sendError(res, 400, 'PASSWORD_MISMATCH', 'La confirmation du mot de passe ne correspond pas.');
    }
    const policyError = checkPasswordPolicy(password, user);
    if (policyError) return sendError(res, 400, 'WEAK_PASSWORD', policyError);

    const newHash = await hashPassword(password);

    // Le mot de passe n'est modifié QUE si le jeton est consommé avec succès,
    // dans la même transaction que la révocation des sessions.
    const changed = await withTransaction(async (client) => {
      const consumedFor = await consumeToken(token, 'reset_password', client);
      if (consumedFor !== userId) return false;
      await client.query(
        'UPDATE users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW() WHERE id = $1',
        [userId, newHash]
      );
      await client.query(
        "UPDATE auth_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = 'reset_password' AND used_at IS NULL",
        [userId]
      );
      await revokeAllSessions(userId, 'password_reset', { db: client });
      return true;
    });
    if (!changed) return invalid();

    clearSessionCookies(req, res);
    await logSecurityEvent('password_reset_completed', { req, userId });
    await mail.sendPasswordChangedNotice(user);

    return res.status(200).json({ success: true, data: { message: 'Mot de passe modifié. Connectez-vous avec le nouveau mot de passe.' } });
  } catch (error) {
    return next(error);
  }
}

async function changePassword(req, res, next) {
  try {
    const { current_password: current, new_password: next_, confirm_password: confirm } = req.body || {};
    const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
    const { valid } = await verifyPassword(row?.password_hash, typeof current === 'string' ? current : '');
    if (!valid) {
      await logSecurityEvent('password_change_failed', { req, userId: req.user.id });
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Mot de passe actuel incorrect.');
    }
    if (typeof next_ !== 'string' || next_ !== confirm) {
      return sendError(res, 400, 'PASSWORD_MISMATCH', 'La confirmation du mot de passe ne correspond pas.');
    }
    const policyError = checkPasswordPolicy(next_, req.user);
    if (policyError) return sendError(res, 400, 'WEAK_PASSWORD', policyError);

    const newHash = await hashPassword(next_);
    await withTransaction(async (client) => {
      await client.query(
        'UPDATE users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW() WHERE id = $1',
        [req.user.id, newHash]
      );
      await revokeAllSessions(req.user.id, 'password_changed', { db: client });
    });

    // Toutes les sessions (y compris celle-ci) sont fermées ; une nouvelle
    // session est ouverte pour l'appareil qui vient de changer le mot de passe.
    const { csrfToken } = await createSession(req, res, req.user, { role: req.userRole });
    await logSecurityEvent('password_changed', { req, userId: req.user.id });
    await mail.sendPasswordChangedNotice(req.user);

    return res.status(200).json({ success: true, data: { csrf_token: csrfToken } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Double authentification (TOTP)
// ---------------------------------------------------------------------------

async function reauthenticate(req, password) {
  const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  const { valid } = await verifyPassword(row?.password_hash, typeof password === 'string' ? password : '');
  return valid;
}

async function mfaSetup(req, res, next) {
  try {
    if (req.user.mfa_enabled) {
      return sendError(res, 409, 'MFA_ALREADY_ENABLED', 'La double authentification est déjà active.');
    }
    if (!(await reauthenticate(req, (req.body || {}).password))) {
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Mot de passe incorrect.');
    }
    const secret = mfa.generateSecret();
    await pool.query('UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1', [req.user.id, mfa.encryptSecret(secret)]);
    await logSecurityEvent('mfa_setup_started', { req, userId: req.user.id });
    return res.status(200).json({
      success: true,
      data: { secret, otpauth_uri: mfa.otpauthUri(secret, req.user.email) },
    });
  } catch (error) {
    return next(error);
  }
}

async function mfaEnable(req, res, next) {
  try {
    const row = (await pool.query('SELECT mfa_pending_secret_enc FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!row?.mfa_pending_secret_enc) {
      return sendError(res, 400, 'MFA_SETUP_MISSING', 'Commencez par générer une clé.');
    }
    const secret = mfa.decryptSecret(row.mfa_pending_secret_enc);
    const step = mfa.verifyTotp(secret, String((req.body || {}).code || '').replace(/\s/g, ''));
    if (step === null) {
      await logSecurityEvent('mfa_enable_failed', { req, userId: req.user.id });
      return sendError(res, 400, 'INVALID_MFA_CODE', 'Code incorrect. Vérifiez l’heure de votre téléphone.');
    }

    const recoveryCodes = mfa.generateRecoveryCodes();
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE users SET mfa_enabled = true, mfa_secret_enc = mfa_pending_secret_enc,
                          mfa_pending_secret_enc = NULL, mfa_last_step = $2, updated_at = NOW()
         WHERE id = $1`,
        [req.user.id, step]
      );
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [req.user.id]);
      for (const code of recoveryCodes) {
        await client.query(
          'INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
          [req.user.id, mfa.hashRecoveryCode(code)]
        );
      }
      // Changement du niveau de sécurité : rotation, les autres sessions sont fermées.
      await revokeAllSessions(req.user.id, 'mfa_enabled', { db: client });
    });

    const { csrfToken } = await createSession(req, res, req.user, { role: req.userRole });
    await logSecurityEvent('mfa_enabled', { req, userId: req.user.id });

    // Les codes de récupération ne sont affichés qu'une seule fois.
    return res.status(200).json({ success: true, data: { recovery_codes: recoveryCodes, csrf_token: csrfToken } });
  } catch (error) {
    return next(error);
  }
}

async function mfaDisable(req, res, next) {
  try {
    if (!req.user.mfa_enabled) {
      return sendError(res, 400, 'MFA_NOT_ENABLED', 'La double authentification n’est pas active.');
    }
    if (req.userRole !== 'USER' && isAdminMfaRequired()) {
      return sendError(res, 403, 'MFA_REQUIRED_FOR_ADMIN', 'Un compte administrateur ne peut pas désactiver la double authentification.');
    }
    const { password, code } = req.body || {};
    const row = (await pool.query('SELECT mfa_secret_enc, mfa_last_step FROM users WHERE id = $1', [req.user.id])).rows[0];
    const codeOk = mfa.verifyTotp(mfa.decryptSecret(row.mfa_secret_enc), String(code || ''), row.mfa_last_step) !== null;
    if (!codeOk || !(await reauthenticate(req, password))) {
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Mot de passe ou code incorrect.');
    }
    await withTransaction(async (client) => {
      await client.query(
        'UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL WHERE id = $1',
        [req.user.id]
      );
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [req.user.id]);
    });
    await logSecurityEvent('mfa_disabled', { req, userId: req.user.id });
    return res.status(200).json({ success: true, data: { mfa_enabled: false } });
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// Droits RGPD : accès / portabilité (art. 15, 20) et effacement (art. 17)
// ---------------------------------------------------------------------------

async function exportMyData(req, res, next) {
  try {
    const userId = req.user.id;
    const query = async (sql) => (await pool.query(sql, [userId])).rows;
    const user = (await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId])).rows[0];
    const data = {
      exported_at: new Date().toISOString(),
      account: publicUser(user, req.userRole),
      affiliate_codes: await query(`
        SELECT c.code, l.name AS offer, c.created_at
        FROM user_affiliate_codes c JOIN affiliate_links l ON l.id = c.affiliate_link_id
        WHERE c.user_id = $1 ORDER BY c.created_at`),
      clicks: await query(`
        SELECT affiliate_link_id, ip_address, user_agent, referrer, created_at
        FROM clicks WHERE user_id = $1 ORDER BY created_at`),
      conversions: await query(`
        SELECT affiliate_link_id, status, amount_cents, currency, created_at, processed_at
        FROM conversions WHERE user_id = $1 ORDER BY created_at`),
      earnings: await query(`
        SELECT affiliate_link_id, status, amount_cents, currency, created_at, paid_at
        FROM earnings WHERE user_id = $1 ORDER BY created_at`),
      sessions: await query(`
        SELECT ip_address, user_agent, created_at, last_seen_at, expires_at, revoked_at
        FROM sessions WHERE user_id = $1 ORDER BY created_at`),
      security_events: await query(`
        SELECT event, ip_address, user_agent, created_at
        FROM security_events WHERE user_id = $1 ORDER BY created_at`),
      member_offers: await query(`
        SELECT title, url, description, category, countries, expected_action, payout_text, min_age, conditions,
               status, moderation_note, created_at, updated_at, published_at
        FROM member_offers WHERE user_id = $1 ORDER BY created_at`),
      saved_offers: await query(`
        SELECT offer_id, created_at FROM member_offer_saves WHERE user_id = $1 ORDER BY created_at`),
      offer_reports: await query(`
        SELECT offer_id, reason, details, created_at FROM member_offer_reports WHERE user_id = $1 ORDER BY created_at`),
    };
    await logSecurityEvent('data_export', { req, userId });
    res.set('Content-Disposition', 'attachment; filename="haissel-mes-donnees.json"');
    res.set('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (error) {
    return next(error);
  }
}

async function deleteMyAccount(req, res, next) {
  try {
    if (req.userRole !== 'USER') {
      return sendError(res, 403, 'ADMIN_ACCOUNT', 'Un compte administrateur se supprime depuis le serveur (scripts/promote-admin.js).');
    }
    const { password, confirm } = req.body || {};
    if (confirm !== 'SUPPRIMER') {
      return sendError(res, 400, 'CONFIRMATION_REQUIRED', 'Tapez SUPPRIMER pour confirmer.');
    }
    if (!(await reauthenticate(req, password))) {
      return sendError(res, 401, 'INVALID_CREDENTIALS', 'Mot de passe incorrect.');
    }
    const userId = req.user.id;
    // Sessions, codes, gains… partent en cascade ; clics et journal passent à user_id NULL
    // puis sont purgés selon les durées de retention.service.
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    clearSessionCookies(req, res);
    await logSecurityEvent('account_deleted', { req, details: { former_user_id: userId } });
    return res.status(200).json({ success: true, data: { deleted: true } });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAuthConfig,
  exportMyData,
  deleteMyAccount,
  register,
  login,
  verifyMfaLogin,
  me,
  logout,
  logoutAll,
  verifyEmail,
  declareAdult,
  markInstallTutoSeen,
  resendVerification,
  forgotPassword,
  resetPassword,
  changePassword,
  mfaSetup,
  mfaEnable,
  mfaDisable,
  publicUser,
};
