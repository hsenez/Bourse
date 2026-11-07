"""Authentification : comptes, mots de passe (Argon2), sessions et protection anti force brute."""

import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from . import config
from .db import connect

_hasher = PasswordHasher()
# Hash factice pour que la vérification d'un utilisateur inexistant prenne le même temps.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))

COOKIE_NAME = "bourse_session"
MIN_PASSWORD_LENGTH = 10


@dataclass
class User:
    id: int
    username: str
    is_admin: bool


class AuthError(Exception):
    pass


# --------------------------------------------------------------------------- comptes

def _validate_username(username: str) -> str:
    username = username.strip()
    if not (2 <= len(username) <= 40) or not all(c.isalnum() or c in "._-" for c in username):
        raise AuthError("Nom d'utilisateur invalide (2 à 40 caractères : lettres, chiffres, . _ -).")
    return username


def _validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AuthError(f"Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères.")
    if len(password) > 256:
        raise AuthError("Mot de passe trop long.")


def create_user(username: str, password: str, is_admin: bool = False) -> User:
    username = _validate_username(username)
    _validate_password(password)
    with connect() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise AuthError(f"L'utilisateur « {username} » existe déjà.")
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
            (username, _hasher.hash(password), int(is_admin), int(time.time())),
        )
        return User(id=cur.lastrowid, username=username, is_admin=is_admin)


def delete_user(username: str) -> bool:
    with connect() as conn:
        return conn.execute("DELETE FROM users WHERE username = ?", (username,)).rowcount > 0


def set_password(username: str, password: str) -> None:
    _validate_password(password)
    with connect() as conn:
        row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise AuthError(f"Utilisateur « {username} » introuvable.")
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (_hasher.hash(password), row["id"]))
        # Un changement de mot de passe déconnecte toutes les sessions existantes.
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))


def list_users() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT u.username, u.is_admin, u.created_at, COUNT(f.symbol) AS favorites "
            "FROM users u LEFT JOIN favorites f ON f.user_id = u.id GROUP BY u.id ORDER BY u.username"
        ).fetchall()
        return [dict(r) for r in rows]


def authenticate(username: str, password: str) -> User | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT id, username, password_hash, is_admin FROM users WHERE username = ?", (username.strip(),)
        ).fetchone()
    if row is None:
        try:
            _hasher.verify(_DUMMY_HASH, password)
        except VerificationError:
            pass
        return None
    try:
        _hasher.verify(row["password_hash"], password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return None
    if _hasher.check_needs_rehash(row["password_hash"]):
        with connect() as conn:
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (_hasher.hash(password), row["id"]))
    return User(id=row["id"], username=row["username"], is_admin=bool(row["is_admin"]))


def change_own_password(user: User, current: str, new: str) -> None:
    if authenticate(user.username, current) is None:
        raise AuthError("Mot de passe actuel incorrect.")
    set_password(user.username, new)


# --------------------------------------------------------------------------- sessions

def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user: User, user_agent: str | None) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
            (_hash_token(token), user.id, now, now + config.SESSION_DAYS * 86400, (user_agent or "")[:300]),
        )
    return token


def user_from_token(token: str | None) -> User | None:
    if not token or len(token) > 100:
        return None
    with connect() as conn:
        row = conn.execute(
            "SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ?",
            (_hash_token(token), int(time.time())),
        ).fetchone()
    if row is None:
        return None
    return User(id=row["id"], username=row["username"], is_admin=bool(row["is_admin"]))


def delete_session(token: str | None) -> None:
    if token:
        with connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


# --------------------------------------------------------------------------- anti force brute

class LoginThrottle:
    """Bloque temporairement une IP ou un nom d'utilisateur après trop d'échecs."""

    def __init__(self, max_failures: int, window: int):
        self.max_failures = max_failures
        self.window = window
        self._failures: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque:
        q = self._failures[key]
        while q and q[0] < now - self.window:
            q.popleft()
        return q

    def retry_after(self, *keys: str) -> int:
        """Nombre de secondes à attendre (0 si la tentative est autorisée)."""
        now = time.monotonic()
        wait = 0
        with self._lock:
            for key in keys:
                q = self._prune(key, now)
                if len(q) >= self.max_failures:
                    wait = max(wait, int(q[0] + self.window - now) + 1)
        return wait

    def failure(self, *keys: str) -> None:
        now = time.monotonic()
        with self._lock:
            for key in keys:
                self._prune(key, now).append(now)

    def success(self, *keys: str) -> None:
        with self._lock:
            for key in keys:
                self._failures.pop(key, None)


throttle = LoginThrottle(config.LOGIN_MAX_FAILURES, config.LOGIN_WINDOW_SECONDS)
