-- Migration : déclaration de majorité
--
-- MyLead exige 18 ans pour ouvrir un compte éditeur. HAISSEL demande donc à
-- chaque membre s'il a 18 ans ou plus, et réserve aux majeurs ce qui mène à
-- un compte éditeur ou à un lien affilié.
--
-- MINIMISATION DES DONNÉES (RGPD art. 5-1-c) : on n'enregistre PAS la date de
-- naissance, ni l'âge. Seulement la réponse à une question fermée, et la date
-- à laquelle elle a été donnée — ce qui suffit à appliquer la règle et à
-- prouver qu'elle a été posée.
--
--   is_adult = NULL   la question n'a pas encore été posée (comptes créés
--                     avant cette migration) : elle le sera à la prochaine
--                     connexion ;
--   is_adult = false  le membre a déclaré avoir moins de 18 ans ;
--   is_adult = true   le membre a déclaré avoir 18 ans ou plus.
--
-- C'est une déclaration sur l'honneur, pas une vérification d'identité : elle
-- pose une limite claire, elle ne la prouve pas.
--
-- Non destructive et réexécutable : deux colonnes ajoutées, aucune donnée
-- existante modifiée, aucune contrainte NOT NULL (les comptes existants
-- restent valides avec is_adult à NULL).

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_adult BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS adult_declared_at TIMESTAMPTZ;

-- Cohérence : la date accompagne toujours une réponse, et inversement.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_adult_declaration_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_adult_declaration_check
      CHECK ((is_adult IS NULL AND adult_declared_at IS NULL)
          OR (is_adult IS NOT NULL AND adult_declared_at IS NOT NULL));
  END IF;
END $$;

-- Retrouver rapidement les comptes qui doivent encore répondre.
CREATE INDEX IF NOT EXISTS idx_users_adult_undeclared
  ON users (id) WHERE is_adult IS NULL;
