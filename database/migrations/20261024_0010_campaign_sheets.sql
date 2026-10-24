-- Migration : fiches campagne
--
-- Les membres partagent des FICHES CAMPAGNE (page officielle, conseils,
-- conditions), plus leurs liens affiliés. Seuls les ADMIN publient des liens
-- affiliés.
--
--   - member_offers.kind          : 'affiliate' (ADMIN) ou 'campaign' (membre),
--                                   fixé à la création selon le rôle de l'auteur
--   - member_offers.campaign_name : nom de la campagne MyLead
--   - member_offers.tips          : conseils du membre (facultatif)
--   - member_offer_reports.reason : nouveau motif « signup_exchange »
--   - learning_content            : nouvelle version EN BROUILLON du guide
--                                   « Lire et respecter les règles d'un
--                                   programme », à relire puis publier
--
-- REPRISE DE L'EXISTANT (une seule fois, à l'ajout de la colonne kind) :
--   - offres d'un ADMIN : 'affiliate' ; toutes les autres : 'campaign' ;
--   - offres de membres dont l'URL ressemble à un lien de suivi (mêmes règles
--     que src/utils/affiliate-tracking.js) : repassent en 'pending' avec la
--     note « À convertir en fiche campagne ».
--
-- Non destructive et réexécutable : aucune ligne ni colonne supprimée.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'member_offers' AND column_name = 'kind'
  ) THEN
    ALTER TABLE member_offers ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'campaign';

    UPDATE member_offers SET kind = 'affiliate'
    WHERE user_id IN (SELECT user_id FROM admins WHERE upper(role) = 'ADMIN');

    UPDATE member_offers
    SET status = 'pending', published_at = NULL, updated_at = NOW(),
        moderation_note = 'À convertir en fiche campagne'
    WHERE kind = 'campaign'
      AND status IN ('pending', 'published')
      AND (
        url ~* '^https://([a-z0-9-]+\.)*mylead\.(global|eu|pl)/(stl|l|r|c|click|go)/'
        OR url ~* '^https://(track|trk|tracking|clicks?)\.'
        OR url ~* '[?&](ml_sub[0-9]*|aff_id|aff_sub[0-9]*|aff_click_id|affiliate_id|click_?id|sub_?id|tracking_id)='
      );
  END IF;
END $$;

ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS campaign_name VARCHAR(120);
ALTER TABLE member_offers ADD COLUMN IF NOT EXISTS tips VARCHAR(1500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'member_offers_kind_check' AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE member_offers ADD CONSTRAINT member_offers_kind_check CHECK (kind IN ('affiliate', 'campaign'));
  END IF;
END $$;

-- Motif « Échange d'inscriptions » : la contrainte est remplacée par une liste
-- plus large ; aucune ligne existante n'est modifiée.
ALTER TABLE member_offer_reports DROP CONSTRAINT IF EXISTS member_offer_reports_reason_check;
ALTER TABLE member_offer_reports ADD CONSTRAINT member_offer_reports_reason_check
  CHECK (reason IN ('misleading', 'spam', 'dangerous', 'minors', 'rights', 'signup_exchange', 'other'));

-- Nouvelle version du guide, en BROUILLON : la version publiée reste en place.
-- Après relecture, publier celle-ci puis désactiver l'ancienne depuis la console.
INSERT INTO learning_content (kind, slug, title, summary, body, level, position, status)
SELECT kind, 'respecter-les-regles-v2', title, summary,
       body || '

## L''échange d''inscriptions est interdit
Ne demandez jamais à d''autres membres de s''inscrire sur votre lien, et ne vous inscrivez pas sur le leur en échange. Ces inscriptions ne viennent pas d''un vrai intérêt pour l''offre : ce sont de faux leads. Ils sont refusés par l''annonceur, les gains correspondants sont annulés et les comptes peuvent être fermés. Sur HAISSEL, une telle demande est retirée et peut être signalée avec le motif « Échange d''inscriptions ».',
       level, position, 'draft'
FROM learning_content
WHERE slug = 'respecter-les-regles'
ON CONFLICT (slug) DO NOTHING;
