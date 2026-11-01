-- Migration : bons plans gratuits (non affiliés)
--
-- Nouvelle sorte d'offre member_offers.kind = 'free' : bon plan GRATUIT de
-- l'équipe, sans lien affilié. Ouverture directe (pas de sous-identifiant,
-- aucun clic suivi), aucun badge « Lien affilié », incentive_allowed = false,
-- aucun champ de monétisation. Accessible selon min_age (NULL = tout le monde).
--
-- 1. La contrainte member_offers_kind_check est élargie à 'free' : aucune
--    ligne existante n'est modifiée (les valeurs déjà présentes restent
--    valides).
-- 2. Dix bons plans publiés, rattachés au premier compte ADMIN existant
--    (aucun compte créé). Sans compte ADMIN, rien n'est inséré : relancer la
--    migration plus tard les ajoute. Chaque offre est repérée par son titre
--    (kind = 'free') : la relancer ne crée aucun doublon.
--
-- Non destructive et réexécutable.

ALTER TABLE member_offers DROP CONSTRAINT IF EXISTS member_offers_kind_check;
ALTER TABLE member_offers ADD CONSTRAINT member_offers_kind_check
  CHECK (kind IN ('affiliate', 'campaign', 'free'));

WITH admin AS (
  SELECT u.id
  FROM users u
  JOIN admins a ON a.user_id = u.id
  WHERE upper(a.role) = 'ADMIN' AND u.is_active AND NOT u.is_banned
  ORDER BY u.id
  LIMIT 1
),
seed (title, description, conditions, url, category, countries, min_age) AS (
  VALUES
  ('Pass Culture',
   'Gratuit · pas un lien affilié. Un crédit offert par l''État pour des livres, places de ciné, concerts, cours… Inscris-toi dès 15 ans pour accéder aux offres gratuites, le crédit arrive à 17 et 18 ans.',
   'Résider en France, à partir de 15 ans', 'https://pass.culture.fr', 'autre', 'FR', 15),
  ('Jeun''Est (Grand Est)',
   'Gratuit · pas un lien affilié. Plus de 100 € d''avantages gratuits : ciné, livres, sport, formation premiers secours (PSC) et Projet Voltaire gratuit. Inscriptions ouvertes jusqu''au 1er mai 2027.',
   'Vivre ou être scolarisé dans le Grand Est, du lycée à 29 ans', 'https://www.jeunest.fr', 'autre', 'FR', 15),
  ('Carte Avantage Jeune SNCF',
   'Gratuit · pas un lien affilié. 49 € par an pour -30 % sur tous les trains, tous les jours. Rentabilisée dès environ 165 € de billets dans l''année.',
   '12 à 27 ans', 'https://www.sncf-connect.com/train/carte-abonnement-train/jeune', 'services', 'FR', 12),
  ('GitHub Student Developer Pack',
   'Gratuit · pas un lien affilié. Des dizaines d''outils de développement pro gratuits pour coder tes projets. Il faut faire vérifier ton statut d''élève.',
   'Élève, 13 ans minimum', 'https://education.github.com/pack', 'education', 'MONDE', 13),
  ('Musées nationaux gratuits',
   'Gratuit · pas un lien affilié. Les musées et monuments nationaux sont gratuits pour les moins de 18 ans, et jusqu''à 25 ans pour les résidents de l''UE.',
   'Moins de 18 ans (ou 18-25 ans résident UE)', 'https://www.culture.gouv.fr', 'autre', 'FR', NULL),
  ('Bibliothèque municipale gratuite',
   'Gratuit · pas un lien affilié. Livres, BD, mangas, et souvent films ou presse en ligne : l''inscription est gratuite pour les mineurs dans la plupart des villes.',
   'Selon ta ville', 'https://www.service-public.gouv.fr', 'autre', 'FR', NULL),
  ('Canva Éducation',
   'Gratuit · pas un lien affilié. Canva version payante gratuitement si un prof t''invite dans sa classe Canva.',
   'Invitation d''un enseignant', 'https://www.canva.com/education/', 'education', 'MONDE', 13),
  ('Office avec ton compte scolaire',
   'Gratuit · pas un lien affilié. Beaucoup d''académies donnent Word, Excel, PowerPoint gratuitement via l''ENT. Vérifie dans ton ENT.',
   'Selon ton académie', 'https://www.microsoft.com/fr-fr/education/products/office', 'education', 'FR', 13),
  ('Anki',
   'Gratuit · pas un lien affilié. Flashcards gratuites avec répétition espacée, top pour réviser. Gratuit sur PC, Android et web (l''appli iPhone est payante).',
   'Aucune', 'https://apps.ankiweb.net', 'education', 'MONDE', NULL),
  ('Lumni et Khan Academy',
   'Gratuit · pas un lien affilié. Cours en vidéo et exercices gratuits : Lumni (France TV, programme du lycée) et Khan Academy (très bon en maths).',
   'Aucune', 'https://www.lumni.fr', 'education', 'FR', NULL)
)
INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action,
                           min_age, conditions, rights_confirmed_at, status, published_at, kind,
                           incentive_allowed, member_benefit, payout_note, campaign_rules_url, subid_param)
SELECT admin.id, s.title, s.url, s.description, s.category, s.countries, 'Consulter le site officiel',
       s.min_age::smallint, s.conditions, NOW(), 'published', NOW(), 'free',
       false, NULL, NULL, NULL, NULL
FROM seed s CROSS JOIN admin
WHERE NOT EXISTS (
  SELECT 1 FROM member_offers o WHERE o.kind = 'free' AND o.title = s.title
);
