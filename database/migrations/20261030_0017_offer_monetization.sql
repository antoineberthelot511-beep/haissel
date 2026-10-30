-- Migration : monétisation des liens de l'équipe (offres « affiliate »)
--
-- member_offers (offres ADMIN) : nouveaux champs. L'âge minimum réutilise
-- la colonne min_age existante (13, 15, 16 ou 18 pour une offre de l'équipe).
--   - incentive_allowed  : trafic incité autorisé par la campagne (case cochée par l'admin) ;
--   - member_benefit     : ce que l'ANNONCEUR donne au membre (texte court, visible) ;
--   - payout_note        : rémunération de HAISSEL (visible admin uniquement) ;
--   - campaign_rules_url : page des règles de la campagne (admin) ;
--   - subid_param        : paramètre de sous-identifiant de l'URL (ex. ml_sub1).
--
-- offer_clicks : clics suivis sur les liens de l'équipe. Jamais l'identifiant
-- ni l'e-mail du membre : un identifiant opaque (HMAC du couple membre +
-- offre) et l'IP hachée, comme pour les autres clics.
--
-- offer_conversions : conversions reçues du réseau (webhook), reliées au clic
-- par le sous-identifiant ; en attente / validée / refusée ; « à vérifier »
-- quand plusieurs conversions de la même offre viennent du même membre ou de
-- la même IP. Rien n'est versé aux membres.
--
-- Non destructive et réexécutable.

ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS incentive_allowed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS member_benefit VARCHAR(160);
ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS payout_note VARCHAR(300);
ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS campaign_rules_url TEXT;
ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS subid_param VARCHAR(40);

CREATE TABLE IF NOT EXISTS offer_clicks (
  id SERIAL PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES member_offers(id) ON DELETE CASCADE,
  subid CHAR(32) NOT NULL,
  ip_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_offer_clicks_subid ON offer_clicks (subid, created_at);
CREATE INDEX IF NOT EXISTS idx_offer_clicks_offer ON offer_clicks (offer_id, created_at);

CREATE TABLE IF NOT EXISTS offer_conversions (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(40) NOT NULL,
  external_reference VARCHAR(255) NOT NULL,
  offer_id INTEGER REFERENCES member_offers(id) ON DELETE SET NULL,
  click_id INTEGER REFERENCES offer_clicks(id) ON DELETE SET NULL,
  subid CHAR(32) NOT NULL,
  ip_hash CHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  needs_review BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT offer_conversions_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT offer_conversions_reference_unique UNIQUE (provider, external_reference)
);
CREATE INDEX IF NOT EXISTS idx_offer_conversions_offer ON offer_conversions (offer_id, created_at);
