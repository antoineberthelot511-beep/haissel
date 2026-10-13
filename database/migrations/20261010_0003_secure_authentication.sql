-- Migration : authentification renforcée
--   - sessions par cookie HttpOnly (identifiant opaque, hash en base),
--     expiration absolue + inactivité, jeton CSRF par session, étape MFA
--   - vérification d'adresse e-mail et réinitialisation du mot de passe
--   - double authentification TOTP + codes de récupération
--   - journal des événements de sécurité
--
-- Non destructive et réexécutable. Aucune donnée utilisateur supprimée.

-- ---------------------------------------------------------------------------
-- UTILISATEURS
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(60);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(60);

-- Les comptes créés AVANT l'existence de la vérification sont considérés
-- comme vérifiés (sinon ils seraient bloqués sans recours). Exécuté une seule
-- fois : les nouveaux comptes naissent avec email_verified_at = NULL.
UPDATE users SET email_verified_at = created_at
WHERE email_verified_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '20261010_0003_secure_authentication.sql');

-- Unicité insensible à la casse (les valeurs sont déjà normalisées en
-- minuscules par l'application ; ceci le garantit aussi au niveau SQL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_lower ON users (LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (LOWER(email));

-- Un pseudo ne peut pas contenir « @ », une adresse e-mail en contient
-- toujours un : la connexion « e-mail ou pseudo » n'est jamais ambiguë.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_no_at') THEN
    ALTER TABLE users ADD CONSTRAINT users_username_no_at CHECK (position('@' IN username) = 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_has_at') THEN
    ALTER TABLE users ADD CONSTRAINT users_email_has_at CHECK (position('@' IN email) > 1) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SESSIONS
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS idle_timeout_seconds INTEGER NOT NULL DEFAULT 86400;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token_hash VARCHAR(64);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(40);

-- Les anciennes sessions reposaient sur des JWT conservés dans localStorage :
-- elles sont révoquées (les utilisateurs se reconnectent une fois).
UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'auth_migration'
WHERE revoked_at IS NULL AND csrf_token_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_token_hash_active
  ON sessions (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- JETONS À USAGE UNIQUE (vérification d'e-mail, réinitialisation)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_purpose ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- CODES DE RÉCUPÉRATION MFA (stockés hachés, usage unique)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash VARCHAR(64) NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, code_hash)
);

-- ---------------------------------------------------------------------------
-- JOURNAL DE SÉCURITÉ (jamais de mot de passe, cookie, jeton ou secret)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event VARCHAR(50) NOT NULL,
  ip_address VARCHAR(45),
  user_agent VARCHAR(200),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events (user_id, created_at DESC);
