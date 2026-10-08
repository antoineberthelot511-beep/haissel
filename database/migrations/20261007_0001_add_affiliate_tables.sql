BEGIN;

CREATE TABLE IF NOT EXISTS affiliate_links (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_affiliate_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_link_id INTEGER NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
  code VARCHAR(80) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, affiliate_link_id, code)
);

CREATE TABLE IF NOT EXISTS clicks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  affiliate_link_id INTEGER NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
  user_affiliate_code_id INTEGER REFERENCES user_affiliate_codes(id) ON DELETE SET NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_link_id INTEGER NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
  user_affiliate_code_id INTEGER REFERENCES user_affiliate_codes(id) ON DELETE SET NULL,
  click_id INTEGER REFERENCES clicks(id) ON DELETE SET NULL,
  external_reference VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS earnings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_link_id INTEGER NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
  user_affiliate_code_id INTEGER REFERENCES user_affiliate_codes(id) ON DELETE SET NULL,
  conversion_id INTEGER REFERENCES conversions(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affiliate_link_id INTEGER REFERENCES affiliate_links(id) ON DELETE SET NULL,
  user_affiliate_code_id INTEGER REFERENCES user_affiliate_codes(id) ON DELETE SET NULL,
  total_clicks INTEGER NOT NULL DEFAULT 0,
  total_conversions INTEGER NOT NULL DEFAULT 0,
  total_amount_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, affiliate_link_id, user_affiliate_code_id)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_links_active ON affiliate_links(is_active);
CREATE INDEX IF NOT EXISTS idx_user_affiliate_codes_user_id ON user_affiliate_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_user_affiliate_codes_link_id ON user_affiliate_codes(affiliate_link_id);
CREATE INDEX IF NOT EXISTS idx_clicks_user_id ON clicks(user_id);
CREATE INDEX IF NOT EXISTS idx_clicks_code_id ON clicks(user_affiliate_code_id);
CREATE INDEX IF NOT EXISTS idx_clicks_created_at ON clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_conversions_user_id ON conversions(user_id);
CREATE INDEX IF NOT EXISTS idx_conversions_status ON conversions(status);
CREATE INDEX IF NOT EXISTS idx_earnings_user_id ON earnings(user_id);
CREATE INDEX IF NOT EXISTS idx_earnings_status ON earnings(status);
CREATE INDEX IF NOT EXISTS idx_stats_user_id ON stats(user_id);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS stats;
-- DROP TABLE IF EXISTS earnings;
-- DROP TABLE IF EXISTS conversions;
-- DROP TABLE IF EXISTS clicks;
-- DROP TABLE IF EXISTS user_affiliate_codes;
-- DROP TABLE IF EXISTS affiliate_links;
-- COMMIT;
