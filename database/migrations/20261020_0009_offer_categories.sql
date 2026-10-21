-- Migration : catégories d'offres en base
--
-- Les catégories étaient une constante JavaScript dans community.controller.js :
-- en ajouter une, en renommer une ou en retirer une demandait un déploiement.
-- Elles passent en table, administrable depuis la console.
--
-- REPRISE DE L'EXISTANT, en deux temps :
--   1. les sept valeurs de la constante, avec leurs libellés ;
--   2. toute autre valeur déjà présente dans member_offers.category — y
--      compris une valeur qui aurait été introduite hors de la liste. Son
--      libellé reprend alors son identifiant, à corriger depuis la console.
-- Aucune offre existante ne peut donc se retrouver orpheline.
--
-- PAS DE CLÉ ÉTRANGÈRE sur member_offers.category : l'ajouter ferait échouer
-- la migration si une seule ligne portait une valeur inattendue, sur une base
-- de production qu'on ne peut pas inspecter d'avance. La cohérence est tenue
-- par le contrôleur, qui refuse toute catégorie absente ou désactivée.
--
-- « is_active » plutôt qu'une suppression : désactiver retire la catégorie des
-- formulaires sans toucher aux offres qui la portent déjà.
--
-- Non destructive et réexécutable.

CREATE TABLE IF NOT EXISTS offer_categories (
  slug VARCHAR(40) PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  position SMALLINT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT offer_categories_slug_check CHECK (slug ~ '^[a-z0-9_-]{2,40}$'),
  CONSTRAINT offer_categories_label_check CHECK (length(btrim(label)) BETWEEN 2 AND 80)
);

-- Ordre d'affichage, puis alphabétique : lecture stable dans les listes.
CREATE INDEX IF NOT EXISTS idx_offer_categories_order
  ON offer_categories (is_active, position, label);

-- 1. Les valeurs de la constante JavaScript.
INSERT INTO offer_categories (slug, label, position) VALUES
  ('applications', 'Applications',      10),
  ('jeux',         'Jeux mobiles',      20),
  ('shopping',     'Shopping',          30),
  ('services',     'Services en ligne', 40),
  ('education',    'Éducation',         50),
  ('sondages',     'Sondages et avis',  60),
  ('autre',        'Autre',             99)
ON CONFLICT (slug) DO NOTHING;

-- 2. Les valeurs réellement utilisées qui ne seraient pas dans la liste.
INSERT INTO offer_categories (slug, label, position)
SELECT DISTINCT o.category, o.category, 900
FROM member_offers o
WHERE o.category IS NOT NULL
  AND o.category ~ '^[a-z0-9_-]{2,40}$'
  AND NOT EXISTS (SELECT 1 FROM offer_categories c WHERE c.slug = o.category)
ON CONFLICT (slug) DO NOTHING;
