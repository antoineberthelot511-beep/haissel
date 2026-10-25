# HAISSEL : consignes de travail

## Branches

- Travailler **toujours sur la branche `dev`**, sauf demande contraire explicite.
- **Un commit par tâche**, puis **push sur `dev`** (`git push origin dev`).
- Ne jamais pousser directement sur `main`. La mise en production se fait par une **Pull Request de `dev` vers `main`**, à la demande.
- Si la session démarre sur une autre branche, revenir sur `dev` (`git switch dev`, puis `git pull`) avant de modifier quoi que ce soit.

## Avant chaque commit

- `npm test` doit passer.
- Migrations : jamais destructives (aucune suppression de données ni de colonne), réexécutables.
- Aucune valeur secrète, adresse IP ou e-mail personnel dans le code, le README ou les commits.

## Langue

- Échanges, textes de l'interface et messages de commit en français ; interface au tutoiement.
