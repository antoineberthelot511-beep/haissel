-- Migration : formulaire de contact et case d'âge de l'inscription
--
-- users.age_terms_accepted_at : date et heure à laquelle le membre a coché
-- « J'ai 15 ans ou plus, ou j'ai l'accord d'un parent pour m'inscrire. »
-- NULL pour les comptes créés avant la case (aucune valeur inventée).
--
-- contact_requests : demandes envoyées depuis /contact, avec ou sans compte.
-- user_id passe à NULL si le compte est supprimé ; les demandes sont effacées
-- 12 mois après leur envoi (retention.service.js).
--
-- Non destructive et réexécutable : rien n'est supprimé ni modifié.

ALTER TABLE users ADD COLUMN IF NOT EXISTS age_terms_accepted_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS contact_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
  subject VARCHAR(20) NOT NULL CHECK (subject IN ('question', 'report', 'privacy', 'other')),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 20 AND 2000),
  reply_email VARCHAR(254) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_requests_created ON contact_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_requests_user ON contact_requests (user_id, created_at);
