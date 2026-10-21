# HAISSEL

Plateforme d'affiliation : les utilisateurs obtiennent un lien personnel par offre, HAISSEL compte les clics côté serveur, les partenaires confirment les conversions via un webhook signé, et les gains n'apparaissent qu'une fois la conversion approuvée.

```
                 RÉSEAU LOCAL                       MACHINE SERVEUR
   http://IP_DU_SERVEUR:3000                     http://localhost:3000
            │ (espace utilisateur)                        │ (administration)
            └───────────────────────┬─────────────────────┘
                          ┌─────────▼─────────┐
                          │ Express / Node.js │  helmet · rate-limit · JWT + sessions
                          └─────────┬─────────┘
          ┌───────────────┬─────────┴───────┬──────────────────────┐
     /api/auth      /api/affiliate     /api/admin           /api/webhooks
     (sessions)     /r/:code (clics)   (local + ADMIN)      (HMAC signé)
          └───────────────┴────────┬────────┴──────────────────────┘
                              PostgreSQL
```

## Accès

| Adresse | Qui | Contenu |
|---|---|---|
| `http://localhost:3000` ou `http://127.0.0.1:3000` | la machine serveur | **Administration** (connexion admin) |
| `http://IP_DU_SERVEUR:3000` | appareils du réseau local | **Espace utilisateur** |
| `http://localhost:3000/app` | la machine serveur | espace utilisateur (pour tester) |
| `http://IP_DU_SERVEUR:3000/r/HAI-XXXXXXXX` | n'importe qui | lien affilié (clic + redirection) |

L'administration est protégée par trois contrôles côté serveur, sur la page **et** sur toute l'API `/api/admin/*` :
1. la requête vient de la machine serveur (adresse du socket `127.0.0.1` / `::1`, les en-têtes `X-Forwarded-*` sont ignorés) ;
2. le jeton JWT est valide **et** sa session existe en base (non expirée, non révoquée, compte actif et non banni) ;
3. l'utilisateur figure dans la table `admins` avec le rôle `ADMIN`.

Un utilisateur du réseau qui connaît les URL reçoit `403`. Modifier `localStorage` ou le JavaScript ne donne aucun droit.

## Installation (Node.js + PostgreSQL)

Prérequis : Node.js ≥ 20, PostgreSQL ≥ 14.

```powershell
npm install
Copy-Item .env.example .env
notepad .env          # renseigner DATABASE_URL, JWT_SECRET, AFFILIATE_WEBHOOK_SECRET
npm run migrate       # crée / met à jour le schéma (idempotent)
npm start             # écoute sur 0.0.0.0:3000
```

Créez ensuite votre compte depuis `http://localhost:3000/app`, puis promouvez-le administrateur :

```powershell
node scripts/promote-admin.js --username votre_nom
# ou --email vous@exemple.fr   ou --user-id 1
# retirer le rôle : ajouter --demote
```

Le script est idempotent (aucun doublon s'il est relancé). Aucun compte n'est jamais promu automatiquement.

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `PORT` | port HTTP (3000) |
| `DATABASE_URL`, `DATABASE_SSL` | connexion PostgreSQL |
| `JWT_SECRET` | ≥ 32 octets aléatoires ; le serveur refuse de démarrer sinon |
| `ALLOWED_EMAIL_DOMAIN` | domaine e-mail imposé à l'inscription (vide = libre) |
| `AFFILIATE_WEBHOOK_SECRET` | secret HMAC des webhooks partenaires (≥ 32 caractères ; vide = webhook désactivé). Secret par partenaire : `AFFILIATE_WEBHOOK_SECRET_<NOM>` |
| `PROXY_SHARED_SECRET` | Docker uniquement : authentifie Nginx auprès de l'application |
| `PUBLIC_PORT`, `ADMIN_PORT` | Docker uniquement : ports publics / admin |
| `CORS_ORIGINS` | origines supplémentaires autorisées (inutile en usage normal : même origine) |

`.env` n'est jamais versionné ; seuls `.env.example` et `.env.production.example` le sont.

## Authentification et sécurité des comptes

Aucun système n'est inviolable. L'objectif est de réduire les risques connus et de limiter l'impact d'une compromission.

**Comptes**
- Inscription avec prénom, nom, adresse e-mail, pseudo unique (3 à 30 caractères, `a-z 0-9 _`, sans `@`), mot de passe et confirmation. Tout est revalidé côté serveur ; l'unicité est garantie par PostgreSQL, y compris en cas de requêtes simultanées.
- Connexion avec un seul champ « Adresse e-mail ou pseudo ». Comme un pseudo ne peut pas contenir `@`, il n'y a aucune ambiguïté possible avec une adresse e-mail.
- Messages génériques : « Identifiants incorrects » que le compte existe ou non. Les états banni, suspendu ou non vérifié ne sont indiqués qu'après un mot de passe correct.

**Mots de passe**
- Hachés avec Argon2id (m = 19 Mio, t = 2, p = 1, recommandation OWASP), avec un sel propre à chaque mot de passe. Coût mesuré sur le serveur : environ 55 ms pour un hash, 45 ms pour une vérification. Au plus 4 calculs simultanés, ce qui borne la mémoire utilisée.
- Les anciens hash bcrypt sont convertis automatiquement en Argon2id à la connexion suivante.
- Politique : 10 à 128 caractères, phrases de passe bienvenues, aucune règle arbitraire de composition. Sont refusés : les mots de passe très courants, les répétitions et ceux qui contiennent le pseudo ou l'adresse e-mail.

**Sessions**
- Identifiant aléatoire de 256 bits, envoyé uniquement dans un cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, sans attribut `Domain`. En HTTPS, le cookie s'appelle `__Host-haissel_sid` et porte `Secure`. Seul le SHA-256 de l'identifiant est stocké en base.
- Aucun jeton dans `localStorage` ni `sessionStorage`. Les anciens JWT ont été révoqués par la migration 0003 et l'en-tête `Authorization: Bearer` n'est plus accepté.
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

**Limitations des tentatives**
- Limites par IP : connexion, inscription, vérification d'e-mail et réinitialisation, double authentification.
- Ralentissement progressif par compte visé, sans verrouillage, pour qu'une victime ne puisse pas être bloquée par un attaquant.
- 5 codes de double authentification faux annulent la connexion en cours.
- Ces compteurs sont en mémoire : ils valent pour un seul processus Node. Avec plusieurs instances, il faudrait un stockage partagé.

**Vérification d'e-mail et mot de passe oublié**
- Jetons aléatoires de 256 bits, stockés hachés, à usage unique, valables 24 h pour la vérification et 30 min pour la réinitialisation. Au plus 3 jetons par heure et par compte ; une nouvelle demande invalide l'ancien lien.
- Les liens transportent le jeton dans le fragment `#` de l'URL : il n'est jamais envoyé au serveur en GET, ni écrit dans un journal, ni transmis par l'en-tête Referer.
- Réponse identique, que le compte existe ou non.
- Le mot de passe n'est modifié qu'après validation du jeton, dans une transaction qui révoque aussi toutes les sessions. Une notification est envoyée après chaque changement.
- **Sans service d'e-mail configuré (`MAIL_TRANSPORT=none`)** :
  - la vérification d'adresse n'est pas exigée ;
  - « Mot de passe oublié » est masqué et le serveur répond qu'aucun envoi n'est configuré ;
  - aucun faux « e-mail envoyé » n'est jamais affiché.

**Double authentification (TOTP)**
- Compatible Google Authenticator, Microsoft Authenticator, Aegis…
- Le secret est chiffré en AES-256-GCM. La clé vient de `MFA_ENCRYPTION_KEY`, ou est dérivée d'`APP_SECRET`.
- Anti-rejeu : un même code ne fonctionne qu'une fois.
- 10 codes de récupération, à usage unique, stockés hachés.
- Obligatoire pour les administrateurs (`ADMIN_REQUIRE_MFA=true`, valeur par défaut). À la première connexion à l'admin, un écran guide l'activation. Un administrateur ne peut pas la désactiver.

**Comptes privilégiés**
- Un compte administrateur ne fonctionne que depuis la machine serveur, à la connexion comme à chaque requête.
- `promote-admin` refuse de retirer le rôle au dernier administrateur sans `--force`, et ferme les sessions du compte modifié.

**Journal.** La table `security_events` garde :
- les connexions réussies ou échouées ;
- les changements et réinitialisations de mot de passe ;
- les vérifications d'adresse ;
- les événements de double authentification ;
- les révocations et les changements de rôle.

Les IP y sont tronquées. Aucun mot de passe, cookie, jeton ni secret n'y figure.

### Configurer l'envoi des e-mails

1. Choisissez un fournisseur SMTP : celui de votre messagerie, ou un service transactionnel (Brevo, Mailjet, Postmark…). Pour Gmail, il faut activer la validation en deux étapes puis créer un « mot de passe d'application ».
2. Dans `.env` :
   ```
   MAIL_TRANSPORT=smtp
   MAIL_FROM="HAISSEL <adresse@exemple.fr>"
   SMTP_HOST=smtp.exemple.fr
   SMTP_PORT=587
   SMTP_SECURE=false        # true pour le port 465
   SMTP_USER=...
   SMTP_PASSWORD=...
   APP_PUBLIC_URL=http://192.168.1.17:3000   # adresse que les utilisateurs ouvriront
   ```
3. Redémarrez le serveur. La vérification d'adresse devient alors obligatoire pour les **nouveaux** comptes ; les comptes créés avant la migration 0003 sont considérés comme vérifiés.

En développement uniquement, `MAIL_TRANSPORT=console` affiche les e-mails dans la console au lieu de les envoyer. Le serveur refuse ce mode quand `NODE_ENV=production`.

### Activer HTTPS (production)

En HTTP sur le réseau local, le cookie de session circule en clair : quelqu'un qui écoute le Wi-Fi pourrait le lire. Pour un usage réel :
1. Placez HAISSEL derrière un reverse proxy TLS : Nginx ou Caddy, avec un certificat Let's Encrypt pour un nom de domaine, ou un certificat interne pour un réseau local.
2. Dans `.env` : `COOKIE_SECURE=true`. Le cookie devient alors `__Host-haissel_sid` avec `Secure`, et l'en-tête HSTS est envoyé.
3. Vérifiez que le proxy transmet l'adresse IP réelle comme décrit dans la section Docker (`PROXY_SHARED_SECRET`). N'activez pas `trust proxy` à l'aveugle.

### Secrets

- `APP_SECRET` (ou `JWT_SECRET`) : au moins 32 octets aléatoires, une valeur différente par serveur. Le serveur refuse de démarrer si la valeur est trop courte, ou si c'est une valeur d'exemple en production.
- Pour le générer en PowerShell : `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))`.
- Changer `APP_SECRET` invalide tous les jetons CSRF et rend illisibles les secrets de double authentification, sauf si `MFA_ENCRYPTION_KEY` est défini séparément. Dans ce cas, les utilisateurs doivent réactiver la double authentification.
- Aucun secret n'est versionné : `.env` est ignoré par Git. Si un secret a pu être exposé (capture d'écran, message, dépôt public), remplacez-le.

## Base de données et migrations

- `database/init.sql` : schéma de base (idempotent).
- `database/migrations/*.sql` : évolutions, appliquées dans l'ordre alphabétique.
- `npm run migrate` applique ce qui manque, chaque fichier dans une transaction, et enregistre son nom dans `schema_migrations`. Relancer la commande ne fait rien.
- Ne supprimez jamais la base ni le volume Docker pour « réparer » : ajoutez une nouvelle migration.
- `GET /api/health` renvoie `schema: "migrations_required"` si des tables manquent.

Tables principales : `users`, `sessions` (hash SHA-256 du jeton), `admins`, `affiliate_links` (offres), `user_affiliate_codes`, `clicks`, `conversions`, `earnings`, `admin_actions` (journal). La table `stats` est conservée pour compatibilité mais n'est plus utilisée : toutes les statistiques sont calculées à partir des tables sources, elles ne peuvent donc pas diverger.

## Limites de tentatives et réseaux partagés

HAISSEL s'adresse à des lycéens. Le Wi-Fi d'un établissement, un partage de
connexion ou un réseau mobile font sortir **des dizaines d'élèves par la même
adresse IP**. Une limite basse par IP bloquait alors toute une classe à cause
de l'usage normal de quelques-uns — un cours entier empêché de s'inscrire.

Les rôles sont donc séparés :

| Protection | Ce qu'elle suit | Valeur | Ce qu'elle arrête |
|---|---|---|---|
| Limite d'inscription | adresse IP | **30 par heure** | une inondation depuis une seule connexion |
| Limite de connexion | adresse IP, **échecs uniquement** | **30 par 15 min** | un balayage grossier d'identifiants |
| Ralentissement progressif | **le compte visé** | 0,5 s → 8 s après 3 échecs | le forçage d'un compte précis |

**La limite par IP n'est pas la protection principale.** C'est le ralentissement
progressif (`src/utils/login-throttle.js`) qui protège un compte donné : il suit
l'identifiant visé, pas l'adresse, donc changer d'IP n'y échappe pas. La limite
par IP ne sert qu'à écarter l'abus grossier, et elle peut donc rester large sans
affaiblir la sécurité.

Sur la connexion, seules les tentatives **échouées** sont comptées
(`skipSuccessfulRequests`) : trente élèves qui se connectent correctement
d'affilée ne consomment aucun crédit.

Pas de verrouillage de compte : une victime ne peut pas être bloquée
durablement par des tentatives malveillantes, elle subit au pire quelques
secondes d'attente.

## Âge des membres

HAISSEL vise des lycéens : une partie du public est mineure. Or **MyLead exige
18 ans pour ouvrir un compte éditeur**. Tout ce qui mène à ce compte, ou à un
lien affilié, est donc réservé aux membres ayant déclaré leur majorité.

> Référence du règlement MyLead : **à compléter** (date de la vérification).

### Ce qui est demandé, et ce qui est enregistré

Une seule question : **« As-tu 18 ans ou plus ? »**, oui ou non, obligatoire à
l'inscription. Les comptes créés avant la mise en place la reçoivent à leur
prochaine connexion, sur un écran qui couvre la page et n'offre pas de sortie.

**Aucune date de naissance n'est enregistrée, ni aucun âge** (RGPD art. 5-1-c,
minimisation). Deux colonnes seulement, ajoutées par la migration
`20261020_0008_adult_declaration.sql` :

| Colonne | Contenu |
|---|---|
| `users.is_adult` | `true`, `false`, ou `NULL` si la question n'a pas encore été posée |
| `users.adult_declared_at` | date de la réponse |

Une contrainte garantit que les deux vont toujours ensemble. La migration est
non destructive : colonnes nullables, aucune donnée existante modifiée.

C'est une **déclaration sur l'honneur**. Elle pose une limite nette et
traçable, elle ne prouve pas l'âge réel.

### Ce qui change selon la réponse

| | A déclaré 18 ans ou plus | A déclaré moins de 18 ans | N'a pas répondu |
|---|---|---|---|
| Guides et tutoriels (Apprendre) | oui | **oui** | oui |
| Opportunités (contenu pédagogique) | oui | **oui** | oui |
| Voir la liste des offres | oui | **oui** | oui |
| Parcours MyLead | oui | non | non |
| Lien de parrainage | oui | non | non |
| Publier ou modifier une offre | oui | non | non |
| Ouvrir un lien affilié | oui | non | non |
| Retirer sa propre offre | oui | **oui** | oui |

Le retrait reste toujours possible : on ne piège personne avec son propre
contenu.

### Comment le refus est appliqué

Le masquage dans l'interface n'est qu'un confort. La règle est tenue par le
serveur :

| Route | Refus |
|---|---|
| `POST /api/community/offers` | 403 `ADULT_REQUIRED` |
| `PATCH /api/community/offers/:id` | 403 `ADULT_REQUIRED` |
| `GET /api/learn/referral` | 403 `ADULT_REQUIRED` |
| `GET /api/community/offers/:id/open` | 403 `ADULT_REQUIRED` |
| `GET /go/:id` (lien de l'équipe) | 403 `ADULT_REQUIRED` |

Un compte qui n'a pas encore répondu reçoit `ADULT_DECLARATION_REQUIRED` : un
code distinct, pour que le message dise « réponds d'abord » et non « tu es
trop jeune ».

**L'adresse de destination n'est jamais envoyée à qui ne peut pas l'ouvrir.**
`GET /api/community/offers` renvoie `url: null` et `can_open: false` : masquer
un bouton ne suffirait pas, l'adresse serait lisible dans la réponse. Elle
n'est délivrée que par `/offers/:id/open`, après contrôle.

Le parcours MyLead (`frontend/mylead-guide.js`) est un contenu **statique**,
sans route serveur : il n'est masqué que dans l'interface. Rien à refuser côté
serveur, puisqu'il n'y a rien à demander.

### Âge minimum des offres

Une offre peut porter un `min_age`. La déclaration étant binaire, HAISSEL ne
peut certifier que « au moins 18 » :

- `min_age` de 18 ou moins : ouvrable par un majeur ;
- `min_age` supérieur à 18 (21, 25…) : **refusé à tous**, code
  `AGE_RESTRICTED`. Mieux vaut refuser que décider sur une donnée qu'on n'a
  pas. Pour l'autoriser, il faudrait collecter un âge précis — ce que cette
  conception évite délibérément.

Un majeur peut rouvrir **sa propre** offre malgré cette limite, pour la
relire. Cette dérogation ne s'applique pas à un mineur : il n'ouvre aucun lien
affilié, pas même le sien.

### Changer sa réponse

`POST /api/auth/adult-declaration` accepte une nouvelle réponse à tout moment,
horodatée et journalisée (`adult_declared` dans `security_events`). Un membre
de 17 ans qui en a 18 l'année suivante ne reste pas bloqué — et puisqu'il
s'agit déjà d'une déclaration sur l'honneur, la permettre n'affaiblit rien.

## Affiliation

> **Gelé par défaut.** Tout ce qui suit décrit le moteur d'affiliation interne,
> désactivé tant que `ENABLE_INTERNAL_AFFILIATION=true` n'est pas défini. Les
> redirections `/r/:code` restent actives. Voir
> [Moteur d'affiliation interne (gelé)](#moteur-daffiliation-interne-gelé).

1. L'admin crée une offre (URL http/https validée).
2. L'utilisateur clique sur **Obtenir mon lien** : un code `HAI-XXXXXXXX` unique est généré (`crypto.randomInt`, un seul code par utilisateur et par offre).
3. Le lien `http://IP:3000/r/HAI-XXXXXXXX` enregistre le clic côté serveur (IP tronquée + empreinte HMAC, dédoublonnage 10 min par visiteur), puis redirige vers l'URL **stockée en base** (pas d'open redirect). Les liens historiques `/api/affiliate/HAI-…` restent valides.
4. L'URL d'offre peut contenir `{click_id}` et `{code}`, remplacés à la redirection, pour que le partenaire puisse les renvoyer.
5. Le partenaire confirme la conversion via le webhook ; le gain est créé uniquement si la conversion est `approved`.

**Statuts.** Conversion : `pending → approved | rejected | cancelled`, puis `approved → cancelled` (seulement si le gain n'a pas encore été payé). `rejected` et `cancelled` sont des statuts définitifs. Gain : `pending` (dû) → `paid` (`paid_at` enregistré) ou `cancelled`.

Les montants sont des entiers en centimes (`4250` = 42,50 €), uniquement en EUR, plafonnés à 10 000 € par conversion.

### Webhook partenaire

```
POST /api/webhooks/affiliate/<fournisseur>
X-Haissel-Timestamp: <secondes UNIX>
X-Haissel-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<corps brut>")>
Content-Type: application/json

{ "external_reference": "ORDER-123", "code": "HAI-XXXXXXXX", "amount_cents": 1250,
  "currency": "EUR", "status": "approved", "click_id": 42 }
```

- La signature, l'horodatage (± 5 min) et le contenu sont vérifiés.
- **Idempotence** : `(fournisseur, external_reference)` est unique en base. Un événement reçu deux fois ne crée ni deuxième conversion ni deuxième gain. Un renvoi avec un autre statut applique la transition si elle est autorisée ; un renvoi avec un montant différent est refusé (`409`).
- `click_id`, s'il est fourni, doit appartenir au même code affilié.
- Conversion, gain et journal sont écrits dans une seule transaction PostgreSQL.

Test local : `node scripts/sign-webhook.js --provider partner --code HAI-XXXXXXXX --reference ORDER-1 --amount 1250 --status approved`

**Aucune route utilisateur ne peut créer de conversion.** L'ancien `POST /api/affiliate/conversion` a été supprimé. L'administration locale peut saisir une conversion confirmée hors webhook (fournisseur `manual`), avec les mêmes règles d'idempotence, et l'action est journalisée.

### Moteur d'affiliation interne (gelé)

**Pourquoi.** Le moteur décrit ci-dessus est complet côté code, mais **aucun
annonceur réel n'y est branché**. Le format de postback qu'il attend — un corps
JSON signé par l'en-tête `X-Haissel-Signature`, avec nos propres noms de champs —
est un format maison. Aucun réseau d'affiliation ne l'émet : un réseau envoie le
sien, généralement une requête **GET** avec ses propres variables
(`?transaction_id=…&payout=…&status=…`), et il ne signera pas avec notre secret.
Tant qu'aucun adaptateur ne traduit ces formats, les routes de conversion ne
peuvent rien recevoir de légitime — elles n'offrent qu'une surface d'attaque et
des écrans qui afficheraient toujours zéro.

**Ce que le gel change.** `ENABLE_INTERNAL_AFFILIATION` vaut `false` par défaut.

| Route | Gelée | Comportement |
|---|---|---|
| `GET /r/:code` | **non** | redirige et enregistre le clic, toujours |
| `GET /api/affiliate/HAI-…` (alias historique) | **non** | idem |
| `GET /api/affiliate/offers` | oui | 404 `FEATURE_DISABLED` |
| `POST /api/affiliate/offers/:id/link` | oui | 404 `FEATURE_DISABLED` |
| `GET /api/affiliate/stats` | oui | 404 `FEATURE_DISABLED` |
| `GET /api/affiliate/conversions` | oui | 404 `FEATURE_DISABLED` |
| `POST /api/webhooks/affiliate/:provider` | oui | 404 `FEATURE_DISABLED` |
| `GET POST PATCH /api/admin/conversions…` | oui | 404 `FEATURE_DISABLED` |
| `GET /api/admin/earnings`, `PATCH /api/admin/earnings/:id/pay` | oui | 404 `FEATURE_DISABLED` |
| `GET /api/admin/affiliates`, `/api/admin/clicks`, `/go/:id`, `/api/links` | **non** | catalogue de liens publiés : fonctionnalité distincte, active |

404 et non 403 : pour un appelant extérieur la fonctionnalité n'existe pas. Le
code `FEATURE_DISABLED` la distingue du `NOT_FOUND` générique, pour qu'un
administrateur lisant les journaux voie qu'il s'agit d'un drapeau à activer.

Les redirections ne sont **jamais** gelées : des liens ont pu être partagés
(message, réseau social, impression) et doivent continuer de mener à leur
destination, même si plus aucun code ne peut être créé.

**Aucune donnée n'est supprimée.** Les tables `user_affiliate_codes`, `clicks`,
`conversions` et `earnings` restent intactes, avec leur contenu. Le gel ne
s'accompagne d'aucune migration. Repasser le drapeau à `true` restaure l'état
exact d'avant.

**Pour le réactiver pour de bon**, il ne suffit pas de changer le drapeau : il
faut d'abord écrire un **adaptateur par réseau**, qui lit le format de *ce*
réseau au lieu de lui imposer le nôtre. Pour chaque réseau branché :

1. **Lire son postback tel qu'il l'envoie.** Relever dans sa documentation la
   méthode (le plus souvent `GET`), le nom de ses paramètres (identifiant de
   transaction, montant, devise, statut, et la variable qui nous renvoie notre
   `{code}` ou `{click_id}`), et ses valeurs de statut, qui ne sont pas les
   nôtres (`confirmed`, `1`, `approved`…).
2. **Authentifier à sa manière.** Presque aucun réseau ne signe en HMAC. Les
   moyens usuels sont un jeton secret dans l'URL, une liste d'adresses IP
   autorisées, ou un rappel sortant vers son API pour vérifier la transaction.
   Choisir celui qu'il propose ; ne pas se contenter d'un paramètre devinable.
3. **Traduire vers le modèle interne.** L'adaptateur produit la forme déjà
   utilisée par `webhook.controller` : `{ external_reference, code, amount_cents,
   currency, status, click_id }`. Les montants restent des entiers en centimes.
4. **Garder l'idempotence.** La contrainte d'unicité `(fournisseur,
   external_reference)` existe déjà : un même postback reçu deux fois ne doit
   créer ni deuxième conversion ni deuxième gain.
5. **Tester avec ses propres exemples**, pas avec notre format signé : reprendre
   les requêtes réelles de sa documentation.

La vérification de signature actuelle (`X-Haissel-Signature`) reste utilisable
telle quelle pour un partenaire qui accepterait de s'y plier, et pour le
fournisseur `manual` saisi depuis l'administration.

## Administration

Sections réellement présentes dans l'interface : Tableau de bord (chiffres réels), Liens (création, activation/désactivation ; aucune suppression, l'historique est conservé), Clics, Notifications (diffusion temps réel, voir ci-dessous), Offres membres (modération), Guides et tutoriels, Opportunités, Parrainage.

Conversions et Gains **n'ont pas d'écran** : seules les routes HTTP existent (`/api/admin/conversions`, `/api/admin/earnings`), et elles font partie du moteur gelé. La gestion des utilisateurs (suspendre, bannir) n'a pas non plus d'écran dédié ; la route `/api/admin/users` existe et reste active.

## Notifications administrateur (temps réel)

Section **Notifications** de la console d'administration : l'administrateur rédige un titre (80 caractères max.) et un message (500 max.), choisit éventuellement une destination interne (`/app`, `/mes-affilies`), confirme, puis le serveur transmet la notification aux utilisateurs **actuellement connectés**. Le résultat affiché est réel : utilisateurs connectés, utilisateurs ayant reçu la notification, onglets atteints, erreurs.

**Fonctionnement**

- Chaque page utilisateur ouverte et connectée ouvre un flux Server-Sent Events `GET /api/notifications/stream`, authentifié par le cookie de session existant. L'identité vient de la session côté serveur, jamais de l'adresse IP ni du navigateur. Il n'existe aucun ciblage par IP.
- Registre en mémoire : plusieurs onglets d'un même utilisateur sont plusieurs connexions, mais **un seul destinataire** dans les statistiques. Au-delà de 5 onglets (`REALTIME_MAX_PER_USER`), le plus ancien flux est fermé.
- Un battement (`: ping`) est envoyé toutes les 20 s. Les sessions des flux ouverts sont revérifiées toutes les 30 s **et juste avant chaque diffusion** : une session révoquée, expirée ou un compte suspendu ne reçoit plus rien, et son flux est fermé. La déconnexion (ou « tous les appareils ») ferme le flux immédiatement.
- Côté navigateur : reconnexion avec délai croissant (2 s → 60 s, avec aléa), 8 tentatives au maximum, puis bouton « Se reconnecter ». La session est revérifiée avant chaque tentative.
- Format d'un événement (`event: admin-notification`) : `{ id, title, message, url, sent_at }`. Aucun secret ni donnée personnelle. Le contenu est du **texte brut** affiché avec `textContent` ; aucune commande n'est transmise aux postes.

**Sécurité** : routes admin protégées par les middlewares existants (requête locale + session + rôle `ADMIN` lu en base + double authentification), jeton CSRF de session et contrôle d'origine sur `POST`, limitation à 5 diffusions/minute et 30/heure par administrateur, 30 ouvertures de flux/minute par adresse. Validation serveur : normalisation Unicode, suppression des caractères de contrôle et bidirectionnels, cible unique `connected_users`, liens internes en liste blanche.

**Notifications Windows (système)** : jamais demandées automatiquement. L'utilisateur clique sur « Activer les notifications Windows » (Profil, ou bouton en haut de page), puis peut cliquer « Tester une notification Windows » ; le statut affiché est *Activé*, *Refusé*, *Non configuré*, *Non pris en charge* ou *Indisponible (HTTPS requis)*, avec l'explication pour changer d'avis dans les paramètres du navigateur. Si l'utilisateur a autorisé les notifications, chaque message produit une vraie notification Windows (même si la page est au premier plan), sans encadré en double dans la page ; l'encadré « Message HAISSEL (dans la page) » ne sert que de secours (autorisation absente ou refusée, HTTP, échec). La notification est affichée via `new Notification(titre, { body })`, avec repli sur un service worker (`/sw.js`, `registration.showNotification()`) si le constructeur est indisponible. Une seule notification pour tous les onglets, au plus une toutes les 3 s. Si l'API échoue ou si le système refuse, l'erreur est affichée dans le Profil et aucun affichage n'est déclaré au serveur.

**Historique** (tables `notification_broadcasts` et `notification_recipients`, migration `20261011_0004_admin_notifications.sql`, non destructive) : émetteur, titre, contenu, date, utilisateurs connectés, utilisateurs ayant reçu, onglets, erreurs, statut (`delivered`, `partial`, `no_recipients`, `failed`). « Affichées » ne compte que les accusés envoyés par le navigateur après un affichage effectif ; ce n'est **pas** une preuve de lecture. Aucune adresse IP n'est enregistrée, et les connexions au flux ne sont pas journalisées.

**Limite — un seul processus** : le registre des connexions est en mémoire. Avec plusieurs processus Node (cluster, plusieurs conteneurs `app`), chaque processus ne verrait que ses propres flux. Le déploiement actuel (`npm start` ou un conteneur `app` derrière Nginx) n'en a qu'un. Pour passer à plusieurs instances, il faudrait relayer les diffusions entre processus (PostgreSQL `LISTEN/NOTIFY` ou Redis pub/sub) et additionner les statistiques.

### HTTPS sur le réseau local (requis pour les notifications système)

Les navigateurs n'autorisent l'API Notification que dans un **contexte sécurisé** : `https://…` ou `http://localhost`. Sur `http://192.168.x.x:3000`, les autres PC reçoivent les notifications **dans la page** seulement.

| Mode | Adresse | Notifications dans la page | Notifications système |
| --- | --- | --- | --- |
| HTTP (par défaut) | `http://localhost:3000` (serveur) | oui | oui |
| HTTP | `http://IP:3000` (autres PC) | oui | **non** |
| HTTPS (certificat de confiance) | `https://IP:3000` | oui | oui |

Mise en place avec [mkcert](https://github.com/FiloSottile/mkcert) (autorité de certification locale, réservée au réseau de test) :

```powershell
# Sur le serveur
winget install FiloSottile.mkcert
mkcert -install                                   # crée l'autorité locale
mkdir C:\haissel-certs
mkcert -cert-file C:\haissel-certs\haissel.pem -key-file C:\haissel-certs\haissel-key.pem 192.168.1.17 localhost 127.0.0.1
mkcert -CAROOT                                    # dossier contenant rootCA.pem
```

1. Remplacez `192.168.1.17` par l'IP du serveur (`ipconfig`). Si l'IP change, régénérez le certificat.
2. Dans `.env` : `HTTPS_CERT_FILE=C:\haissel-certs\haissel.pem`, `HTTPS_KEY_FILE=C:\haissel-certs\haissel-key.pem`, `COOKIE_SECURE=true`. Redémarrez : le journal affiche `https://`.
3. Sur **chaque PC de test** : copiez uniquement `rootCA.pem` (jamais `rootCA-key.pem`), puis `certutil -addstore -user Root rootCA.pem` (ou double-clic › Installer › « Autorités de certification racines de confiance »). Firefox : Paramètres › Certificats › Importer.
4. Ouvrez `https://192.168.1.17:3000` : aucun avertissement ne doit apparaître. Ne contournez jamais un avertissement de certificat.

Les certificats et clés restent **hors du dépôt** (`.gitignore` exclut `*.pem`, `*.key`, `*.crt`, `certs/`). `rootCA-key.pem` permet de signer des certificats acceptés par tous les PC de test : gardez-le sur le serveur uniquement, et désinstallez l'autorité (`mkcert -uninstall`) à la fin des tests. Avec Docker, placez le certificat dans Nginx (`listen 443 ssl;`, `ssl_certificate`…) et montez-le en volume depuis un dossier hors du dépôt.

### Tester sur deux PC du même réseau

1. Serveur : `npm run migrate`, puis `npm start` (en HTTPS de préférence, voir ci-dessus). Autorisez le port 3000 dans le pare-feu Windows (réseau privé).
2. PC B : ouvrez `https://IP_DU_SERVEUR:3000`, créez un compte ou connectez-vous. Dans **Profil**, « Canal temps réel » doit indiquer *Connecté* ; cliquez sur « Activer les notifications » et acceptez.
3. Serveur : `https://localhost:3000` › Notifications. Le compteur affiche 1 utilisateur connecté. Saisissez un titre et un message, « Envoyer », confirmez.
4. PC B : la notification apparaît dans la page (onglet visible) ou en notification système (onglet en arrière-plan, autre fenêtre au premier plan). Le panneau admin affiche le résultat ; la colonne « Affichées » de l'historique augmente après l'accusé.
5. Pour tester la reconnexion : débranchez le réseau de PC B quelques secondes, puis rebranchez (le statut repasse à *Connecté*). Pour tester la révocation : « Se déconnecter de tous les appareils » sur PC B ferme le flux immédiatement.

## Docker

```powershell
Copy-Item .env.production.example .env   # remplir les secrets ; DATABASE_URL avec l'hôte "db"
docker compose up --build -d
```

- `http://IP_DU_SERVEUR:3000` (port `PUBLIC_PORT`) : espace utilisateur, via Nginx.
- `http://localhost:3001` (port `ADMIN_PORT`, publié **uniquement sur 127.0.0.1**) : administration.
- Les migrations s'exécutent automatiquement au démarrage du conteneur `app`.
- Derrière Docker, l'adresse vue par Node est celle du proxy : Nginx s'authentifie avec `PROXY_SHARED_SECRET` et transmet l'IP réelle ; seul le bloc Nginx admin ajoute l'en-tête d'accès admin (les en-têtes envoyés par le client sont écrasés).
- Promotion admin : `docker compose exec app node scripts/promote-admin.js --username votre_nom`.

## Déploiement Vercel

Sur Vercel, l'application ne tourne pas dans un processus permanent : **plusieurs
instances répondent en parallèle, sans mémoire partagée et sans rien conserver
entre deux requêtes**. Trois mécanismes qui supposaient un processus unique ont
donc un fonctionnement différent en ligne. En local et sous Docker, rien ne
change : un seul processus, comportement d'origine.

Le mode est détecté par la variable `VERCEL=1`, que Vercel définit elle-même.

### Limites de tentatives : compteurs en base

| | Local / Docker | Vercel |
|---|---|---|
| `express-rate-limit` | mémoire du processus | table `rate_limit_counters` |
| Ralentissement par compte (`login-throttle`) | mémoire du processus | table `login_throttle_failures` |

En mémoire, chaque instance ne compte que les requêtes qu'elle a reçues : la
limite réelle devient « limite × nombre d'instances », et le ralentissement
progressif après 3 échecs se trouve divisé d'autant. Les deux tables sont
créées par la migration `20261020_0007_distributed_counters.sql` et purgées par
la tâche de rétention.

Si PostgreSQL ne répond pas, les compteurs laissent passer la requête plutôt que
de renvoyer une erreur : la limite générale s'applique à **toutes** les routes, y
compris les pages statiques qui fonctionnent sans base, et une coupure ne doit
pas rendre le site entièrement indisponible. Les routes sensibles lisent de
toute façon la session en base, donc elles échouent d'elles-mêmes.

### Notifications : interrogation régulière au lieu du flux SSE

Le flux Server-Sent Events reste le canal en local et sous Docker. En ligne il
ne peut pas fonctionner : l'instance qui tient le flux ouvert n'est pas celle
qui reçoit la demande de diffusion, et elle n'en est pas informée.

En ligne, le navigateur appelle donc `GET /api/notifications/poll?since=<curseur>`
**toutes les 45 s, uniquement quand l'onglet est visible**. La réponse ne contient
que les diffusions postérieures au curseur. Un premier appel sans `since`
n'affiche rien : il fixe le point de départ, pour que l'ouverture d'un onglet ne
déverse pas tout l'historique — même comportement que le SSE, qui ne délivre que
ce qui passe pendant que la page est ouverte.

Deux conséquences visibles dans la console d'administration :

- **Le comptage des utilisateurs connectés n'est pas disponible.** Aucune
  instance ne connaît les onglets ouverts par les autres. La console l'indique
  explicitement au lieu d'afficher le compte partiel d'une instance, qui serait
  faux.
- **Les destinataires d'une diffusion sont les membres dont la session est
  valide**, et non ceux qui ont un onglet ouvert. C'est le seul équivalent
  calculable sans mémoire partagée, mais le périmètre est plus large :
  quelqu'un dont l'onglet est fermé mais la session encore valide verra la
  notification à sa prochaine visite, dans les 45 s.

### Tâche de rétention : déclenchée par le planificateur

`startRetentionJob()` (un `setInterval`) n'existe que dans le processus lancé par
`npm start` ou Docker, donc la purge RGPD ne tournerait jamais en ligne. Elle est
appelée par le planificateur de Vercel, déclaré dans `vercel.json` :

```json
"crons": [{ "path": "/api/internal/retention", "schedule": "0 3 * * *" }]
```

La route accepte `GET` et `POST` : les crons Vercel n'émettent que des `GET`,
un appel manuel est plus naturel en `POST`. Elle est authentifiée par
`Authorization: Bearer ${CRON_SECRET}` (comparaison à temps constant), en dehors
de toute session. **Sans `CRON_SECRET` défini, elle répond 404** et ne révèle pas
son existence — mais la purge ne tourne alors pas : la variable est obligatoire
en ligne. Vercel ajoute l'en-tête de lui-même dès que la variable existe dans le
projet.

Vérification manuelle :

```powershell
curl -X POST https://votre-projet.vercel.app/api/internal/retention `
  -H "Authorization: Bearer $env:CRON_SECRET"
```

### Variables à renseigner dans le tableau de bord Vercel

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DATABASE_URL` | oui | PostgreSQL géré (Neon, Supabase…), avec `sslmode=require` |
| `APP_SECRET` | oui | secret maître, ≥ 32 octets aléatoires |
| `CRON_SECRET` | oui | authentifie le cron de rétention ; sans elle, pas de purge RGPD |
| `COOKIE_SECURE` | oui | `true` (Vercel sert toujours en HTTPS) |
| `NODE_ENV` | oui | `production` |
| `ADMIN_IP_ALLOWLIST` | fortement recommandé | restreint l'administration à vos adresses IP ; vide = toute adresse |
| `APP_PUBLIC_URL` | si e-mails | base des liens de vérification et de réinitialisation |
| `MAIL_TRANSPORT`, `MAIL_FROM`, `SMTP_*` | si e-mails | sans quoi vérification d'adresse et « mot de passe oublié » sont désactivés |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | recommandé | anti-robot ; les deux ou aucune |
| `AFFILIATE_WEBHOOK_SECRET` | si webhooks | signature HMAC des webhooks partenaires |
| `MFA_ENCRYPTION_KEY` | optionnel | clé de chiffrement TOTP distincte (dérivée d'`APP_SECRET` sinon) |

`ADMIN_REQUIRE_MFA` est sans effet en ligne : la double authentification des
administrateurs y est imposée. `PROXY_SHARED_SECRET`, `PUBLIC_PORT`,
`ADMIN_PORT`, `HTTPS_CERT_FILE` et `HTTPS_KEY_FILE` ne servent qu'au
déploiement local ou Docker.

Après un premier déploiement, appliquer les migrations une fois (la base est
externe, le conteneur `app` de Docker ne s'en charge pas ici) :

```powershell
$env:DATABASE_URL = "postgres://..."   # même valeur que sur Vercel
npm run migrate
```

## Tests

```powershell
npm test                    # vérification de syntaxe + tous les tests
npm run test:unit           # sans base de données
npm run test:integration    # PostgreSQL requis
npx jest tests/auth.test.js  # tests de sécurité de l'authentification
```

Les tests d'intégration utilisent `DATABASE_URL` (ou `TEST_DATABASE_URL`), dans un **schéma temporaire** `haissel_test_*` créé puis supprimé : les données réelles ne sont ni lues ni modifiées. Ils couvrent l'authentification, les droits admin (utilisateur → 403, accès depuis le LAN → 403), les offres, les clics et la redirection, les webhooks (signature, horodatage, altération du corps, doublons concurrents), les transitions de statut, les gains, les statistiques, l'injection SQL, les montants invalides et le rate limiting.

## Anciennes fonctionnalités du réseau social

HAISSEL a d'abord été un réseau social (publications, commentaires, mentions
« j'aime », abonnements, messagerie, profils publics, signalements). **Ce code a
été supprimé** : contrôleurs, routes et drapeau `ENABLE_LEGACY_SOCIAL_API`.
L'interface ne les appelait plus, et aucun module actif ne les importait.

### Tables restées en base

**Aucune table n'a été supprimée** et aucune migration ne les touche. Elles ne
sont plus lues ni écrites par le code :

| Table | Contenu d'origine |
|---|---|
| `posts` | publications |
| `comments` | commentaires de publications |
| `likes` | mentions « j'aime » |
| `follows` | abonnements entre comptes |
| `conversations` | fils de messagerie privée |
| `conversation_members` | participants d'un fil |
| `messages` | messages privés |
| `notifications` | notifications de l'ancien réseau (à ne pas confondre avec `notification_broadcasts` / `notification_recipients`, qui servent au centre de notifications **actuel**) |
| `reports` | signalements de publications (à ne pas confondre avec `member_offer_reports`, qui sert à la modération **actuelle** des offres membres) |

La table `users` n'est pas dans cette liste : elle reste au cœur de
l'authentification.

Ces tables peuvent être conservées (elles ne coûtent qu'un peu d'espace) ou
supprimées plus tard par une migration dédiée, après sauvegarde. Rien dans le
code ne s'y oppose. Attention à l'ordre des clés étrangères si vous les
supprimez : `comments`, `likes` et `messages` référencent `posts` et
`conversations`.

Pour retrouver ce code, consultez l'historique Git avant la suppression.
