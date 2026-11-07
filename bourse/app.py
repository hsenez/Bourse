"""Application web FastAPI : pages, API JSON, sécurité."""

import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, market
from .db import connect, init_db

log = logging.getLogger("bourse")

STATIC_DIR = Path(__file__).resolve().parent / "static"

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Bourse", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# --------------------------------------------------------------------------- sécurité

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; "
    "frame-ancestors 'none'"
)
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    # Protection CSRF : les requêtes qui modifient l'état doivent venir de notre propre JavaScript
    # (en-tête personnalisé, impossible à poser depuis un autre site sans pré-vol CORS refusé)
    # et, si le navigateur l'indique, de la même origine.
    if request.method in UNSAFE_METHODS and request.url.path.startswith("/api/"):
        if request.headers.get("x-requested-with") != "bourse":
            return JSONResponse({"detail": "Requête refusée."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Origine refusée."}, status_code=403)

    response = await call_next(request)
    h = response.headers
    h.setdefault("Content-Security-Policy", CSP)
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.url.scheme == "https":
        h.setdefault("Strict-Transport-Security", "max-age=31536000")
    if request.url.path.startswith("/api/"):
        h.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(market.MarketError)
async def _market_error(_: Request, exc: market.MarketError):
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


def _cookie_secure(request: Request) -> bool:
    if config.COOKIE_SECURE in {"true", "1", "yes"}:
        return True
    if config.COOKIE_SECURE in {"false", "0", "no"}:
        return False
    return request.url.scheme == "https"


def optional_user(request: Request) -> auth.User | None:
    return auth.user_from_token(request.cookies.get(auth.COOKIE_NAME))


def current_user(user: auth.User | None = Depends(optional_user)) -> auth.User:
    if user is None:
        raise HTTPException(401, "Non connecté.")
    return user


# --------------------------------------------------------------------------- pages

@app.get("/", include_in_schema=False)
def index(user: auth.User | None = Depends(optional_user)):
    if user is None:
        return RedirectResponse("/login", status_code=303)
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/login", include_in_schema=False)
def login_page(user: auth.User | None = Depends(optional_user)):
    if user is not None:
        return RedirectResponse("/", status_code=303)
    return FileResponse(STATIC_DIR / "login.html", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}


# --------------------------------------------------------------------------- authentification

class LoginBody(BaseModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=256)


class PasswordBody(BaseModel):
    current: str = Field(max_length=256)
    new: str = Field(max_length=256)


@app.post("/api/login")
def login(body: LoginBody, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    keys = (f"ip:{ip}", f"user:{body.username.strip().lower()}")
    wait = auth.throttle.retry_after(*keys)
    if wait:
        raise HTTPException(429, f"Trop de tentatives. Réessayez dans {max(1, wait // 60)} min.",
                            headers={"Retry-After": str(wait)})
    user = auth.authenticate(body.username, body.password)
    if user is None:
        auth.throttle.failure(*keys)
        log.warning("Échec de connexion pour « %s » depuis %s", body.username[:40], ip)
        raise HTTPException(401, "Identifiant ou mot de passe incorrect.")
    auth.throttle.success(*keys)
    token = auth.create_session(user, request.headers.get("user-agent"))
    response.set_cookie(
        auth.COOKIE_NAME, token, max_age=config.SESSION_DAYS * 86400, httponly=True,
        secure=_cookie_secure(request), samesite="lax", path="/",
    )
    log.info("Connexion de « %s » depuis %s", user.username, ip)
    return {"username": user.username}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    auth.delete_session(request.cookies.get(auth.COOKIE_NAME))
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user: auth.User = Depends(current_user)):
    return {"username": user.username, "isAdmin": user.is_admin}


@app.post("/api/password")
def change_password(body: PasswordBody, request: Request, response: Response,
                    user: auth.User = Depends(current_user)):
    try:
        auth.change_own_password(user, body.current, body.new)
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc))
    # Toutes les sessions ont été invalidées : on en recrée une pour l'appareil courant.
    token = auth.create_session(user, request.headers.get("user-agent"))
    response.set_cookie(
        auth.COOKIE_NAME, token, max_age=config.SESSION_DAYS * 86400, httponly=True,
        secure=_cookie_secure(request), samesite="lax", path="/",
    )
    return {"ok": True}


# --------------------------------------------------------------------------- marché

@app.get("/api/periods")
def periods(_: auth.User = Depends(current_user)):
    return {"periods": list(market.PERIODS), "default": market.DEFAULT_PERIOD}


@app.get("/api/search")
def search(q: str = Query(min_length=1, max_length=64), _: auth.User = Depends(current_user)):
    return {"results": market.search(q)}


@app.get("/api/history/{symbol}")
def history(symbol: str, period: str = market.DEFAULT_PERIOD, _: auth.User = Depends(current_user)):
    return market.history(symbol, period)


@app.get("/api/quotes")
def quotes(symbols: str = Query(max_length=1000), _: auth.User = Depends(current_user)):
    return {"quotes": market.quotes(symbols.split(","))}


# --------------------------------------------------------------------------- favoris

class FavoriteBody(BaseModel):
    symbol: str = Field(max_length=32)
    name: str = Field(max_length=200)
    type: str = Field(default="", max_length=40)
    exchange: str = Field(default="", max_length=80)


class OrderBody(BaseModel):
    symbols: list[str] = Field(max_length=500)


def _favorites(user_id: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT symbol, name, quote_type AS type, exchange FROM favorites "
            "WHERE user_id = ? ORDER BY position, added_at",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/favorites")
def list_favorites(user: auth.User = Depends(current_user)):
    return {"favorites": _favorites(user.id)}


@app.post("/api/favorites")
def add_favorite(body: FavoriteBody, user: auth.User = Depends(current_user)):
    symbol = market.validate_symbol(body.symbol)
    with connect() as conn:
        pos = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM favorites WHERE user_id = ?",
                           (user.id,)).fetchone()[0]
        conn.execute(
            "INSERT INTO favorites (user_id, symbol, name, quote_type, exchange, position, added_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, symbol) DO UPDATE SET name = excluded.name",
            (user.id, symbol, body.name.strip() or symbol, body.type, body.exchange, pos, int(time.time())),
        )
    return {"favorites": _favorites(user.id)}


@app.delete("/api/favorites/{symbol}")
def delete_favorite(symbol: str, user: auth.User = Depends(current_user)):
    with connect() as conn:
        conn.execute("DELETE FROM favorites WHERE user_id = ? AND symbol = ?", (user.id, symbol))
    return {"favorites": _favorites(user.id)}


@app.put("/api/favorites/order")
def reorder_favorites(body: OrderBody, user: auth.User = Depends(current_user)):
    with connect() as conn:
        for i, symbol in enumerate(body.symbols):
            conn.execute("UPDATE favorites SET position = ? WHERE user_id = ? AND symbol = ?",
                         (i, user.id, symbol))
    return {"favorites": _favorites(user.id)}


# --------------------------------------------------------------------------- préférences

@app.get("/api/settings")
def get_settings(user: auth.User = Depends(current_user)):
    with connect() as conn:
        raw = conn.execute("SELECT settings FROM users WHERE id = ?", (user.id,)).fetchone()[0]
    try:
        return {"settings": json.loads(raw)}
    except ValueError:
        return {"settings": {}}


@app.put("/api/settings")
async def put_settings(request: Request, user: auth.User = Depends(current_user)):
    body = await request.body()
    if len(body) > 4096:
        raise HTTPException(413, "Préférences trop volumineuses.")
    try:
        data = json.loads(body).get("settings")
    except (ValueError, AttributeError):
        raise HTTPException(400, "JSON invalide.")
    if not isinstance(data, dict):
        raise HTTPException(400, "Format de préférences invalide.")
    with connect() as conn:
        conn.execute("UPDATE users SET settings = ? WHERE id = ?", (json.dumps(data), user.id))
    return {"settings": data}
