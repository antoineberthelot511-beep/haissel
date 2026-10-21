/*
 * Ralentissement progressif par identifiant (e-mail / pseudo normalisé).
 *
 * Complète la limite par IP : un attaquant qui change d'adresse IP reste
 * ralenti sur un même compte. Pas de verrouillage : une victime ne peut pas
 * être bloquée durablement par des tentatives malveillantes, elle subit au
 * pire quelques secondes d'attente.
 *
 * Après 3 échecs : 0,5 s, 1 s, 2 s, 4 s… plafonné à 8 s ; remise à zéro après
 * une connexion réussie ou 15 min sans échec.
 *
 * DEUX STOCKAGES, même API (asynchrone dans les deux cas) :
 *  - mémoire du processus par défaut (npm start, Docker, tests) ;
 *  - table login_throttle_failures sur Vercel, où plusieurs instances
 *    répondent en parallèle sans mémoire partagée : chacune ne verrait qu'une
 *    partie des échecs et le ralentissement serait divisé par le nombre
 *    d'instances.
 */

const { pool } = require('../config/database');
const { isVercel } = require('../config/security');
const { logger } = require('../utils/logger');

const WINDOW_MS = 15 * 60 * 1000;
const FREE_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const MAX_ENTRIES = 10000;

/** Délai d'attente pour un nombre d'échecs donné (commun aux deux stockages). */
function delayForCount(count) {
  if (count < FREE_ATTEMPTS) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (count - FREE_ATTEMPTS), MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Stockage en mémoire (un seul processus)
// ---------------------------------------------------------------------------

const failures = new Map();

function entryFor(key) {
  const entry = failures.get(key);
  if (entry && Date.now() - entry.last > WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return entry || null;
}

const memoryStore = {
  async failureCount(key) {
    return entryFor(key)?.count || 0;
  },
  async recordFailure(key) {
    if (failures.size >= MAX_ENTRIES) {
      // Purge des entrées les plus anciennes : la mémoire reste bornée.
      for (const oldKey of [...failures.keys()].slice(0, MAX_ENTRIES / 10)) failures.delete(oldKey);
    }
    const entry = entryFor(key) || { count: 0, last: 0 };
    entry.count += 1;
    entry.last = Date.now();
    failures.set(key, entry);
  },
  async recordSuccess(key) {
    failures.delete(key);
  },
  async reset() {
    failures.clear();
  },
};

// ---------------------------------------------------------------------------
// Stockage PostgreSQL (plusieurs instances)
// ---------------------------------------------------------------------------

/*
 * TOLÉRANCE AUX PANNES : si la base ne répond pas, aucun délai n'est appliqué
 * et l'échec n'est pas compté. Ce n'est pas une faille exploitable : la
 * connexion elle-même lit les comptes en base, donc elle échoue aussi. Mieux
 * vaut cela qu'une erreur 500 masquant la vraie cause.
 */
const postgresStore = {
  async failureCount(key) {
    try {
      const { rows } = await pool.query(
        `SELECT count FROM login_throttle_failures
         WHERE key = $1 AND last_failure_at > NOW() - make_interval(secs => $2)`,
        [key, WINDOW_MS / 1000]
      );
      return rows.length ? rows[0].count : 0;
    } catch (error) {
      logger.warn('Login throttle store unavailable (failureCount)', { error: error.message });
      return 0;
    }
  },

  async recordFailure(key) {
    try {
      // Une fenêtre écoulée repart de 1 : pas de cumul entre deux périodes.
      await pool.query(
        `
          INSERT INTO login_throttle_failures (key, count, last_failure_at)
          VALUES ($1, 1, NOW())
          ON CONFLICT (key) DO UPDATE SET
            count = CASE
              WHEN login_throttle_failures.last_failure_at <= NOW() - make_interval(secs => $2)
              THEN 1 ELSE login_throttle_failures.count + 1 END,
            last_failure_at = NOW()
        `,
        [key, WINDOW_MS / 1000]
      );
    } catch (error) {
      logger.warn('Login throttle store unavailable (recordFailure)', { error: error.message });
    }
  },

  async recordSuccess(key) {
    try {
      await pool.query('DELETE FROM login_throttle_failures WHERE key = $1', [key]);
    } catch (error) {
      logger.warn('Login throttle store unavailable (recordSuccess)', { error: error.message });
    }
  },

  async reset() {
    try {
      await pool.query('DELETE FROM login_throttle_failures');
    } catch (error) {
      logger.warn('Login throttle store unavailable (reset)', { error: error.message });
    }
  },
};

// Choisi à chaque appel : VERCEL peut être défini après le chargement du
// module (tests, scripts).
const store = () => (isVercel() ? postgresStore : memoryStore);

async function delayFor(key) {
  return delayForCount(await store().failureCount(key));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  delayFor,
  recordFailure: (key) => store().recordFailure(key),
  recordSuccess: (key) => store().recordSuccess(key),
  failureCount: (key) => store().failureCount(key),
  sleep,
  reset: () => store().reset(),
  WINDOW_MS,
  FREE_ATTEMPTS,
};
