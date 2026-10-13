const argon2 = require('argon2');
const bcrypt = require('bcryptjs');

/*
 * Mots de passe : Argon2id.
 *
 * Paramètres = recommandation OWASP (Password Storage Cheat Sheet) :
 *   m = 19 MiB, t = 2, p = 1. Sel aléatoire propre à chaque hash, inclus
 *   dans la chaîne PHC stockée. Coût mesuré : voir README.
 *
 * Les anciens hash bcrypt restent acceptés puis sont remplacés par un hash
 * Argon2id à la connexion suivante réussie (migration progressive).
 *
 * Un sémaphore limite le nombre de calculs simultanés : chaque calcul
 * réserve ~19 Mio, une rafale de requêtes ne peut donc pas épuiser la RAM.
 */

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
const PASSWORD_MAX_BYTES = 512;
const MAX_CONCURRENT_HASHES = 4;

// Liste courte des mots de passe les plus utilisés (extraits des listes
// publiques de fuites). Complétée par des règles contextuelles ci-dessous.
const COMMON_PASSWORDS = new Set([
  '123456789012', '1234567890', '12345678910', '0123456789', '1111111111', '0000000000',
  'qwertyuiop', 'azertyuiop', 'motdepasse', 'motdepasse1', 'motdepasse123', 'password1',
  'password12', 'password123', 'password1234', 'passw0rd123', 'iloveyou12', 'iloveyou123',
  'jetaime123', 'soleil1234', 'football12', 'football123', 'princesse1', 'loveyou123',
  'abcdefghij', 'abc1234567', 'qwerty1234', 'qwerty12345', 'azerty1234', 'azerty12345',
  'administrator', 'admin12345', 'admin123456', 'welcome123', 'bienvenue1', 'bienvenue123',
  'superman12', 'dragon1234', 'monkey1234', 'letmein123', 'trustno123', 'starwars12',
  'pokemon123', 'marseille13', 'doudou1234', 'chouchou12', 'nicolas1234', 'camille123',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'zaq12wsxcde', 'q1w2e3r4t5', 'a1b2c3d4e5', 'haissel123',
  'haissel2026', 'haisselhaissel',
]);

let activeHashes = 0;
const waiting = [];

async function withHashSlot(fn) {
  if (activeHashes >= MAX_CONCURRENT_HASHES) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  activeHashes += 1;
  try {
    return await fn();
  } finally {
    activeHashes -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

/**
 * Politique : 10 à 128 caractères, phrases de passe bienvenues, aucune règle
 * arbitraire de composition (NIST SP 800-63B). Refus des mots de passe
 * courants, répétitifs ou dérivés du pseudo / de l'e-mail.
 * Retourne un message d'erreur ou null.
 */
function checkPasswordPolicy(password, { username = '', email = '' } = {}) {
  if (typeof password !== 'string') return 'Mot de passe invalide.';
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`;
  if (length > PASSWORD_MAX || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `Le mot de passe ne doit pas dépasser ${PASSWORD_MAX} caractères.`;
  }

  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Ce mot de passe est trop courant. Choisissez-en un autre.';
  if (/^(.)\1+$/.test(password)) return 'Ce mot de passe est trop simple.';
  if (/^(0123456789|1234567890|abcdefghijklmnopqrstuvwxyz)/.test(lower)) return 'Ce mot de passe est trop simple.';

  const local = String(email).split('@')[0].toLowerCase();
  for (const part of [String(username).toLowerCase(), local]) {
    if (part.length >= 4 && lower.includes(part)) {
      return 'Le mot de passe ne doit pas contenir votre pseudo ni votre adresse e-mail.';
    }
  }
  return null;
}

function hashPassword(password) {
  return withHashSlot(() => argon2.hash(password, ARGON2_OPTIONS));
}

/**
 * @returns {{ valid: boolean, needsRehash: boolean }}
 */
async function verifyPassword(storedHash, password) {
  if (typeof storedHash !== 'string' || typeof password !== 'string'
    || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return { valid: false, needsRehash: false };
  }

  if (storedHash.startsWith('$argon2')) {
    const valid = await withHashSlot(() => argon2.verify(storedHash, password).catch(() => false));
    return { valid, needsRehash: valid && argon2.needsRehash(storedHash, ARGON2_OPTIONS) };
  }

  if (/^\$2[aby]\$/.test(storedHash)) {
    // bcrypt ignore tout ce qui dépasse 72 octets : refus explicite.
    if (Buffer.byteLength(password, 'utf8') > 72) return { valid: false, needsRehash: false };
    const valid = await bcrypt.compare(password, storedHash);
    return { valid, needsRehash: valid };
  }

  return { valid: false, needsRehash: false };
}

// Hash factice : un identifiant inconnu coûte autant qu'un vrai compte
// (pas d'énumération des comptes par mesure du temps de réponse).
let dummyHashPromise;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('haissel-timing-protection-dummy');
  return dummyHashPromise;
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkPasswordPolicy,
  getDummyHash,
  ARGON2_OPTIONS,
  PASSWORD_MIN,
  PASSWORD_MAX,
};
