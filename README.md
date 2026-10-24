# HAISSEL

HAISSEL est une communauté d'offres affiliées doublée d'un parcours pour apprendre l'affiliation.
Les guides sont ouverts à tous ; tout ce qui mène à un lien affilié ou à un compte éditeur MyLead est réservé aux membres ayant déclaré 18 ans ou plus.
Le site ne verse aucun argent, ne demande jamais d'identifiants MyLead et ne promet aucun gain.

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Architecture](#architecture)
3. [Mettre en ligne sur Vercel](#mettre-en-ligne-sur-vercel)
4. [Développer en local](#développer-en-local)
5. [Sécurité](#sécurité)
6. [Âge des membres](#âge-des-membres)
7. [Affiliation interne (gelée)](#affiliation-interne-gelée)
8. [Anciennes tables](#anciennes-tables)
9. [Tests et migrations](#tests-et-migrations)

L'ancien fonctionnement en réseau local et sous Docker / Nginx est archivé dans [docs/archive/reseau-local-et-docker.md](docs/archive/reseau-local-et-docker.md).

## Fonctionnalités

**Membres**
- **Fil d'offres** : les offres publiées par la communauté et par l'équipe, classées par catégorie.
- **Recherche** dans le titre et la description des offres.
- **Publication avec modération** : toute publication attend la validation de l'équipe avant d'apparaître.
  - Les membres majeurs partagent des **fiches campagne** : lien vers la page officielle (site de l'annonceur ou page de la campagne sur MyLead), nom de la campagne, conseils et conditions. Un lien qui ressemble à un lien de suivi affilié est refusé (liste dans `src/utils/affiliate-tracking.js`).
  - Seuls les administrateurs publient des **liens affiliés**.
- **Profil** : mes offres (statut et motif de refus éventuel), offres sauvegardées, sécurité du compte.
- **Sauvegardes** : garder une offre pour plus tard.
- **Signalements** : signaler une offre à l'équipe, y compris une demande d'« échange d'inscriptions » (interdite).
- **Apprendre** : guides et tutoriels, opportunités, parcours MyLead et lien de parrainage (ces deux derniers réservés aux majeurs).
- **Notifications** : messages de l'équipe affichés dans le site.

**Administration**
- Catégories des offres.
- Modération des offres membres et des signalements.
- Guides, tutoriels et opportunités de l'espace Apprendre.
- Parrainage.
- Notifications envoyées aux membres.
- Liens de l'équipe et clics.

## Architecture

- **Serveur** : Node.js (≥ 20) + Express.
- **Base** : PostgreSQL, hébergée chez Neon via l'intégration Vercel.
- **Interface** : HTML, CSS et JavaScript, sans framework (dossier `frontend/`).
- **Hébergement** : Vercel (`vercel.json`). Les migrations sont lancées automatiquement à chaque déploiement par `scripts/vercel-build.js` (script `vercel-build`).

Sur Vercel, plusieurs instances répondent en parallèle, sans mémoire partagée. Le mode est détecté par `VERCEL=1`, défini par Vercel. En conséquence :
- les limites de tentatives sont comptées en base (tables `rate_limit_counters` et `login_throttle_failures`) ;
- les notifications passent par une interrogation régulière (`GET /api/notifications/poll`, toutes les 45 s, onglet visible uniquement) au lieu d'un flux SSE. Le nombre d'utilisateurs connectés n'est donc pas disponible dans la console ;
- la purge de rétention (RGPD) est déclenchée chaque nuit par le planificateur de Vercel (`crons` dans `vercel.json`, route `/api/internal/retention`, authentifiée par `CRON_SECRET`).

## Mettre en ligne sur Vercel

### Variables d'environnement

À renseigner dans le tableau de bord Vercel (Settings › Environment Variables). « Sensitive » : cochez l'option pour que la valeur ne soit plus lisible après enregistrement.

| Variable | Rôle | Obligatoire | Sensitive |
|---|---|---|---|
| `APP_SECRET` | secret maître, au moins 32 octets aléatoires. `JWT_SECRET` est accepté à la place pour les anciennes installations | oui | oui |
| `DATABASE_URL` | adresse PostgreSQL. Si elle est absente, l'adresse publiée par l'intégration Neon (`<PRÉFIXE>_DATABASE_URL`, et `<PRÉFIXE>_DATABASE_URL_UNPOOLED` pour les migrations) est utilisée | oui, sauf intégration Neon | oui |
| `NODE_ENV` | `production` | oui | non |
| `COOKIE_SECURE` | `true` (Vercel sert toujours en HTTPS) | oui | non |
| `CRON_SECRET` | authentifie la purge de rétention ; sans elle, la route répond 404 et la purge ne tourne pas | oui | oui |
| `TURNSTILE_SITE_KEY` | clé publique Cloudflare Turnstile (anti-robot) ; à définir avec la clé secrète, ou aucune des deux | recommandé | non |
| `TURNSTILE_SECRET_KEY` | clé secrète Turnstile | recommandé | oui |
| `ADMIN_IP_ALLOWLIST` | adresses IP autorisées pour l'administration, séparées par des virgules ; vide = toute adresse | optionnel | non |
| `ENABLE_INTERNAL_AFFILIATION` | `false` (défaut) : moteur d'affiliation interne gelé | optionnel | non |
| `MAIL_TRANSPORT` | `none` (défaut) ou `smtp` | si e-mails | non |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER` | expéditeur et serveur SMTP | si e-mails | non |
| `SMTP_PASSWORD` | mot de passe SMTP | si e-mails | oui |
| `APP_PUBLIC_URL` | adresse du site, base des liens envoyés par e-mail | si e-mails | non |
| `EMAIL_VERIFICATION` | `off` pour ne pas exiger la vérification d'adresse même si l'envoi est configuré | optionnel | non |
| `MFA_ENCRYPTION_KEY` | clé de chiffrement de la double authentification (dérivée d'`APP_SECRET` sinon), au moins 32 octets | optionnel | oui |
| `ALLOWED_EMAIL_DOMAIN` | domaine e-mail imposé à l'inscription ; vide = libre | optionnel | non |
| `AFFILIATE_WEBHOOK_SECRET` | secret des webhooks partenaires (moteur gelé) ; `AFFILIATE_WEBHOOK_SECRET_<NOM>` par partenaire | optionnel | oui |
| `CORS_ORIGINS` | origines supplémentaires autorisées ; inutile en usage normal | optionnel | non |

`ADMIN_REQUIRE_MFA` est sans effet en ligne : la double authentification des administrateurs y est toujours imposée.

Sans e-mail configuré (`MAIL_TRANSPORT=none`), la vérification d'adresse n'est pas exigée et « Mot de passe oublié » est masqué.

### Cloudflare Turnstile : hostnames

Dans le widget Turnstile (tableau de bord Cloudflare), déclarez chaque adresse qui affichera le formulaire :
- le domaine de production ;
- l'adresse fixe de chaque branche de Preview (de la forme `<projet>-git-<branche>-<équipe>.vercel.app`).

Une adresse absente de la liste fait échouer le défi, donc la connexion et l'inscription.

### Previews et base de données

> **Attention : une Preview utilise la même base que la production si `DATABASE_URL` est commune aux deux environnements.** Comptes, offres et migrations sont alors partagés. Pour isoler les Previews, donnez-leur une autre base (variable limitée à l'environnement Preview, ou branche Neon dédiée).

### Premier administrateur

Aucun compte n'est promu automatiquement. Créez votre compte sur le site, puis, depuis votre poste, avec `DATABASE_URL` pointant vers la base de production :

```powershell
npm run admin:promote -- --username votre_pseudo
# ou --email, ou --user-id ; --demote pour retirer le rôle
```

## Développer en local

Prérequis : Node.js ≥ 20 et PostgreSQL ≥ 14.

```powershell
npm install
Copy-Item .env.example .env   # puis renseigner DATABASE_URL et APP_SECRET
npm run migrate               # crée ou met à jour le schéma
npm run dev                   # http://localhost:3000, redémarre à chaque modification
npm test
```

En local, l'administration n'est accessible que depuis `http://localhost:3000`. En développement, `MAIL_TRANSPORT=console` affiche les e-mails dans la console au lieu de les envoyer (refusé en production).

## Sécurité

Aucun système n'est inviolable. L'objectif est de réduire les risques connus et de limiter l'impact d'une compromission.

**Comptes**
- Inscription avec prénom, nom, adresse e-mail, pseudo unique (3 à 30 caractères, `a-z 0-9 _`, sans `@`), mot de passe et confirmation. Tout est revalidé côté serveur ; l'unicité est garantie par PostgreSQL, y compris en cas de requêtes simultanées.
- Connexion avec un seul champ « Adresse e-mail ou pseudo ». Comme un pseudo ne peut pas contenir `@`, il n'y a aucune ambiguïté possible avec une adresse e-mail.
- Messages génériques : « Identifiants incorrects » que le compte existe ou non. Les états banni, suspendu ou non vérifié ne sont indiqués qu'après un mot de passe correct.

**Mots de passe**
- Hachés avec Argon2id (m = 19 Mio, t = 2, p = 1, recommandation OWASP), avec un sel propre à chaque mot de passe. Au plus 4 calculs simultanés, ce qui borne la mémoire utilisée.
- Les anciens hash bcrypt sont convertis automatiquement en Argon2id à la connexion suivante.
- Politique : 10 à 128 caractères, phrases de passe bienvenues, aucune règle arbitraire de composition. Sont refusés : les mots de passe très courants, les répétitions et ceux qui contiennent le pseudo ou l'adresse e-mail.

**Sessions et cookies**
- Identifiant aléatoire de 256 bits, envoyé uniquement dans un cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, sans attribut `Domain`. En HTTPS, le cookie s'appelle `__Host-haissel_sid` et porte `Secure`. Seul le SHA-256 de l'identifiant est stocké en base.
- Aucun jeton dans `localStorage` ni `sessionStorage`. L'en-tête `Authorization: Bearer` n'est pas accepté.
- Expiration absolue et par inactivité :

  | Compte | Durée maximale | Inactivité |
  |---|---|---|
  | Utilisateur | 7 jours | 24 h |
  | Administrateur | 8 h | 30 min |
  | En attente du code de double authentification | 10 min | 10 min |

- Révocation à la déconnexion, bouton « Se déconnecter de tous les appareils », révocation de toutes les sessions après un changement ou une réinitialisation du mot de passe, après l'activation de la double authentification et après un changement de rôle. Chaque connexion crée un nouvel identifiant (protection contre la fixation de session).
- À chaque requête, le serveur relit la session : elle doit être active et le compte ni suspendu ni banni. Le rôle provient de la table `admins`.

**CSRF.** Chaque requête qui modifie des données est contrôlée de plusieurs façons :
1. les en-têtes `Sec-Fetch-Site` et `Origin` doivent indiquer la même origine que le serveur ;
2. sur les routes connectées, il faut en plus le jeton `X-CSRF-Token`, propre à la session (HMAC dérivé de la session) ;
3. le cookie est `SameSite=Lax`.

**Limites de tentatives**
- Limites par IP : connexion (échecs uniquement, 30 par 15 min), inscription (30 par heure), vérification d'e-mail et réinitialisation, double authentification. Elles restent larges car une classe entière peut sortir par la même adresse IP.
- Ralentissement progressif par compte visé (0,5 s à 8 s après 3 échecs), sans verrouillage, pour qu'une victime ne puisse pas être bloquée par un attaquant. Changer d'IP n'y échappe pas.
- 5 codes de double authentification faux annulent la connexion en cours.
- Sur Vercel, ces compteurs sont en base (voir [Architecture](#architecture)) : toutes les instances partagent les mêmes. Si PostgreSQL ne répond pas, les compteurs laissent passer la requête plutôt que de rendre le site indisponible.

**Vérification d'e-mail et mot de passe oublié**
- Jetons aléatoires de 256 bits, stockés hachés, à usage unique, valables 24 h pour la vérification et 30 min pour la réinitialisation. Au plus 3 jetons par heure et par compte ; une nouvelle demande invalide l'ancien lien.
- Les liens transportent le jeton dans le fragment `#` de l'URL : il n'est jamais envoyé au serveur en GET, ni écrit dans un journal, ni transmis par l'en-tête Referer.
- Réponse identique, que le compte existe ou non.
- Le mot de passe n'est modifié qu'après validation du jeton, dans une transaction qui révoque aussi toutes les sessions.

**Double authentification (TOTP)**
- Compatible Google Authenticator, Microsoft Authenticator, Aegis…
- Le secret est chiffré en AES-256-GCM. La clé vient de `MFA_ENCRYPTION_KEY`, ou est dérivée d'`APP_SECRET`.
- Anti-rejeu : un même code ne fonctionne qu'une fois.
- 10 codes de récupération, à usage unique, stockés hachés.

**Administration en ligne.** Sur Vercel, la console d'administration est accessible en ligne. Elle est protégée, sur la page comme sur toute l'API `/api/admin/*`, par :
1. une session valide en base ;
2. le rôle `ADMIN` lu dans la table `admins` ;
3. la double authentification, **obligatoire et non désactivable** (un écran guide l'activation à la première connexion) ;
4. en option, `ADMIN_IP_ALLOWLIST`, qui limite l'accès à vos adresses IP. Sans elle, un avertissement est écrit dans les journaux au démarrage.

`promote-admin` refuse de retirer le rôle au dernier administrateur sans `--force`, et ferme les sessions du compte modifié.

**Turnstile.** Connexion, inscription, « mot de passe oublié » et publication d'une offre passent par Cloudflare Turnstile quand les deux clés sont définies. La clé secrète ne quitte jamais le serveur ; `/api/auth/config` ne transmet que la clé publique. Les clés de test Cloudflare sont refusées en production.

**Déclaration de majorité.** Voir [Âge des membres](#âge-des-membres) : passer de « mineur » à « majeur » n'est possible qu'après **30 jours**.

**Journal de sécurité.** La table `security_events` garde les connexions réussies ou échouées, les changements et réinitialisations de mot de passe, les vérifications d'adresse, les événements de double authentification, les déclarations de majorité, les révocations et les changements de rôle. Les IP y sont tronquées. Aucun mot de passe, cookie, jeton ni secret n'y figure.

**Secrets.** Changer `APP_SECRET` invalide tous les jetons CSRF et rend illisibles les secrets de double authentification (sauf si `MFA_ENCRYPTION_KEY` est défini séparément). Aucun secret n'est versionné : `.env` est ignoré par Git. Si un secret a pu être exposé, remplacez-le.

## Âge des membres

MyLead exige 18 ans pour ouvrir un compte éditeur. Une seule question est posée à l'inscription : **« As-tu 18 ans ou plus ? »**. Les comptes plus anciens la reçoivent à leur prochaine connexion. Aucune date de naissance ni aucun âge n'est enregistré : seulement `users.is_adult` et `users.adult_declared_at`. C'est une déclaration sur l'honneur.

| | Majeur déclaré | Mineur déclaré | Sans réponse |
|---|---|---|---|
| Guides, opportunités, liste des offres | oui | oui | oui |
| Parcours MyLead, lien de parrainage | oui | non | non |
| Publier ou modifier une fiche campagne | oui* | non | non |
| Ouvrir un lien affilié | oui | non | non |
| Retirer sa propre offre | oui | oui | oui |

\* les liens affiliés sont réservés aux ADMIN ; un membre ne publie que des fiches campagne, sans lien de suivi (400 `AFFILIATE_LINK_FORBIDDEN`).

La règle est appliquée par le serveur (403 `ADULT_REQUIRED`, ou `ADULT_DECLARATION_REQUIRED` sans réponse), pas seulement par l'interface. L'adresse d'un lien affilié n'est jamais envoyée à qui ne peut pas l'ouvrir : elle n'est délivrée que par `GET /api/community/offers/:id/open`, après contrôle. Une offre dont l'âge minimum dépasse 18 ans est refusée à tous (`AGE_RESTRICTED`).

**Changer sa réponse** (`POST /api/auth/adult-declaration`) : passer de « majeur » à « mineur » est immédiat. L'inverse n'est possible que 30 jours après la dernière réponse, sinon un mineur refusé n'aurait qu'à répondre « oui » dans la foulée. Un administrateur peut réinitialiser la déclaration d'un membre.

## Affiliation interne (gelée)

HAISSEL contient un moteur d'affiliation interne (codes personnels `HAI-XXXXXXXX`, webhook de conversion signé, gains). Aucun annonceur réel n'y est branché et le format de postback attendu (`X-Haissel-Signature`) n'est émis par aucun réseau d'affiliation. Il est donc **gelé** tant que `ENABLE_INTERNAL_AFFILIATION` ne vaut pas `true` :
- les routes de création de codes, de statistiques, de conversions, de gains et le webhook répondent 404 `FEATURE_DISABLED` ;
- les redirections `/r/:code` restent actives, pour ne casser aucun lien déjà partagé ;
- le catalogue de liens de l'équipe (`/go/:id`, écrans « Liens » et « Clics ») est une fonctionnalité distincte, toujours active ;
- aucune donnée n'est supprimée.

Pour le réactiver pour de bon, il faudra d'abord écrire un adaptateur par réseau d'affiliation, qui lit le format de postback de ce réseau et l'authentifie à sa manière.

## Anciennes tables

HAISSEL a d'abord été un réseau social. Ce code a été supprimé, mais **aucune table n'a été supprimée** : `posts`, `comments`, `likes`, `follows`, `conversations`, `conversation_members`, `messages`, `notifications` et `reports` restent en base, sans être lues ni écrites. Ne pas les confondre avec `notification_broadcasts` / `notification_recipients` et `member_offer_reports`, qui servent au site actuel. Les supprimer demanderait une migration dédiée, après sauvegarde. La table `stats` est elle aussi conservée sans être utilisée.

## Tests et migrations

```powershell
npm test                    # vérification de syntaxe + tous les tests
npm run test:unit           # sans base de données
npm run test:integration    # PostgreSQL requis
npm run migrate             # applique les migrations manquantes
```

Les tests utilisent `DATABASE_URL` (ou `TEST_DATABASE_URL`) dans un **schéma temporaire** `haissel_test_*`, créé puis supprimé : les données réelles ne sont ni lues ni modifiées.

**Migrations**
- `database/init.sql` : schéma de base ; `database/migrations/*.sql` : évolutions, appliquées dans l'ordre alphabétique.
- Chaque fichier est appliqué dans une transaction et enregistré dans `schema_migrations` ; relancer ne fait rien.
- Sur Vercel, elles sont appliquées à chaque déploiement par `scripts/vercel-build.js`. Si une migration échoue, le déploiement échoue.
- `GET /api/health` renvoie `schema: "migrations_required"` si des tables manquent.
- **Règle : jamais de migration destructive.** Aucune migration ne supprime de table, de colonne ni de donnée. Pour corriger, on ajoute une nouvelle migration ; on ne supprime jamais la base.
