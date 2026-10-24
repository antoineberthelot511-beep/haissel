-- Migration : compteurs partagés pour les déploiements multi-instances (Vercel)
--
-- Sur Vercel, plusieurs instances de la fonction répondent en parallèle sans
-- mémoire partagée : un compteur gardé dans la mémoire d'un processus ne voit
-- qu'une fraction des requêtes, et la limite réelle devient le produit de la
-- limite par le nombre d'instances. Ces deux tables déplacent les compteurs
-- dans PostgreSQL, seul état partagé par toutes les instances.
--
--   - rate_limit_counters    : fenêtre fixe d'express-rate-limit (une ligne
--     par clé = limiteur + IP ou compte), remise à zéro à l'expiration ;
--   - login_throttle_failures : échecs de connexion par identifiant, pour le
--     ralentissement progressif (le délai dépend de la date du dernier échec,
--     d'où une colonne distincte de la fenêtre ci-dessus).
--
-- Aucune donnée personnelle : la clé est une IP tronquée par
-- express-rate-limit ou un identifiant normalisé, jamais un mot de passe.
-- Hors Vercel, ces tables restent vides (compteurs en mémoire).
--
-- Non destructive et réexécutable.

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Purge des fenêtres expirées (voir retention.service.js).
CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires_at
  ON rate_limit_counters (expires_at);

CREATE TABLE IF NOT EXISTS login_throttle_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_throttle_failures_last_failure_at
  ON login_throttle_failures (last_failure_at);
