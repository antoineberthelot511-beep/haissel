-- Migration : profils privés par défaut (protection des mineurs)
--
-- profile_public : le membre a choisi « Profil visible par les membres »
-- dans Réglages. Faux par défaut, y compris pour les comptes existants : le
-- profil (ancienneté, statistiques, grille des fiches) n'est visible que par
-- le membre lui-même et par l'équipe. Les fiches publiées restent visibles
-- dans le fil, avec seulement le pseudo.
--
-- Non destructive et réexécutable.

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_public BOOLEAN NOT NULL DEFAULT false;
