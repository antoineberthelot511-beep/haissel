-- Migration : tuto d'installation de l'application vu
--
-- install_tuto_seen_at : date à laquelle le membre a fermé la feuille
-- d'installation (ouverte automatiquement après sa première connexion).
-- NULL = jamais vue : elle s'ouvrira à la prochaine connexion, sur l'appareil
-- où elle est utile. Mémorisé sur le compte, pas sur l'appareil.
--
-- Comptes existants : marqués « vu » à l'ajout de la colonne, pour que la
-- feuille ne s'ouvre jamais d'elle-même à la mise en production.
--
-- Non destructive et réexécutable : la colonne n'est ajoutée, et les comptes
-- existants marqués, qu'une seule fois (si la colonne n'existe pas encore).
-- Aucune donnée supprimée ou modifiée ensuite.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'install_tuto_seen_at'
  ) THEN
    ALTER TABLE users ADD COLUMN install_tuto_seen_at TIMESTAMPTZ NULL;
    UPDATE users SET install_tuto_seen_at = NOW();
  END IF;
END
$$;
