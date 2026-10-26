-- Migration : abonnements Web Push (un par appareil)
--
-- endpoint : adresse du service de notification du navigateur (liste blanche
-- côté serveur) ; p256dh et auth : clés publiques de chiffrement du contenu.
-- Aucune donnée de message n'est stockée ici. Suppression automatique à la
-- désinscription, à l'expiration (404/410), après 5 échecs et avec le compte.
--
-- Non destructive et réexécutable.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
