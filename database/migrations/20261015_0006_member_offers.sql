-- Migration : offres publiées par les membres (communauté)
--   - member_offers        : offres proposées par les membres, modérées
--   - member_offer_saves   : offres enregistrées par un membre
--   - member_offer_reports : signalements (un par membre et par offre)
--
-- Cycle : pending (en attente de modération) -> published | rejected ;
-- published -> removed (retrait par l'auteur ou un admin) ; une offre
-- publiée qui reçoit trop de signalements repasse en pending.
-- Aucune donnée MyLead (identifiant, mot de passe, cookie) n'est stockée.
--
-- Non destructive et réexécutable.

CREATE TABLE IF NOT EXISTS member_offers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  url TEXT NOT NULL,
  description VARCHAR(1500) NOT NULL,
  category VARCHAR(30) NOT NULL,
  countries VARCHAR(200) NOT NULL,
  expected_action VARCHAR(300) NOT NULL,
  payout_text VARCHAR(160),
  min_age SMALLINT,
  conditions VARCHAR(2000),
  rights_confirmed_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  moderation_note VARCHAR(300),
  moderated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderated_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT member_offers_status_check CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
  CONSTRAINT member_offers_min_age_check CHECK (min_age IS NULL OR min_age BETWEEN 10 AND 99),
  CONSTRAINT member_offers_https_check CHECK (url LIKE 'https://%')
);

CREATE INDEX IF NOT EXISTS idx_member_offers_status_published
  ON member_offers (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_offers_user ON member_offers (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS member_offer_saves (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_id INTEGER NOT NULL REFERENCES member_offers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, offer_id)
);

CREATE TABLE IF NOT EXISTS member_offer_reports (
  id SERIAL PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES member_offers(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(30) NOT NULL,
  details VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT member_offer_reports_reason_check
    CHECK (reason IN ('misleading', 'spam', 'dangerous', 'minors', 'rights', 'other')),
  CONSTRAINT member_offer_reports_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT member_offer_reports_unique UNIQUE (offer_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_member_offer_reports_open
  ON member_offer_reports (status, offer_id);
