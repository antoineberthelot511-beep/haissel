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

function getClientIp(req) {
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
  if (isTrustedProxyRequest(req)) {
    return req.get('x-haissel-admin-gate') === '1';
  }
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress);
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
    .createHmac('sha256', process.env.JWT_SECRET || 'haissel')
    .update(value)
    .digest('hex');
}

module.exports = {
  getClientIp,
  isLocalRequest,
  isTrustedProxyRequest,
  anonymizeIp,
  hashIp,
  safeEqual,
};
