# lycee-social

Application de réseau social privée destinée à un lycée, avec infrastructure Docker prête pour le développement et la production.

## Prérequis

- Docker Desktop ou Docker Engine
- Docker Compose
- Git

## Installation

1. Clonez le dépôt.
2. Créez votre fichier `.env` à partir de l'exemple :
   ```powershell
   Copy-Item .env.example .env
   ```
3. Ajustez les variables dans `.env` selon votre environnement local.
4. Lancez le projet :
   ```powershell
   docker compose up --build
   ```

## Démarrage

```powershell
docker compose up --build
docker compose up
```

## Arrêt

```powershell
docker compose down
```

## Vérification

- Application : http://localhost/
- Santé : http://localhost/api/health

## Commandes utiles

```powershell
docker compose ps
docker compose logs
docker compose logs app
docker compose logs db
docker compose logs nginx
docker compose config
```

## Architecture

- Nginx : point d'entrée public
- Express : backend sur le port interne 3000
- PostgreSQL : base de données interne, avec volume persistant et initialisation automatique via `database/init.sql`

## Base de données

La base PostgreSQL est initialisée au démarrage par le script `database/init.sql` et persiste via le volume Docker `postgres_data`.

## Variables d'environnement

- `.env` : secrets locaux, non versionné
- `.env.example` : modèle de configuration
- `.env.production.example` : exemple de configuration de production
- `JWT_SECRET` doit contenir au moins 32 octets aléatoires. Le serveur refuse de démarrer sans cette variable.
- En production, remplacez toutes les valeurs d'exemple et définissez un mot de passe PostgreSQL fort.

## Sessions et contenu

- Les jetons de session sont enregistrés sous forme de hash dans PostgreSQL et peuvent être révoqués à la déconnexion.
- Les comptes désactivés ou bannis ne peuvent pas utiliser un jeton existant.
- Les entrées du fil sont échappées avant affichage dans le navigateur ; le fil ne crée pas de publications de démonstration.
- Les listes de publications et de commentaires sont paginées.
- Le script `database/init.sql` ne s'exécute automatiquement que lors de la création d'un nouveau volume PostgreSQL. Les évolutions ultérieures de schéma doivent faire l'objet de migrations explicites ; ne supprimez pas le volume pour appliquer une migration, car cela effacerait les données.

## Déploiement sur un petit PC

1. Récupérez le dépôt GitHub
2. Copiez les variables de production dans un `.env` spécifique
3. Lancez :
   ```powershell
   docker compose up --build -d
   ```

L'application est conçue pour être déployée sur un petit serveur avec Docker et Docker Compose sans installation manuelle de Node.js ou PostgreSQL.
