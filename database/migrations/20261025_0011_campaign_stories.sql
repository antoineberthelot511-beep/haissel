-- Migration : fiches campagne au format « story » (visibles 24 h)
--
-- expires_at : fin de visibilité d'une fiche campagne publiée. NULL pour les
--   offres des ADMIN (kind = 'affiliate'), qui restent visibles sans limite.
-- renewed_at : dernière republication par l'auteur (délai de 20 h entre deux).
--
-- REPRISE DE L'EXISTANT : les fiches campagne déjà publiées reçoivent
-- NOW() + 24 h, pour que rien ne disparaisse d'un coup au déploiement. Cette
-- reprise ne s'exécute qu'une fois, à l'ajout de la colonne.
--
-- Non destructive et réexécutable : aucune ligne n'est supprimée.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'member_offers' AND column_name = 'expires_at'
  ) THEN
    ALTER TABLE member_offers ADD COLUMN expires_at TIMESTAMPTZ;
    UPDATE member_offers SET expires_at = NOW() + INTERVAL '24 hours'
    WHERE kind = 'campaign' AND status = 'published';
  END IF;
END $$;

ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS renewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_member_offers_status_expires ON member_offers (status, expires_at);
