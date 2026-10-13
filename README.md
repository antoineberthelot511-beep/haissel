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
| `ENABLE_LEGACY_SOCIAL_API` | `true` pour réactiver les anciennes API du réseau social |

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

## Affiliation

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

## Administration

Sections disponibles : Dashboard (chiffres réels), Utilisateurs (recherche, suspendre/réactiver, bannir/débannir, avec confirmation ; la suspension révoque les sessions ; impossible de se suspendre soi-même), Offres (création, activation/désactivation ; aucune suppression, l'historique est conservé), Conversions (filtres par statut, offre, utilisateur et dates ; transitions contrôlées), Gains (totaux, marquer comme payé), Clics, Journal des actions admin, Notifications (diffusion temps réel, voir ci-dessous).

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

## Tests

```powershell
npm test                    # vérification de syntaxe + tous les tests
npm run test:unit           # sans base de données
npm run test:integration    # PostgreSQL requis
npx jest tests/auth.test.js  # tests de sécurité de l'authentification
```

Les tests d'intégration utilisent `DATABASE_URL` (ou `TEST_DATABASE_URL`), dans un **schéma temporaire** `haissel_test_*` créé puis supprimé : les données réelles ne sont ni lues ni modifiées. Ils couvrent l'authentification, les droits admin (utilisateur → 403, accès depuis le LAN → 403), les offres, les clics et la redirection, les webhooks (signature, horodatage, altération du corps, doublons concurrents), les transitions de statut, les gains, les statistiques, l'injection SQL, les montants invalides et le rate limiting.

## Anciennes fonctionnalités du réseau social

Les contrôleurs, routes et tables `posts`, `comments`, `likes`, `follows`, `messages`, `notifications` et `reports` existent encore, mais l'interface ne les utilise plus. Leurs API sont désactivées par défaut (`ENABLE_LEGACY_SOCIAL_API=false`) ; aucune table n'a été supprimée.
