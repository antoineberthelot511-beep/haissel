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

Sections disponibles : Dashboard (chiffres réels), Utilisateurs (recherche, suspendre/réactiver, bannir/débannir, avec confirmation ; la suspension révoque les sessions ; impossible de se suspendre soi-même), Offres (création, activation/désactivation ; aucune suppression, l'historique est conservé), Conversions (filtres par statut, offre, utilisateur et dates ; transitions contrôlées), Gains (totaux, marquer comme payé), Clics, Journal des actions admin.

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
```

Les tests d'intégration utilisent `DATABASE_URL` (ou `TEST_DATABASE_URL`), dans un **schéma temporaire** `haissel_test_*` créé puis supprimé : les données réelles ne sont ni lues ni modifiées. Ils couvrent l'authentification, les droits admin (utilisateur → 403, accès depuis le LAN → 403), les offres, les clics et la redirection, les webhooks (signature, horodatage, altération du corps, doublons concurrents), les transitions de statut, les gains, les statistiques, l'injection SQL, les montants invalides et le rate limiting.

## Anciennes fonctionnalités du réseau social

Les contrôleurs, routes et tables `posts`, `comments`, `likes`, `follows`, `messages`, `notifications` et `reports` existent encore, mais l'interface ne les utilise plus. Leurs API sont désactivées par défaut (`ENABLE_LEGACY_SOCIAL_API=false`) ; aucune table n'a été supprimée.
