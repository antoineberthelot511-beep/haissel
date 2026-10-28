const crypto = require('crypto');

/*
 * Détermination de l'origine réseau d'une requête.
 *
 * Mode direct (npm start) : seule l'adresse du socket TCP fait foi.
 * Les en-têtes X-Forwarded-For / X-Real-IP sont IGNORÉS, car n'importe quel
 * client peut les forger.
 *
 * Mode reverse proxy (Docker + Nginx) : Nginx ajoute l'en-tête
 * X-Haissel-Proxy-Secret (valeur de PROXY_SHARED_SECRET, jamais exposée aux
 * clients) ainsi que X-Real-IP. Seules les requêtes portant ce secret sont
 * considérées comme relayées par le proxy. Le bloc Nginx réservé à
 * l'administration (publié uniquement sur 127.0.0.1) ajoute en plus
 * X-Haissel-Admin-Gate: 1.
 */

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isTrustedProxyRequest(req) {
  const secret = process.env.PROXY_SHARED_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) return false;
  const provided = req.get('x-haissel-proxy-secret');
  return typeof provided === 'string' && safeEqual(provided, secret);
}

function normalizeIp(ip) {
  const value = String(ip || '').trim();
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value;
}

/*
 * Vercel : x-vercel-forwarded-for est posé par l'infrastructure de Vercel
 * (un client ne peut pas l'imposer), contrairement à X-Forwarded-For, que
 * n'importe qui peut forger. Ordre : x-vercel-forwarded-for (premier
 * élément), puis x-real-ip, puis req.ip.
 */
function vercelClientIp(req) {
  const vercel = String(req.get('x-vercel-forwarded-for') || '').split(',')[0].trim();
  if (vercel) return vercel;
  const real = String(req.get('x-real-ip') || '').trim();
  if (real) return real;
  return req.ip || req.socket?.remoteAddress;
}

function getClientIp(req) {
  if (process.env.VERCEL === '1') return normalizeIp(vercelClientIp(req));
  if (isTrustedProxyRequest(req)) {
    const forwarded = req.get('x-real-ip');
    if (forwarded) return normalizeIp(forwarded);
  }
  return normalizeIp(req.socket?.remoteAddress);
}

/**
 * Vrai uniquement si la requête provient de la machine serveur elle-même.
 */
function isLocalRequest(req) {
  // Vercel : aucune requête n'est « locale », même si la fonction reçoit la
  // connexion depuis 127.0.0.1 (pont interne du runtime).
  if (process.env.VERCEL === '1') return false;
  if (isTrustedProxyRequest(req)) {
    return req.get('x-haissel-admin-gate') === '1';
  }
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress);
}

/**
 * Accès aux comptes et pages d'administration.
 *  - Serveur local / Docker : uniquement depuis la machine serveur (inchangé).
 *  - Vercel : accessible en ligne ; la protection repose sur le rôle ADMIN et
 *    la double authentification obligatoire (voir security.js). Option :
 *    ADMIN_IP_ALLOWLIST (IP séparées par des virgules) restreint en plus
 *    l'accès à ces adresses.
 */
function isAdminAccessAllowed(req) {
  if (process.env.VERCEL !== '1') return isLocalRequest(req);
  const allowlist = (process.env.ADMIN_IP_ALLOWLIST || '')
    .split(',')
    .map((ip) => normalizeIp(ip))
    .filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(getClientIp(req));
}

/**
 * IP tronquée pour le stockage (minimisation des données) :
 * IPv4 -> /24, IPv6 -> /48.
 */
function anonymizeIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.replace(/\.\d{1,3}$/, '.0');
  }
  if (value === '::1') return value;
  if (value.includes(':')) {
    return `${value.split(':').slice(0, 3).join(':')}::`;
  }
  return null;
}

/**
 * Empreinte non réversible de l'IP complète (HMAC avec JWT_SECRET) : sert
 * uniquement à dédoublonner les clics sans stocker l'adresse en clair.
 */
function hashIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return null;
  return crypto
    .createHmac('sha256', require('../config/security').deriveKey('ip-hash'))
    .update(value)
    .digest('hex');
}

module.exports = {
  getClientIp,
  isLocalRequest,
  isAdminAccessAllowed,
  isTrustedProxyRequest,
  anonymizeIp,
  hashIp,
  safeEqual,
};
