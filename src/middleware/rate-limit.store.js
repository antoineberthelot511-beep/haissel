const { pool } = require('../config/database');
const { logger } = require('../utils/logger');

/*
 * Store express-rate-limit adossé à PostgreSQL (table rate_limit_counters).
 *
 * Raison d'être : sur Vercel, plusieurs instances répondent en parallèle sans
 * mémoire partagée. Un compteur en mémoire ne voit qu'une partie des requêtes,
 * et la limite effective devient « limite × nombre d'instances ». La base est
 * le seul état commun à toutes les instances.
 *
 * Fenêtre fixe, comme le store mémoire d'express-rate-limit : la première
 * requête d'une clé fixe expires_at, les suivantes incrémentent jusqu'à
 * l'échéance, puis le compteur repart de 1.
 *
 * TOLÉRANCE AUX PANNES : si la base est injoignable, le store laisse passer la
 * requête (fail open) au lieu de renvoyer une erreur 500. generalRateLimiter
 * est monté sur TOUTES les routes, y compris les pages statiques qui
 * fonctionnent sans base : une coupure PostgreSQL ne doit pas rendre le site
 * entièrement indisponible. La limite est une protection contre l'abus, pas
 * un contrôle d'accès — les routes sensibles vérifient la session en base,
 * donc elles échouent de toute façon si la base est absente.
 */

class PostgresRateLimitStore {
  /** @param {string} name identifiant du limiteur (les clés ne doivent pas se mélanger) */
  constructor(name) {
    /*
     * « prefix » est lu par express-rate-limit, pas seulement par nous : sa
     * détection de double comptage identifie un store partagé par le nom de
     * classe, donc toutes les instances se ressemblent et c'est le préfixe qui
     * les distingue. Sans ce champ, une route portant deux limiteurs
     * (/api/auth/login : limite générale + limite d'authentification) lèverait
     * ERR_ERL_DOUBLE_COUNT alors que les deux compteurs sont bien distincts.
     */
    this.prefix = `${name}:`;
    this.windowMs = 60_000;
    // false : les compteurs sont en base, donc partagés entre les instances.
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  fullKey(key) {
    return `${this.prefix}${key}`;
  }

  /** Secours quand la base ne répond pas : une seule requête comptée. */
  failOpen(method, error) {
    logger.warn(`Rate limit store unavailable (${method}), request allowed`, { error: error.message });
    return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
  }

  async increment(key) {
    const seconds = this.windowMs / 1000;
    try {
      const { rows } = await pool.query(
        `
          INSERT INTO rate_limit_counters (key, hits, expires_at)
          VALUES ($1, 1, NOW() + make_interval(secs => $2))
          ON CONFLICT (key) DO UPDATE SET
            hits = CASE WHEN rate_limit_counters.expires_at <= NOW()
                        THEN 1 ELSE rate_limit_counters.hits + 1 END,
            expires_at = CASE WHEN rate_limit_counters.expires_at <= NOW()
                              THEN NOW() + make_interval(secs => $2)
                              ELSE rate_limit_counters.expires_at END
          RETURNING hits, expires_at
        `,
        [this.fullKey(key), seconds]
      );
      return { totalHits: rows[0].hits, resetTime: rows[0].expires_at };
    } catch (error) {
      return this.failOpen('increment', error);
    }
  }

  /** skipSuccessfulRequests : la requête réussie ne doit pas être comptée. */
  async decrement(key) {
    try {
      await pool.query(
        `UPDATE rate_limit_counters SET hits = GREATEST(hits - 1, 0)
         WHERE key = $1 AND expires_at > NOW()`,
        [this.fullKey(key)]
      );
    } catch (error) {
      logger.warn('Rate limit store unavailable (decrement)', { error: error.message });
    }
  }

  async resetKey(key) {
    try {
      await pool.query('DELETE FROM rate_limit_counters WHERE key = $1', [this.fullKey(key)]);
    } catch (error) {
      logger.warn('Rate limit store unavailable (resetKey)', { error: error.message });
    }
  }

  async get(key) {
    try {
      const { rows } = await pool.query(
        `SELECT hits, expires_at FROM rate_limit_counters
         WHERE key = $1 AND expires_at > NOW()`,
        [this.fullKey(key)]
      );
      if (rows.length === 0) return undefined;
      return { totalHits: rows[0].hits, resetTime: rows[0].expires_at };
    } catch (error) {
      return undefined;
    }
  }

  async resetAll() {
    try {
      await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`${this.prefix}%`]);
    } catch (error) {
      logger.warn('Rate limit store unavailable (resetAll)', { error: error.message });
    }
  }
}

module.exports = { PostgresRateLimitStore };
