# Bourse

Petit serveur web (Linux, port **9699**) pour suivre des indices boursiers depuis un navigateur ou un téléphone.

- Graphique simple du cours dans le temps, période réglable (1J, 5J, 1M, 6M, YTD, 1A, 5A, Max).
- Zoom : molette de la souris, clic molette (ou Maj) + glisser pour zoomer sur une zone, pincement à deux doigts sur téléphone. Double-clic / double-tap pour réinitialiser.
- Recherche d'instruments (indices en priorité, mais aussi actions, ETF, devises, cryptos) et favoris **par utilisateur**, synchronisés entre appareils.
- Affichages optionnels (désactivés par défaut) : chandeliers, volume, moyennes mobiles 20/50/200, bandes de Bollinger, variation en %, échelle logarithmique.
- Données : Yahoo Finance via [yfinance](https://github.com/ranaroussi/yfinance) (gratuit, sans clé ; API non officielle, données parfois différées).

## Installation

Prérequis : Python 3.11+.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # puis adapter si besoin
```

(`./run.sh` fait tout cela automatiquement au premier lancement.)

## Comptes utilisateurs

Il n'y a pas d'inscription publique (le serveur est prévu pour être exposé sur Internet).

**Depuis l'interface web** (recommandé) :

- **Première utilisation** : si la base est vide, la page de connexion propose de créer le compte
  administrateur. Cette création n'est acceptée que depuis le réseau local (ou la machine elle-même).
- **Administrateurs** : menu du compte (en bas de la barre latérale) > *Gérer les utilisateurs*. On peut y créer
  un compte, le renommer, réinitialiser son mot de passe, lui donner ou retirer les droits d'administration,
  fermer toutes ses sessions, ou le supprimer. Le dernier administrateur ne peut être ni rétrogradé ni supprimé.
- **Chaque utilisateur** : menu du compte > *Changer mon mot de passe*.

**En ligne de commande** (toujours disponible, utile en dépannage) :

```bash
.venv/bin/python -m bourse.cli adduser hubert [--admin]   # créer (mot de passe demandé, 10 caractères min.)
.venv/bin/python -m bourse.cli passwd hubert              # changer un mot de passe (ferme ses sessions)
.venv/bin/python -m bourse.cli admin hubert [--off]       # donner / retirer les droits d'administration
.venv/bin/python -m bourse.cli deluser hubert             # supprimer (avec ses favoris)
.venv/bin/python -m bourse.cli users                      # lister
```

### Stockage des comptes

Tout est dans la base SQLite `data/bourse.db` (droits `600`, dossier `700` : lisible uniquement par l'utilisateur
qui fait tourner le serveur) :

- `users` : nom, **empreinte Argon2id** du mot de passe (jamais le mot de passe lui-même), rôle administrateur,
  préférences d'affichage, dates de création et de dernière connexion ;
- `sessions` : **empreinte SHA-256** du jeton de session (le jeton lui-même n'existe que dans le cookie du navigateur),
  date d'expiration (30 jours), navigateur ;
- `favorites` : favoris de chaque utilisateur.

Sauvegarder ce fichier suffit à sauvegarder tous les comptes et favoris.

## Lancement

```bash
./run.sh
```

Puis ouvrir `http://localhost:9699` ou, depuis le téléphone sur le même Wi-Fi, `http://<IP-du-PC>:9699` (`ip -4 addr` pour trouver l'IP). Sur le téléphone, « Ajouter à l'écran d'accueil » donne une icône en plein écran.

Si un pare-feu est actif (`ufw`, `firewalld`), autoriser le port 9699 pour le réseau local.

### Démarrage automatique (systemd utilisateur)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/bourse.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bourse
loginctl enable-linger $USER        # démarre même sans session ouverte
journalctl --user -u bourse -f      # journaux
```

## Exposition sur Internet

**Ne pas exposer le port 9699 en HTTP simple sur Internet** : les mots de passe et cookies circuleraient en clair.

### Option retenue : Cloudflare Tunnel

Aucun port à ouvrir sur la box : `cloudflared`, installé sur ce PC, établit une connexion sortante vers Cloudflare,
qui fournit le HTTPS et renvoie les visiteurs dans ce tunnel jusqu'à `127.0.0.1:9699`. Mode d'emploi dans
`deploy/cloudflared.example.yml`. Dans `.env`, garder `BOURSE_FORWARDED_ALLOW_IPS=127.0.0.1` ; Bourse reçoit
alors la vraie IP des visiteurs (`X-Forwarded-For`) et sait que la connexion d'origine est en HTTPS (cookie `Secure`, HSTS).

À savoir : Cloudflare déchiffre le trafic à son niveau (il voit passer les mots de passe), et l'accès dépend de son service.

### Alternative : reverse proxy sur ce PC

Montage :

1. Un nom de domaine pointant vers votre IP publique (par ex. gratuit avec DuckDNS).
2. Sur la box : rediriger les ports **80 et 443** (pas 9699) vers ce PC.
3. Un reverse proxy HTTPS avec certificat automatique, par exemple Caddy : voir `deploy/Caddyfile.example`.
4. Dans `.env` : `BOURSE_HOST=127.0.0.1` pour que le serveur ne soit joignable que via le proxy.

Le cookie de session passe automatiquement en `Secure` quand la requête arrive en HTTPS (`BOURSE_COOKIE_SECURE=auto`).

Alternative sans proxy : `BOURSE_SSL_CERTFILE` / `BOURSE_SSL_KEYFILE` dans `.env` pour que le serveur parle HTTPS directement.

### Sécurité en place

- Mots de passe hachés avec Argon2 ; sessions aléatoires stockées hachées en base, cookie `HttpOnly` + `SameSite=Lax`.
- Anti force brute : blocage temporaire après 5 échecs en 15 min (par IP et par utilisateur), y compris sur la saisie du mot de passe actuel lors d'un changement.
- Protection CSRF (en-tête obligatoire + vérification de l'origine) sur toutes les requêtes qui modifient des données.
- En-têtes de sécurité (CSP stricte, `X-Frame-Options`, HSTS en HTTPS…), aucune ressource externe (ECharts est servi localement).

## Architecture

```
bourse/
  __main__.py     lancement d'uvicorn (python -m bourse)
  app.py          application FastAPI : pages, API JSON, sécurité
  auth.py         comptes, mots de passe, sessions, anti force brute
  market.py       accès Yahoo Finance + cache mémoire (seul module lié au fournisseur)
  db.py           SQLite (data/bourse.db)
  cli.py          gestion des comptes
  config.py       configuration (.env)
  static/         interface : HTML/CSS/JS sans étape de build, ECharts 5.5.1 en local
deploy/           service systemd, exemples Cloudflare Tunnel et Caddy
```

API (toutes les routes demandent une session, sauf `/api/login` et `/api/setup`) :

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/login`, `/api/logout` | connexion / déconnexion |
| GET/POST | `/api/setup` | création du premier compte administrateur (base vide, réseau local) |
| GET/POST/PATCH/DELETE | `/api/admin/users[/{id}]` | gestion des comptes (administrateurs) ; `POST …/{id}/logout` ferme ses sessions |
| GET | `/api/search?q=` | recherche d'instruments |
| GET | `/api/history/{symbole}?period=1y` | historique (`1d 5d 1mo 6mo ytd 1y 5y max`) |
| GET | `/api/quotes?symbols=a,b` | dernier cours et variation du jour |
| GET/POST/DELETE | `/api/favorites[/{symbole}]` | favoris ; `PUT /api/favorites/order` pour l'ordre |
| GET/PUT | `/api/settings` | préférences d'affichage de l'utilisateur |

Pour changer de fournisseur de données, réimplémenter `search`, `history` et `quotes` dans `market.py` avec le même format de sortie.

## Pistes pour la suite

- Réordonner les favoris par glisser-déposer (l'API existe déjà).
- Comparer plusieurs indices sur un même graphique (en %).
- Plage de dates personnalisée, autres indicateurs (RSI, MACD).
