const crypto = require('crypto');
const { getMfaKey } = require('../config/security');

/*
 * Double authentification TOTP (RFC 6238 : HMAC-SHA1, pas de 30 s, 6 chiffres),
 * compatible avec Google Authenticator, Microsoft Authenticator, Aegis, etc.
 *
 * - Secret de 20 octets aléatoires, chiffré au repos (AES-256-GCM).
 * - Tolérance d'un pas (± 30 s) ; anti-rejeu : un pas déjà utilisé est refusé.
 * - 10 codes de récupération aléatoires, à usage unique, stockés hachés.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Vérifie un code. Retourne le pas accepté (à mémoriser contre le rejeu)
 * ou null. lastStep = dernier pas déjà utilisé par ce compte.
 */
function verifyTotp(secretBase32, code, lastStep = null, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (const candidate of [step - 1, step, step + 1]) {
    if (lastStep !== null && candidate <= Number(lastStep)) continue;
    const expected = Buffer.from(hotp(secretBase32, candidate));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return candidate;
  }
  return null;
}

function otpauthUri(secretBase32, accountName) {
  const label = encodeURIComponent(`HAISSEL:${accountName}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=HAISSEL&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- Chiffrement du secret au repos ----

function encryptSecret(secretBase32) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMfaKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptSecret(payload) {
  const [version, iv, tag, data] = String(payload || '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid MFA secret payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMfaKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// ---- Codes de récupération ----

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

module.exports = {
  generateSecret,
  verifyTotp,
  hotp,
  currentStep,
  otpauthUri,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
};
