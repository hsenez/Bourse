"use strict";

/** Appel à l'API JSON du serveur. Lève une Error avec le message du serveur en cas d'échec. */
async function api(path, { method = "GET", body } = {}) {
  const headers = { "X-Requested-With": "bourse" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Serveur injoignable. Vérifiez la connexion.");
  }
  if (res.status === 401 && path !== "/api/login") {
    window.location.href = "/login";
    throw new Error("Session expirée.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.detail;
    if (Array.isArray(msg)) msg = "Requête invalide.";
    throw new Error(msg || `Erreur ${res.status}`);
  }
  return data;
}

const storage = {
  get(key, fallback = null) {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* stockage indisponible : on ignore */
    }
  },
};
