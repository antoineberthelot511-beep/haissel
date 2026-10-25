const crypto = require('crypto');

/*
 * Configuration de sécurité centralisée.
 *
 * APP_SECRET (ou, pour compatibilité, JWT_SECRET) est le secret maître.
 * Des clés distinctes en sont dérivées par HKDF pour chaque usage, afin
 * qu'aucune clé ne serve à deux choses (CSRF, empreinte IP, chiffrement MFA).
 * MFA_ENCRYPTION_KEY peut fournir une clé de chiffrement indépendante.
 */

const PLACEHOLDER = /change_me|replace_with|remplacer|local-development|example|exemple/i;

const isProduction = () => process.env.NODE_ENV === 'production';
const isTest = () => process.env.NODE_ENV === 'test';

/*
 * Déploiement sans état partagé (Vercel) : plusieurs instances de la fonction
 * répondent en parallèle et aucune mémoire n'est partagée entre elles. Les
 * compteurs (limites de tentatives) passent alors en base, et le flux SSE est
 * remplacé par une interrogation régulière. Voir README, « Déploiement Vercel ».
 */
const isVercel = () => process.env.VERCEL === '1';

/*
 * Moteur d'affiliation interne (codes HAI-XXXXXXXX, conversions, gains,
 * webhook signé). GELÉ par défaut : aucun annonceur réel n'y est branché et le
 * format de postback attendu (X-Haissel-Signature) est propre à HAISSEL,
 * qu'aucun réseau d'affiliation n'émet. Voir README, « Moteur d'affiliation
 * interne (gelé) ».
 *
 * Les redirections /r/:code restent actives quelle que soit cette valeur :
 * des liens ont pu être partagés et ne doivent pas se mettre à renvoyer 404.
 */
const isInternalAffiliationEnabled = () => process.env.ENABLE_INTERNAL_AFFILIATION === 'true';

function getMasterSecret() {
  return process.env.APP_SECRET || process.env.JWT_SECRET || '';
}

function deriveKey(label, length = 32) {
  const secret = getMasterSecret();
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('APP_SECRET must be configured with at least 32 bytes.');
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'haissel', `haissel:${label}`, length));
}

function getMfaKey() {
  const explicit = process.env.MFA_ENCRYPTION_KEY || '';
  if (explicit) {
    return crypto.createHash('sha256').update(explicit).digest();
  }
  return deriveKey('mfa-encryption');
}

/** Transport e-mail : none | smtp | console (développement) | memory (tests). */
function getMailTransport() {
  const value = String(process.env.MAIL_TRANSPORT || 'none').toLowerCase();
  return ['none', 'smtp', 'console', 'memory'].includes(value) ? value : 'none';
}

function isMailEnabled() {
  return getMailTransport() !== 'none';
}

/** La vérification d'e-mail est exigée dès qu'un moyen d'envoi existe. */
function isEmailVerificationRequired() {
  if (process.env.EMAIL_VERIFICATION === 'off') return false;
  return isMailEnabled();
}

function isAdminMfaRequired() {
  // En ligne (Vercel), l'administration n'est protégée que par le mot de
  // passe et la double authentification : celle-ci n'est pas désactivable.
  if (isVercel()) return true;
  return process.env.ADMIN_REQUIRE_MFA !== 'false';
}

/**
 * Cookie de session :
 *  - en HTTPS : « __Host-haissel_sid » + Secure (le préfixe interdit Domain
 *    et impose Path=/ et Secure côté navigateur) ;
 *  - en HTTP (réseau local, développement) : « haissel_sid » sans Secure.
 *    Ce mode n'offre PAS les garanties de HTTPS (cookie lisible sur le réseau).
 * COOKIE_SECURE = auto (défaut, selon la requête) | true | false.
 */
const SESSION_COOKIE_SECURE = '__Host-haissel_sid';
const SESSION_COOKIE_PLAIN = 'haissel_sid';

function isSecureRequest(req) {
  const mode = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return Boolean(req.secure);
}

const SESSION_POLICY = {
  user: { absoluteSeconds: 7 * 24 * 3600, idleSeconds: 24 * 3600 },
  admin: { absoluteSeconds: 8 * 3600, idleSeconds: 30 * 60 },
  mfaPending: { absoluteSeconds: 10 * 60, idleSeconds: 10 * 60 },
};

/*
 * Clés de test officielles de Cloudflare Turnstile (« 1x0000…AA »,
 * « 2x0000…AA »…) : elles valident ou refusent tout jeton, sans protection.
 * - Vercel, VERCEL_ENV=preview : autorisées, pour tester les Previews sans
 *   domaine déclaré chez Cloudflare ;
 * - Vercel, VERCEL_ENV=production : interdites ;
 * - hors Vercel (ou autre VERCEL_ENV) : interdites si NODE_ENV=production.
 */
const TURNSTILE_TEST_KEY = /^[123]x0{20,}[A-Z]{2}$/;

function areTurnstileTestKeysAllowed() {
  if (process.env.VERCEL_ENV === 'production') return false;
  if (process.env.VERCEL_ENV === 'preview') return true;
  return !isProduction();
}

/**
 * Validation au démarrage : échoue de façon sûre si un secret critique
 * manque ou garde une valeur d'exemple en production. Ne révèle aucune valeur.
 */
function validateSecurityConfig() {
  const errors = [];
  const warnings = [];
  const secret = getMasterSecret();

  if (Buffer.byteLength(secret, 'utf8') < 32) {
    errors.push('APP_SECRET doit contenir au moins 32 octets aléatoires.');
  } else if (isProduction() && PLACEHOLDER.test(secret)) {
    errors.push("APP_SECRET utilise une valeur d'exemple : générez une valeur aléatoire.");
  }

  const transport = getMailTransport();
  if (transport === 'memory' && !isTest()) errors.push('MAIL_TRANSPORT=memory est réservé aux tests.');
  if (transport === 'console' && isProduction()) {
    errors.push('MAIL_TRANSPORT=console est interdit en production (les liens secrets apparaîtraient dans les journaux).');
  }
  if (transport === 'smtp' && (!process.env.SMTP_HOST || !process.env.MAIL_FROM)) {
    errors.push('MAIL_TRANSPORT=smtp exige SMTP_HOST et MAIL_FROM.');
  }
  if (transport === 'none') {
    warnings.push("Aucun envoi d'e-mail configuré : vérification d'adresse et « mot de passe oublié » désactivés.");
  }

  const turnstileSite = String(process.env.TURNSTILE_SITE_KEY || '').trim();
  const turnstileSecret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (Boolean(turnstileSite) !== Boolean(turnstileSecret)) {
    errors.push('TURNSTILE_SITE_KEY et TURNSTILE_SECRET_KEY doivent être définies ensemble.');
  } else if (!turnstileSite) {
    warnings.push('Cloudflare Turnstile non configuré : connexion et inscription sans vérification anti-robot.');
  } else if (!areTurnstileTestKeysAllowed() && [turnstileSite, turnstileSecret].some((key) => TURNSTILE_TEST_KEY.test(key))) {
    errors.push('Clés Turnstile de test interdites en production : utilisez les clés du tableau de bord Cloudflare.');
  }

  if (process.env.MFA_ENCRYPTION_KEY &&Buffer.byteLength(process.env.MFA_ENCRYPTION_KEY) < 32) {
    errors.push('MFA_ENCRYPTION_KEY doit contenir au moins 32 octets.');
  }
  if (isVercel() && !String(process.env.ADMIN_IP_ALLOWLIST || '').trim()) {
    warnings.push("ADMIN_IP_ALLOWLIST est vide : la console d'administration est joignable depuis n'importe quelle adresse IP. "
      + 'Seuls le mot de passe et la double authentification la protègent. Renseignez vos adresses IP dans le tableau de bord Vercel.');
  }
  if (isProduction() && String(process.env.COOKIE_SECURE || 'auto') !== 'true') {
    warnings.push('Site servi sans HTTPS imposé : le cookie de session circule en clair sur le réseau. Activez HTTPS (voir README).');
  }

  return { errors, warnings };
}

module.exports = {
  isProduction,
  areTurnstileTestKeysAllowed,
  isTest,
  isVercel,
  isInternalAffiliationEnabled,
  getMasterSecret,
  deriveKey,
  getMfaKey,
  getMailTransport,
  isMailEnabled,
  isEmailVerificationRequired,
  isAdminMfaRequired,
  isSecureRequest,
  SESSION_COOKIE_SECURE,
  SESSION_COOKIE_PLAIN,
  SESSION_POLICY,
  validateSecurityConfig,
};
