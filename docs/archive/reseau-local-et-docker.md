# Archive : réseau local et Docker

Ancien fonctionnement de HAISSEL, avant le déploiement sur Vercel. Ces sections ont été retirées du README telles quelles. Voir aussi [MODE_D_EMPLOI_SERVEUR.txt](MODE_D_EMPLOI_SERVEUR.txt).

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


### Activer HTTPS (production)

En HTTP sur le réseau local, le cookie de session circule en clair : quelqu'un qui écoute le Wi-Fi pourrait le lire. Pour un usage réel :
1. Placez HAISSEL derrière un reverse proxy TLS : Nginx ou Caddy, avec un certificat Let's Encrypt pour un nom de domaine, ou un certificat interne pour un réseau local.
2. Dans `.env` : `COOKIE_SECURE=true`. Le cookie devient alors `__Host-haissel_sid` avec `Secure`, et l'en-tête HSTS est envoyé.
3. Vérifiez que le proxy transmet l'adresse IP réelle comme décrit dans la section Docker (`PROXY_SHARED_SECRET`). N'activez pas `trust proxy` à l'aveugle.


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

