-- Migration : espace pédagogique « Apprendre »
--   - learning_content : guides (Apprendre) et tutoriels, rédigés par l'admin
--   - opportunities    : catalogue d'offres documentées (pays, âge minimum,
--                        action rémunérée, restrictions)
--   - site_settings    : réglages modifiables par l'admin (lien de parrainage
--                        MyLead et conditions associées)
--
-- Règle de publication (appliquée aussi par le serveur) : rien n'est visible
-- des membres sans vérification explicite d'un administrateur. Toute
-- modification du contenu annule la vérification et repasse en brouillon.
--
-- Aucune donnée personnelle des membres n'est stockée ici ; les clics vers
-- ces offres ne sont pas enregistrés.
--
-- Non destructive et réexécutable.

CREATE TABLE IF NOT EXISTS learning_content (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  title VARCHAR(120) NOT NULL,
  summary VARCHAR(300),
  body TEXT NOT NULL,
  level VARCHAR(20) NOT NULL DEFAULT 'debutant',
  position INTEGER NOT NULL DEFAULT 100,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  verified_at TIMESTAMPTZ,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT learning_content_kind_check CHECK (kind IN ('guide', 'tutorial')),
  CONSTRAINT learning_content_level_check CHECK (level IN ('debutant', 'intermediaire')),
  CONSTRAINT learning_content_status_check CHECK (status IN ('draft', 'published', 'disabled')),
  CONSTRAINT learning_content_published_verified CHECK (status <> 'published' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_learning_content_kind_status
  ON learning_content (kind, status, position);

CREATE TABLE IF NOT EXISTS opportunities (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  advertiser VARCHAR(120),
  network VARCHAR(80),
  paid_action VARCHAR(300),
  payout_text VARCHAR(160),
  countries VARCHAR(200),
  min_age SMALLINT,
  restrictions TEXT,
  allowed_channels TEXT,
  forbidden_methods TEXT,
  url TEXT,
  is_affiliate BOOLEAN NOT NULL DEFAULT true,
  terms_url TEXT,
  conditions_checked_at DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  verified_at TIMESTAMPTZ,
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT opportunities_status_check CHECK (status IN ('draft', 'published', 'disabled')),
  CONSTRAINT opportunities_min_age_check CHECK (min_age IS NULL OR min_age BETWEEN 10 AND 99),
  -- Une offre publiée a forcément été vérifiée et documentée.
  CONSTRAINT opportunities_published_complete CHECK (
    status <> 'published' OR (
      verified_at IS NOT NULL AND conditions_checked_at IS NOT NULL AND min_age IS NOT NULL
      AND COALESCE(countries, '') <> '' AND COALESCE(paid_action, '') <> ''
      AND COALESCE(restrictions, '') <> ''
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities (status, name);

CREATE TABLE IF NOT EXISTS site_settings (
  key VARCHAR(60) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Contenus de départ, en BROUILLON : l'administrateur les relit, les vérifie
-- puis les publie. Aucun chiffre de gains, témoignage ou taux de conversion.
-- ---------------------------------------------------------------------------

INSERT INTO learning_content (kind, slug, title, summary, body, level, position) VALUES
('guide', 'affiliation-bases', 'L''affiliation, c''est quoi ?',
 'Le principe : un annonceur rémunère un partenaire quand une action précise est réalisée grâce à lui.',
 '## Le principe
Un annonceur (une marque, une application, un site) veut se faire connaître. Il propose à des partenaires, appelés affiliés, de présenter son offre. Chaque affilié reçoit un lien personnel qui permet à l''annonceur de savoir d''où vient un visiteur.

## Les acteurs
- L''annonceur : il fixe les règles et décide de ce qu''il paie.
- La plateforme d''affiliation (réseau) : elle fait le lien entre annonceurs et affiliés, suit les actions et verse les commissions.
- L''affilié : il présente l''offre à son public, en respectant les règles.
- Le visiteur : il reste libre de ne rien faire.

## Ce qu''il faut retenir
- Une commission n''est versée que si l''action prévue par l''annonceur est réellement réalisée puis validée.
- Rien n''est garanti : beaucoup d''affiliés ne gagnent rien ou très peu, surtout au début.
- Chaque programme a ses propres conditions (âge, pays, méthodes autorisées). Elles priment sur tout ce qui est écrit ici.',
 'debutant', 10),
('guide', 'cpl-explique', 'Le CPL (coût par lead) expliqué',
 'Être payé pour un contact qualifié, pas pour un clic : ce que « lead » veut vraiment dire.',
 '## Définition
CPL signifie « coût par lead ». Un lead est un contact qualifié : par exemple une inscription complète avec une adresse e-mail confirmée, ou une demande de devis. L''annonceur paie l''affilié pour chaque lead qu''il juge valide.

## Les autres modèles
- CPC (coût par clic) : paiement au clic, rare et très surveillé.
- CPA / CPS (coût par action ou par vente) : paiement quand un achat est réalisé.
- CPI (coût par installation) : paiement quand une application est installée et parfois utilisée.

## Pourquoi un lead peut être refusé
- Les informations sont fausses, incomplètes ou en double.
- La personne ne remplit pas les conditions (âge, pays).
- Le trafic vient d''une méthode interdite par l''annonceur (spam, incitation, publicité non autorisée).
Un lead refusé n''est pas payé, et des refus répétés peuvent entraîner la fermeture du compte affilié.',
 'debutant', 20),
('guide', 'commissions', 'Comment fonctionnent les commissions',
 'Validation, délais, seuils de paiement : pourquoi un montant affiché n''est pas un montant gagné.',
 '## Le parcours d''une commission
1. Le visiteur clique sur le lien et réalise l''action demandée.
2. L''action apparaît « en attente » dans le compte affilié.
3. L''annonceur la valide ou la refuse, parfois plusieurs semaines plus tard.
4. Les commissions validées sont versées quand le seuil minimal de paiement de la plateforme est atteint.

## Lire un montant
Le montant indiqué par une plateforme est un maximum par action validée. Il peut changer à tout moment selon l''annonceur, le pays du visiteur ou la qualité du trafic.

## Impôts et âge
Les revenus d''affiliation sont des revenus : ils doivent être déclarés. La plupart des plateformes exigent d''être majeur pour ouvrir un compte et recevoir des paiements. Si vous êtes mineur, parlez-en à vos parents avant toute démarche et vérifiez les conditions officielles.',
 'debutant', 30),
('guide', 'verifier-une-offre', 'Âge, pays, règles : ce qu''il faut vérifier',
 'La liste des points à contrôler avant de présenter une offre.',
 '## Avant de présenter une offre
- L''âge minimum demandé par l''annonceur (et par la plateforme pour votre propre compte).
- Les pays acceptés : un visiteur d''un autre pays ne sera pas payé.
- L''action réellement rémunérée : une simple inscription n''est pas toujours payée.
- Les canaux autorisés : réseaux sociaux, site, e-mail, publicité payante…
- Les méthodes interdites : incitation, spam, mots-clés de marque, etc.

## Où trouver ces informations
Dans la fiche de l''offre sur la plateforme d''affiliation et dans les conditions générales de l''annonceur. En cas de doute, demandez par écrit au gestionnaire de votre compte avant de publier.',
 'debutant', 40),
('tutorial', 'contenu-honnete', 'Créer un contenu honnête pour présenter une offre',
 'Présenter ce que vous connaissez vraiment, et signaler clairement le lien affilié.',
 '## 1. Choisir une offre utile à votre public
Présentez un service que vous avez testé ou que vous comprenez. Demandez-vous s''il rend vraiment service aux personnes qui vous suivent.

## 2. Dire la vérité
- Décrivez ce que fait le service, ses limites et son prix éventuel.
- Ne promettez jamais de gains ni de résultats.
- N''affirmez pas qu''une inscription « rapporte de l''argent » à la personne si ce n''est pas le cas.

## 3. Signaler le lien affilié
Indiquez clairement « lien affilié » ou « #publicité » à côté du lien, dès le début du contenu. C''est une obligation légale en France (article L. 121-1 du Code de la consommation, loi du 9 juin 2023 sur l''influence commerciale).

## 4. Respecter les canaux autorisés
Publiez uniquement là où l''annonceur l''autorise. N''envoyez pas de messages non sollicités.',
 'debutant', 10),
('tutorial', 'suivre-resultats', 'Suivre ses résultats sans se tromper',
 'Clics, leads en attente, leads validés : comment lire ses statistiques.',
 '## Les trois chiffres à distinguer
- Les clics : le nombre de visites venant de votre lien.
- Les actions en attente : des actions enregistrées, pas encore validées.
- Les actions validées : les seules qui comptent pour le paiement.

## Bonnes pratiques
- Notez où vous avez publié chaque lien (sous-identifiant fourni par la plateforme si elle en propose).
- Comparez vos publications entre elles plutôt qu''avec des chiffres trouvés en ligne.
- Un taux de refus élevé est un signal d''alerte : vérifiez que votre trafic respecte les règles.

## Ce qu''il ne faut pas faire
Ne cliquez jamais sur vos propres liens et ne demandez pas à vos proches de s''inscrire pour « faire monter les chiffres » : c''est de la fraude, détectée et sanctionnée.',
 'debutant', 20),
('tutorial', 'respecter-les-regles', 'Lire et respecter les règles d''un programme',
 'Comment lire une fiche d''offre et que faire en cas de doute.',
 '## Lire la fiche d''offre
Repérez les rubriques « Restrictions », « Trafic autorisé », « Trafic interdit », « Pays » et « Âge ». Elles décrivent ce qui est payé et ce qui entraîne un refus.

## Les interdits les plus fréquents
- Le trafic incité (« inscris-toi et je te donne… ») sauf si c''est explicitement autorisé.
- Le spam : messages en masse, commentaires automatiques, e-mails non sollicités.
- Les faux leads et les comptes multiples.
- Le masquage de la provenance du trafic.

## En cas de doute
Ne publiez pas. Posez la question au gestionnaire de votre compte et gardez sa réponse écrite.',
 'debutant', 30)
ON CONFLICT (slug) DO NOTHING;

-- Texte de rémunération du parrainage : modifiable par l'admin, à vérifier
-- sur les conditions officielles avant d'activer le lien.
INSERT INTO site_settings (key, value) VALUES
  ('referral_rate_text', 'MyLead annonce une rémunération de 5 % des gains de vos filleuls, selon les conditions en vigueur du programme.')
ON CONFLICT (key) DO NOTHING;
