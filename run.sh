#!/usr/bin/env bash
# Lance le serveur Bourse (crée l'environnement virtuel au premier lancement).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "Création de l'environnement virtuel…"
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
fi
if [ requirements.txt -nt .venv/.installed ] || [ ! -f .venv/.installed ]; then
  .venv/bin/pip install -r requirements.txt
  touch .venv/.installed
fi

exec .venv/bin/python -m bourse "$@"
