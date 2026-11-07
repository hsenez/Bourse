"""Configuration de l'application, lue depuis les variables d'environnement (ou le fichier .env)."""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "oui"}


HOST = os.getenv("BOURSE_HOST", "0.0.0.0")
PORT = int(os.getenv("BOURSE_PORT", "9699"))

DB_PATH = Path(os.getenv("BOURSE_DB", str(BASE_DIR / "data" / "bourse.db")))

# Cookie "Secure" : "auto" = activé si la requête arrive en HTTPS (directement ou via le reverse proxy).
COOKIE_SECURE = os.getenv("BOURSE_COOKIE_SECURE", "auto").strip().lower()
SESSION_DAYS = int(os.getenv("BOURSE_SESSION_DAYS", "30"))

# Adresses des reverse proxies dont on accepte les en-têtes X-Forwarded-For / X-Forwarded-Proto.
FORWARDED_ALLOW_IPS = os.getenv("BOURSE_FORWARDED_ALLOW_IPS", "127.0.0.1")

# HTTPS direct (optionnel, si pas de reverse proxy).
SSL_CERTFILE = os.getenv("BOURSE_SSL_CERTFILE") or None
SSL_KEYFILE = os.getenv("BOURSE_SSL_KEYFILE") or None

# Anti force brute sur la connexion.
LOGIN_MAX_FAILURES = int(os.getenv("BOURSE_LOGIN_MAX_FAILURES", "5"))
LOGIN_WINDOW_SECONDS = int(os.getenv("BOURSE_LOGIN_WINDOW_SECONDS", "900"))

LOG_LEVEL = os.getenv("BOURSE_LOG_LEVEL", "info")
DEBUG = _bool("BOURSE_DEBUG", False)
