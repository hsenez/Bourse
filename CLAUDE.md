# CLAUDE.md — Projet Bourse

Ce fichier conserve **toutes les instructions et décisions** de l'utilisateur pour ce projet.
**Règle pour Claude : à chaque nouvelle instruction ou décision de l'utilisateur, mettre à jour ce fichier**
(section « Cahier des charges » si l'exigence change, et ajouter une entrée datée au « Journal des instructions »).
Ne jamais supprimer une instruction : la marquer comme remplacée si elle évolue.

## Conventions de travail

- Toujours répondre en **français** (accents corrects) ; le code et les identifiants restent en anglais, les
  commentaires et textes d'interface en français.
- Le projet est suivi avec **git** (branche `main`). Messages de commit en français.
- Environnement virtuel Python dans `.venv/` (jamais commité), dépendances figées dans `requirements.txt`.
- Les données locales (`data/`, `.env`, bases SQLite) ne sont jamais commitées.
- Fichiers temporaires et tests visuels : dans le scratchpad, pas dans le projet.

## Cahier des charges (état actuel)

### Serveur
- Programme Python avec environnement virtuel, serveur web tournant sous **Linux**, port **9699**.
- Accessible depuis un **navigateur** et depuis un **téléphone** ; affichage ajusté et ergonomique pour les deux.
- Serveur destiné à être **exposé sur Internet** → authentification obligatoire, HTTPS via reverse proxy
  recommandé (voir `deploy/Caddyfile.example`), pas d'inscription publique.

### Données
- Valeurs des indices récupérées via l'API d'un site boursier sérieux : **Yahoo Finance** (bibliothèque `yfinance`),
  choisi par l'utilisateur. Dépendance au fournisseur isolée dans `bourse/market.py`.
- Recherche sur **tout instrument** (indices, actions, ETF, devises, cryptos), les indices mis en avant.

### Utilisateurs et favoris
- **Aucun indice suivi par défaut** ; l'utilisateur recherche des indices et les enregistre comme **favoris**.
- Favoris **côté serveur, par utilisateur** (comptes avec identifiant / mot de passe), donc synchronisés entre appareils.
- Comptes gérés **depuis l'interface web** (demande du 2026-11-07, remplace la gestion uniquement en ligne de commande) :
  - rôle **administrateur** : créer, renommer, réinitialiser le mot de passe, donner/retirer le rôle admin,
    fermer les sessions, supprimer un compte ; le dernier administrateur est protégé ;
  - chaque utilisateur change son propre mot de passe depuis le menu de son compte ;
  - base vide : la page de connexion propose de créer le premier compte administrateur (réseau local uniquement).
- La ligne de commande reste disponible (`python -m bourse.cli adduser|passwd|admin|deluser|users`).
- Stockage : SQLite `data/bourse.db` (droits 600), mots de passe en Argon2id, jetons de session stockés hachés (SHA-256).

### Graphique
- Interface principale : un graphique de la valeur d'un indice au cours du temps.
- **Par défaut : courbe très simple** (valeur dans le temps uniquement).
- Affichages optionnels typiques de la bourse, **masqués par défaut** : chandeliers, volume, moyennes mobiles
  20/50/200, bandes de Bollinger, variation en %, échelle logarithmique.
- **Période ajustable** (choix initial laissé à Claude, modifiable plus tard) : boutons 1J, 5J, 1M, 6M, YTD, 1A, 5A, Max —
  au-dessus du graphique sur ordinateur, en bas (à portée de pouce) sur téléphone.
- **Zoom** :
  - navigateur : **molette** de la souris ; **clic molette + rectangle** pour zoomer sur une zone précise
    (Maj + glisser en alternative) ;
  - téléphone : **pincement à deux doigts** ;
  - réinitialisation : double-clic / double-tap ou bouton « Réinitialiser le zoom ».

## Architecture (résumé)

- `bourse/app.py` FastAPI (pages, API JSON, CSRF, en-têtes de sécurité) — `bourse/auth.py` Argon2, sessions,
  anti force brute — `bourse/market.py` yfinance + cache — `bourse/db.py` SQLite — `bourse/cli.py` comptes.
- `bourse/static/` : HTML/CSS/JS sans build, ECharts 5.5.1 servi localement (pas de CDN, CSP stricte).
- Lancement : `./run.sh` (crée le venv si besoin) ou `.venv/bin/python -m bourse`. Configuration : `.env` (voir `.env.example`).
- Déploiement : `deploy/bourse.service` (systemd utilisateur), `deploy/Caddyfile.example` (HTTPS).

## Pistes notées (non demandées explicitement)

- Réordonner les favoris par glisser-déposer (l'API `PUT /api/favorites/order` existe).
- Comparaison de plusieurs indices, plage de dates personnalisée, RSI / MACD.

## Journal des instructions

| Date | Instruction / décision |
|---|---|
| 2026-11-07 | Demande initiale : programme Python + venv, serveur web Linux port 9699, suivi git (initié par Claude), accès navigateur et téléphone avec affichage ergonomique, graphique d'un indice boursier via une API sérieuse, période ajustable (choix laissé à Claude), aucun indice par défaut, recherche + favoris, courbe simple par défaut avec affichages optionnels masqués, zoom molette / clic molette + rectangle / pincement. |
| 2026-11-07 | Réponses aux questions : source **Yahoo Finance** ; favoris **côté serveur, par utilisateur** ; serveur **exposé sur Internet** ; recherche sur **tout instrument**. |
| 2026-11-07 | Créer un fichier `CLAUDE.md` qui suit toutes les instructions de l'utilisateur (ce fichier). |
| 2026-11-07 | Expliquer le stockage des utilisateurs / mots de passe et sa robustesse. Pouvoir **créer et modifier les utilisateurs depuis l'interface web** plutôt qu'en ligne de commande → rôle administrateur, écran « Gérer les utilisateurs », création du premier compte depuis la page de connexion. Droits du fichier de base restreints à 600. |
