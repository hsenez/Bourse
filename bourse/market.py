"""Données de marché via Yahoo Finance (bibliothèque yfinance), avec un cache mémoire.

Toute la dépendance au fournisseur est isolée ici : pour changer de source de données,
il suffit de réimplémenter `search`, `history` et `quotes` avec le même format de sortie.
"""

import logging
import math
import re
import threading
import time
from typing import Any, Callable

import pandas as pd
import yfinance as yf

log = logging.getLogger("bourse.market")

SYMBOL_RE = re.compile(r"^[A-Za-z0-9.^=\-&_]{1,32}$")

# clé de période -> (period yfinance, intervalle, durée de cache en secondes)
PERIODS: dict[str, tuple[str, str, int]] = {
    "1d": ("1d", "5m", 60),
    "5d": ("5d", "15m", 120),
    "1mo": ("1mo", "60m", 300),
    "6mo": ("6mo", "1d", 900),
    "ytd": ("ytd", "1d", 900),
    "1y": ("1y", "1d", 900),
    "5y": ("5y", "1d", 3600),
    "max": ("max", "1wk", 3600),
}
DEFAULT_PERIOD = "1y"

INTRADAY_INTERVALS = {"5m", "15m", "60m"}


class MarketError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class _TTLCache:
    def __init__(self, max_items: int = 500):
        self._data: dict[Any, tuple[float, Any]] = {}
        self._locks: dict[Any, threading.Lock] = {}
        self._global = threading.Lock()
        self.max_items = max_items

    def _lock_for(self, key) -> threading.Lock:
        with self._global:
            return self._locks.setdefault(key, threading.Lock())

    def get(self, key, ttl: int):
        item = self._data.get(key)
        if item and time.monotonic() - item[0] < ttl:
            return item[1]
        return None

    def put(self, key, value) -> None:
        if len(self._data) >= self.max_items:
            oldest = sorted(self._data.items(), key=lambda kv: kv[1][0])[: self.max_items // 5]
            for k, _ in oldest:
                self._data.pop(k, None)
        self._data[key] = (time.monotonic(), value)

    def get_or_compute(self, key, ttl: int, compute: Callable[[], Any]):
        value = self.get(key, ttl)
        if value is not None:
            return value
        with self._lock_for(key):  # évite plusieurs appels simultanés identiques
            value = self.get(key, ttl)
            if value is None:
                value = compute()
                self.put(key, value)
            return value


_cache = _TTLCache()


def validate_symbol(symbol: str) -> str:
    symbol = symbol.strip()
    if not SYMBOL_RE.match(symbol):
        raise MarketError("Symbole invalide.", 400)
    return symbol


def _num(x) -> float | None:
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


# --------------------------------------------------------------------------- recherche

def search(query: str) -> list[dict]:
    query = query.strip()
    if not query or len(query) > 64:
        return []

    def compute():
        try:
            s = yf.Search(query, max_results=15, news_count=0, lists_count=0, recommended=0,
                          enable_fuzzy_query=True, timeout=10)
            quotes = s.quotes or []
        except Exception as exc:  # erreurs réseau, format inattendu, limitation...
            log.warning("Recherche « %s » en échec : %s", query, exc)
            raise MarketError("Le service de recherche est indisponible pour le moment.")
        results = []
        for q in quotes:
            symbol = q.get("symbol")
            if not symbol or not SYMBOL_RE.match(symbol):
                continue
            results.append({
                "symbol": symbol,
                "name": q.get("longname") or q.get("shortname") or symbol,
                "type": q.get("quoteType") or "",
                "typeLabel": q.get("typeDisp") or q.get("quoteType") or "",
                "exchange": q.get("exchDisp") or q.get("exchange") or "",
            })
        # Les indices en premier, en conservant l'ordre de pertinence de Yahoo.
        results.sort(key=lambda r: r["type"] != "INDEX")
        return results

    return _cache.get_or_compute(("search", query.lower()), 3600, compute)


# --------------------------------------------------------------------------- historique

def history(symbol: str, period: str) -> dict:
    symbol = validate_symbol(symbol)
    if period not in PERIODS:
        raise MarketError("Période inconnue.", 400)
    yf_period, interval, ttl = PERIODS[period]

    def compute():
        ticker = yf.Ticker(symbol)
        try:
            df = ticker.history(period=yf_period, interval=interval, auto_adjust=False, actions=False,
                                raise_errors=True)
        except Exception as exc:
            log.warning("Historique %s/%s en échec : %s", symbol, period, exc)
            raise MarketError(f"Impossible de récupérer les données pour {symbol}.", 404)
        if df is None or df.empty:
            raise MarketError(f"Aucune donnée disponible pour {symbol} sur cette période.", 404)
        df = df.dropna(subset=["Close"])
        meta = ticker.history_metadata or {}

        idx = df.index
        if not isinstance(idx, pd.DatetimeIndex):
            idx = pd.to_datetime(idx)
        times = [int(ts.timestamp()) for ts in idx]

        return {
            "symbol": symbol,
            "name": meta.get("longName") or meta.get("shortName") or symbol,
            "currency": meta.get("currency") or "",
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
            "instrumentType": meta.get("instrumentType") or "",
            "timezone": meta.get("exchangeTimezoneName") or "UTC",
            "period": period,
            "interval": interval,
            "intraday": interval in INTRADAY_INTERVALS,
            "price": _num(meta.get("regularMarketPrice")),
            # Clôture de la veille (absente pour les périodes longues ; "chartPreviousClose" est la
            # clôture précédant le début de la période, ce n'est pas la même chose).
            "previousClose": _num(meta.get("previousClose")),
            "fetchedAt": int(time.time()),
            "t": times,
            "o": [_num(v) for v in df["Open"]],
            "h": [_num(v) for v in df["High"]],
            "l": [_num(v) for v in df["Low"]],
            "c": [_num(v) for v in df["Close"]],
            "v": [_num(v) for v in df["Volume"]] if "Volume" in df else [],
        }

    return _cache.get_or_compute(("history", symbol, period), ttl, compute)


# --------------------------------------------------------------------------- cotations

QUOTE_TTL = 60


def quotes(symbols: list[str]) -> dict[str, dict]:
    """Dernier cours et variation journalière pour une liste de symboles."""
    symbols = list(dict.fromkeys(validate_symbol(s) for s in symbols if s.strip()))[:50]
    result: dict[str, dict] = {}
    missing = []
    for s in symbols:
        cached = _cache.get(("quote", s), QUOTE_TTL)
        if cached is not None:
            result[s] = cached
        else:
            missing.append(s)
    if not missing:
        return result

    try:
        df = yf.download(missing, period="1mo", interval="1d", group_by="ticker", auto_adjust=False,
                         progress=False, threads=True, timeout=10)
    except Exception as exc:
        log.warning("Cotations %s en échec : %s", missing, exc)
        df = None

    for s in missing:
        quote = {"symbol": s, "price": None, "previousClose": None, "change": None, "changePct": None}
        try:
            if df is not None and not df.empty:
                sub = df[s] if isinstance(df.columns, pd.MultiIndex) else df
                closes = sub["Close"].dropna()
                if len(closes) >= 1:
                    quote["price"] = _num(closes.iloc[-1])
                if len(closes) >= 2:
                    prev = _num(closes.iloc[-2])
                    quote["previousClose"] = prev
                    if prev and quote["price"] is not None:
                        quote["change"] = quote["price"] - prev
                        quote["changePct"] = (quote["price"] / prev - 1) * 100
        except (KeyError, IndexError):
            pass
        if quote["price"] is not None:
            _cache.put(("quote", s), quote)
        result[s] = quote
    return result
