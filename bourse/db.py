"""Accès SQLite : utilisateurs, sessions, favoris, préférences."""

import logging
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from . import config

log = logging.getLogger("bourse.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    settings      TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS favorites (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    name       TEXT NOT NULL,
    quote_type TEXT,
    exchange   TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, symbol)
);
"""


def _connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _secure_permissions() -> None:
    """Base et dossier lisibles uniquement par l'utilisateur qui fait tourner le serveur."""
    try:
        os.chmod(config.DB_PATH.parent, 0o700)
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(config.DB_PATH) + suffix)
            if path.exists():
                os.chmod(path, 0o600)
    except OSError as exc:
        log.warning("Impossible de restreindre les droits de %s : %s", config.DB_PATH, exc)


def _migrate(conn: sqlite3.Connection) -> None:
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "last_login_at" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN last_login_at INTEGER")
    # Avant l'arrivée de l'administration web, aucun compte n'était administrateur :
    # le plus ancien compte le devient pour qu'il reste possible de gérer les utilisateurs.
    if not conn.execute("SELECT 1 FROM users WHERE is_admin = 1").fetchone():
        row = conn.execute("SELECT id, username FROM users ORDER BY created_at, id LIMIT 1").fetchone()
        if row:
            conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (row["id"],))
            log.warning("Aucun administrateur : « %s » est promu administrateur.", row["username"])


def init_db() -> None:
    old_umask = os.umask(0o077)  # fichiers créés en 600 / dossiers en 700
    try:
        with connect() as conn:
            conn.executescript(SCHEMA)
            _migrate(conn)
    finally:
        os.umask(old_umask)
    _secure_permissions()
