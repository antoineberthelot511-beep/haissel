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
 * Stockage en mémoire : valable pour UN processus Node. Avec plusieurs
 * instances, il faudrait un stockage partagé (Redis, PostgreSQL).
 */

const WINDOW_MS = 15 * 60 * 1000;
const FREE_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const MAX_ENTRIES = 10000;

const failures = new Map();

function entryFor(key) {
  const entry = failures.get(key);
  if (entry && Date.now() - entry.last > WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return entry || null;
}

function delayFor(key) {
  const entry = entryFor(key);
  if (!entry || entry.count < FREE_ATTEMPTS) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (entry.count - FREE_ATTEMPTS), MAX_DELAY_MS);
}

function recordFailure(key) {
  if (failures.size >= MAX_ENTRIES) {
    // Purge des entrées les plus anciennes : la mémoire reste bornée.
    for (const oldKey of [...failures.keys()].slice(0, MAX_ENTRIES / 10)) failures.delete(oldKey);
  }
  const entry = entryFor(key) || { count: 0, last: 0 };
  entry.count += 1;
  entry.last = Date.now();
  failures.set(key, entry);
}

function recordSuccess(key) {
  failures.delete(key);
}

function failureCount(key) {
  return entryFor(key)?.count || 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  delayFor,
  recordFailure,
  recordSuccess,
  failureCount,
  sleep,
  reset: () => failures.clear(),
};
