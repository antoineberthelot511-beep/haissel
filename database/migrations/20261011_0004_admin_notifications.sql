-- Migration : centre de notifications administrateur (temps réel, SSE)
--   - notification_broadcasts : une ligne par diffusion (émetteur, contenu,
--     statistiques réelles de distribution)
--   - notification_recipients : une ligne par destinataire UNIQUE d'une
--     diffusion (distribuée / affichée). Aucune adresse IP n'est stockée ;
--     les connexions au flux ne sont pas journalisées.
--
-- Non destructive et réexécutable. La table historique « notifications »
-- (ancienne API sociale) n'est pas modifiée.

CREATE TABLE IF NOT EXISTS notification_broadcasts (
  id SERIAL PRIMARY KEY,
  public_id UUID NOT NULL UNIQUE,
  admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(80) NOT NULL,
  message VARCHAR(500) NOT NULL,
  target_url VARCHAR(200),
  target VARCHAR(30) NOT NULL DEFAULT 'connected_users',
  connected_users INTEGER NOT NULL DEFAULT 0,
  delivered_users INTEGER NOT NULL DEFAULT 0,
  delivered_connections INTEGER NOT NULL DEFAULT 0,
  failed_connections INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT notification_broadcasts_status_check
    CHECK (status IN ('pending', 'delivered', 'partial', 'no_recipients', 'failed')),
  CONSTRAINT notification_broadcasts_target_check
    CHECK (target IN ('connected_users'))
);

CREATE INDEX IF NOT EXISTS idx_notification_broadcasts_created_at
  ON notification_broadcasts (created_at DESC);

CREATE TABLE IF NOT EXISTS notification_recipients (
  broadcast_id INTEGER NOT NULL REFERENCES notification_broadcasts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  displayed_at TIMESTAMPTZ,
  display_mode VARCHAR(10),
  PRIMARY KEY (broadcast_id, user_id),
  CONSTRAINT notification_recipients_mode_check
    CHECK (display_mode IS NULL OR display_mode IN ('system', 'in_app'))
);

CREATE INDEX IF NOT EXISTS idx_notification_recipients_user_id
  ON notification_recipients (user_id);
