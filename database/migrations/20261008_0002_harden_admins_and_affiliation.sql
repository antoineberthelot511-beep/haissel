-- Migration corrective : rôles admin, intégrité de l'affiliation, idempotence
-- des conversions, journal des actions admin.
--
-- Exécutée dans une transaction par scripts/migrate.js.
-- Idempotente : peut être rejouée sans effet de bord.
-- Les contraintes CHECK sont ajoutées en NOT VALID pour ne pas échouer sur
-- d'éventuelles lignes historiques ; elles s'appliquent à toutes les nouvelles
-- écritures.

-- ---------------------------------------------------------------------------
-- ADMINS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(30) NOT NULL DEFAULT 'ADMIN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE admins SET role = UPPER(role) WHERE role <> UPPER(role);
ALTER TABLE admins ALTER COLUMN role SET DEFAULT 'ADMIN';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_check') THEN
    ALTER TABLE admins ADD CONSTRAINT admins_role_check
      CHECK (role IN ('ADMIN', 'MODERATOR')) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SESSIONS
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- OFFRES
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'affiliate_links_url_check') THEN
    ALTER TABLE affiliate_links ADD CONSTRAINT affiliate_links_url_check
      CHECK (url ~* '^https?://') NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- CODES AFFILIÉS : un seul code par utilisateur et par offre
-- (l'ancienne contrainte UNIQUE (user_id, affiliate_link_id, code) ne
-- l'empêchait pas, la colonne code étant déjà unique).
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_affiliate_codes_user_link
  ON user_affiliate_codes(user_id, affiliate_link_id);

-- ---------------------------------------------------------------------------
-- CLICS
-- ---------------------------------------------------------------------------

ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ip_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(affiliate_link_id);
CREATE INDEX IF NOT EXISTS idx_clicks_code_dedup
  ON clicks(user_affiliate_code_id, ip_hash, created_at DESC);

-- ---------------------------------------------------------------------------
-- CONVERSIONS
-- ---------------------------------------------------------------------------

ALTER TABLE conversions ADD COLUMN IF NOT EXISTS provider VARCHAR(50);
ALTER TABLE conversions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Les conversions créées par l'ancien endpoint non sécurisé sont marquées.
UPDATE conversions SET provider = 'legacy' WHERE provider IS NULL;
ALTER TABLE conversions ALTER COLUMN provider SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversions_status_check') THEN
    ALTER TABLE conversions ADD CONSTRAINT conversions_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversions_amount_check') THEN
    ALTER TABLE conversions ADD CONSTRAINT conversions_amount_check
      CHECK (amount_cents >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversions_currency_check') THEN
    ALTER TABLE conversions ADD CONSTRAINT conversions_currency_check
      CHECK (currency ~ '^[A-Z]{3}$') NOT VALID;
  END IF;
END $$;

-- Idempotence : une conversion externe n'est enregistrée qu'une fois par
-- fournisseur (NULL external_reference reste autorisé pour l'historique).
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversions_provider_reference
  ON conversions(provider, external_reference);

CREATE INDEX IF NOT EXISTS idx_conversions_link_id ON conversions(affiliate_link_id);
CREATE INDEX IF NOT EXISTS idx_conversions_code_id ON conversions(user_affiliate_code_id);
CREATE INDEX IF NOT EXISTS idx_conversions_created_at ON conversions(created_at);

-- ---------------------------------------------------------------------------
-- GAINS
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'earnings_status_check') THEN
    ALTER TABLE earnings ADD CONSTRAINT earnings_status_check
      CHECK (status IN ('pending', 'paid', 'cancelled')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'earnings_amount_check') THEN
    ALTER TABLE earnings ADD CONSTRAINT earnings_amount_check
      CHECK (amount_cents >= 0) NOT VALID;
  END IF;
END $$;

-- Un seul gain par conversion : empêche tout double crédit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_earnings_conversion_id ON earnings(conversion_id);

-- ---------------------------------------------------------------------------
-- STATS : la table est conservée pour compatibilité mais n'est plus
-- alimentée ; les statistiques sont calculées depuis clicks / conversions /
-- earnings afin de ne jamais diverger des données sources.
-- ---------------------------------------------------------------------------

COMMENT ON TABLE stats IS 'Obsolète : statistiques calculées depuis clicks, conversions et earnings.';

-- ---------------------------------------------------------------------------
-- JOURNAL DES ACTIONS ADMIN
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(60) NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at ON admin_actions(created_at DESC);

-- Rollback (manuel, uniquement si aucune donnée ne dépend de ces objets) :
-- DROP TABLE IF EXISTS admin_actions;
-- DROP INDEX IF EXISTS uq_earnings_conversion_id, uq_conversions_provider_reference,
--   uq_user_affiliate_codes_user_link, idx_clicks_code_dedup, idx_clicks_link_id,
--   idx_conversions_link_id, idx_conversions_code_id, idx_conversions_created_at,
--   idx_sessions_expires_at;
