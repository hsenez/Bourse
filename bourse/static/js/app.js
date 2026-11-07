"use strict";

/* Utilitaires DOM ------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(pathD) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", pathD);
  svg.append(p);
  return svg;
}
const ICON_STAR = "M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z";
const ICON_CLOSE = "M6 6l12 12M18 6L6 18";

let toastTimer;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

const isMobile = () => window.matchMedia("(max-width: 899px)").matches;

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function signClass(v) {
  if (v == null || !isFinite(v) || v === 0) return "";
  return v > 0 ? "up" : "down";
}

/* État ----------------------------------------------------------------------- */

const PERIOD_LABELS = {
  "1d": "1 jour", "5d": "5 jours", "1mo": "1 mois", "6mo": "6 mois",
  ytd: "depuis le 1er janvier", "1y": "1 an", "5y": "5 ans", max: "depuis l'origine",
};

const state = {
  favorites: [],
  quotes: {},
  current: storage.get("bourse.current"),
  period: storage.get("bourse.period", "1y"),
  options: {},
  data: null,
  reqId: 0,
  lastFullRefresh: 0,
};
if (!PERIOD_LABELS[state.period]) state.period = "1y";

const chart = new StockChart($("chart"), $("zoom-rect"), (zoomed) => { $("reset-zoom").hidden = !zoomed; });

const isFavorite = (symbol) => state.favorites.some((f) => f.symbol === symbol);

/* Favoris -------------------------------------------------------------------- */

function renderFavorites() {
  const list = $("favorites");
  list.replaceChildren();
  $("favorites-empty").hidden = state.favorites.length > 0;
  for (const fav of state.favorites) {
    const q = state.quotes[fav.symbol];
    const li = el("li", {
      class: "item" + (state.current?.symbol === fav.symbol ? " active" : ""),
      onclick: () => selectInstrument(fav),
    },
      el("div", { class: "item-main" },
        el("div", { class: "item-name", title: fav.name }, fav.name),
        el("div", { class: "item-sub" }, [fav.symbol, fav.exchange].filter(Boolean).join(" · ")),
      ),
      el("div", { class: "item-quote" },
        el("div", {}, q ? formatNumber(q.price) : ""),
        el("div", { class: "pct " + signClass(q?.changePct) }, q && q.changePct != null ? formatPct(q.changePct) : ""),
      ),
    );
    const remove = el("button", {
      class: "icon-btn remove", "aria-label": `Retirer ${fav.name} des favoris`, title: "Retirer des favoris",
      onclick: (e) => { e.stopPropagation(); toggleFavorite(fav); },
    }, icon(ICON_CLOSE));
    li.append(remove);
    list.append(li);
  }
}

async function loadFavorites() {
  const { favorites } = await api("/api/favorites");
  state.favorites = favorites;
  renderFavorites();
}

async function refreshQuotes() {
  const symbols = state.favorites.map((f) => f.symbol);
  if (state.current && !symbols.includes(state.current.symbol)) symbols.push(state.current.symbol);
  if (!symbols.length) return;
  try {
    const { quotes } = await api("/api/quotes?symbols=" + encodeURIComponent(symbols.join(",")));
    Object.assign(state.quotes, quotes);
    renderFavorites();
    renderQuote();
  } catch {
    /* les cotations de la liste ne sont pas critiques */
  }
}

async function toggleFavorite(inst) {
  try {
    const res = isFavorite(inst.symbol)
      ? await api("/api/favorites/" + encodeURIComponent(inst.symbol), { method: "DELETE" })
      : await api("/api/favorites", {
        method: "POST",
        body: { symbol: inst.symbol, name: inst.name || inst.symbol, type: inst.type || "", exchange: inst.exchange || "" },
      });
    const added = !isFavorite(inst.symbol);
    state.favorites = res.favorites;
    renderFavorites();
    renderSearchResults();
    renderHeader();
    toast(added ? `${inst.name} ajouté aux favoris` : `${inst.name} retiré des favoris`);
    if (added) refreshQuotes();
  } catch (err) {
    toast(err.message);
  }
}

/* Recherche ------------------------------------------------------------------ */

let searchResults = [];
let searchSeq = 0;

function renderSearchResults() {
  const list = $("search-results");
  list.replaceChildren();
  for (const r of searchResults) {
    const fav = isFavorite(r.symbol);
    const star = el("button", {
      class: "icon-btn star", "aria-pressed": String(fav),
      "aria-label": fav ? `Retirer ${r.name} des favoris` : `Ajouter ${r.name} aux favoris`,
      title: fav ? "Retirer des favoris" : "Ajouter aux favoris",
      onclick: (e) => { e.stopPropagation(); toggleFavorite(r); },
    }, icon(ICON_STAR));
    list.append(el("li", {
      class: "item" + (state.current?.symbol === r.symbol ? " active" : ""),
      onclick: () => selectInstrument(r),
    },
      el("div", { class: "item-main" },
        el("div", { class: "item-name", title: r.name }, r.name),
        el("div", { class: "item-sub" },
          r.typeLabel ? el("span", { class: "badge" + (r.type === "INDEX" ? " index" : "") }, r.typeLabel) : null,
          [r.symbol, r.exchange].filter(Boolean).join(" · "),
        ),
      ),
      star,
    ));
  }
}

const runSearch = debounce(async (query) => {
  const seq = ++searchSeq;
  const status = $("search-status");
  status.textContent = "Recherche…";
  try {
    const { results } = await api("/api/search?q=" + encodeURIComponent(query));
    if (seq !== searchSeq) return;
    searchResults = results;
    renderSearchResults();
    status.textContent = results.length ? "" : "Aucun résultat.";
  } catch (err) {
    if (seq !== searchSeq) return;
    searchResults = [];
    renderSearchResults();
    status.textContent = err.message;
  }
}, 300);

$("search-input").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  const searching = q.length > 0;
  $("search-section").hidden = !searching;
  $("favorites-section").hidden = searching;
  if (searching) {
    runSearch(q);
  } else {
    searchSeq++;
    searchResults = [];
    renderSearchResults();
  }
});
$("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.target.value = "";
    e.target.dispatchEvent(new Event("input"));
  } else if (e.key === "Enter" && searchResults.length) {
    selectInstrument(searchResults[0]);
  }
});

/* Instrument affiché --------------------------------------------------------- */

function renderHeader() {
  const cur = state.current;
  const has = !!cur;
  $("empty").hidden = has;
  $("quote").hidden = !has;
  $("periods").hidden = !has;
  $("toggle-favorite").hidden = !has;
  $("open-options").hidden = !has;
  if (!has) {
    $("instrument-name").textContent = "Bourse";
    $("instrument-meta").textContent = "";
    document.title = "Bourse";
    return;
  }
  const d = state.data && state.data.symbol === cur.symbol ? state.data : null;
  const name = cur.name || d?.name || cur.symbol;
  $("instrument-name").textContent = name;
  $("instrument-meta").textContent = [cur.symbol, d?.exchange || cur.exchange, d?.currency].filter(Boolean).join(" · ");
  document.title = `${name} · Bourse`;

  const fav = isFavorite(cur.symbol);
  const star = $("toggle-favorite");
  star.setAttribute("aria-pressed", String(fav));
  star.setAttribute("aria-label", fav ? "Retirer des favoris" : "Ajouter aux favoris");
  star.title = fav ? "Retirer des favoris" : "Ajouter aux favoris";

  for (const b of $("periods").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.period === state.period));
  }
}

function renderQuote() {
  const cur = state.current;
  const d = state.data && cur && state.data.symbol === cur.symbol ? state.data : null;
  const q = cur ? state.quotes[cur.symbol] : null;
  if (!d) {
    $("price").textContent = q ? formatNumber(q.price) : "";
    $("day-change").textContent = "";
    $("period-change").textContent = "";
    return;
  }
  const lastClose = [...d.c].reverse().find((v) => v != null);
  const firstClose = d.c.find((v) => v != null);
  const price = d.price ?? lastClose;
  const prev = q?.previousClose ?? d.previousClose;

  $("price").textContent = formatNumber(price) + (d.currency ? " " + d.currency : "");
  const dayEl = $("day-change");
  if (prev && price != null) {
    const ch = price - prev;
    const pct = (price / prev - 1) * 100;
    dayEl.textContent = `${ch > 0 ? "+" : ""}${formatNumber(ch)} (${formatPct(pct)}) aujourd'hui`;
    dayEl.className = "change " + signClass(ch);
  } else {
    dayEl.textContent = "";
  }
  const pe = $("period-change");
  if (state.period !== "1d" && firstClose && lastClose != null) {
    pe.textContent = `${formatPct((lastClose / firstClose - 1) * 100)} sur ${PERIOD_LABELS[state.period]}`;
  } else {
    pe.textContent = "";
  }

  const updated = new Date(d.fetchedAt * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  $("source").textContent = `Source : Yahoo Finance · données parfois différées · mis à jour à ${updated}`;
}

function showChartMessage(text, loading = false) {
  const m = $("chart-message");
  m.textContent = text || "";
  m.classList.toggle("loading", loading);
  m.hidden = !text && !loading;
}

async function loadChart({ silent = false } = {}) {
  const cur = state.current;
  if (!cur) return;
  const reqId = ++state.reqId;
  if (!silent) {
    showChartMessage("", true);
    if (!state.data || state.data.symbol !== cur.symbol) chart.clear();
  }
  try {
    const data = await api(`/api/history/${encodeURIComponent(cur.symbol)}?period=${state.period}`);
    if (reqId !== state.reqId) return;
    state.data = data;
    showChartMessage("");
    chart.setData(data, state.options);
    syncOptionInputs();
    renderHeader();
    renderQuote();
  } catch (err) {
    if (reqId !== state.reqId || silent) return;
    state.data = null;
    chart.clear();
    renderQuote();
    showChartMessage(err.message);
  }
}

function selectInstrument(inst) {
  state.current = { symbol: inst.symbol, name: inst.name, type: inst.type, exchange: inst.exchange };
  storage.set("bourse.current", state.current);
  state.lastFullRefresh = Date.now();
  renderHeader();
  renderQuote();
  renderFavorites();
  renderSearchResults();
  if (isMobile()) closeDrawer();
  loadChart();
  refreshQuotes();
}

/* Périodes ------------------------------------------------------------------- */

$("periods").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-period]");
  if (!b || b.dataset.period === state.period) return;
  state.period = b.dataset.period;
  storage.set("bourse.period", state.period);
  renderHeader();
  loadChart();
});

/* Options d'affichage -------------------------------------------------------- */

const saveSettings = debounce(() => {
  api("/api/settings", { method: "PUT", body: { settings: { chart: state.options } } }).catch(() => {});
}, 600);

function syncOptionInputs() {
  for (const input of $("options-panel").querySelectorAll("input[data-opt]")) {
    input.checked = !!state.options[input.dataset.opt];
  }
  $("options-panel").querySelector('input[data-opt="log"]').disabled = !!state.options.pct;
  const noVolume = !!state.data && !state.data.v.some((v) => v);
  $("options-panel").querySelector('input[data-opt="volume"]').disabled = noVolume;
  $("no-volume").hidden = !noVolume;
}

$("options-panel").addEventListener("change", (e) => {
  const input = e.target.closest("input[data-opt]");
  if (!input) return;
  state.options[input.dataset.opt] = input.checked;
  syncOptionInputs();
  chart.setOptions(state.options);
  saveSettings();
});

function setOptionsOpen(open) {
  $("options-panel").hidden = !open;
  $("open-options").setAttribute("aria-expanded", String(open));
  if (isMobile()) $("backdrop").hidden = !open && !$("sidebar").classList.contains("open");
}
$("open-options").addEventListener("click", (e) => {
  e.stopPropagation();
  setOptionsOpen($("options-panel").hidden);
});
$("close-options").addEventListener("click", () => setOptionsOpen(false));
document.addEventListener("click", (e) => {
  if (!$("options-panel").hidden && !e.target.closest("#options-panel, #open-options")) setOptionsOpen(false);
});

/* Tiroir (téléphone) --------------------------------------------------------- */

function openDrawer(focusSearch = false) {
  $("sidebar").classList.add("open");
  $("backdrop").hidden = false;
  if (focusSearch) setTimeout(() => $("search-input").focus(), 230);
}
function closeDrawer() {
  $("sidebar").classList.remove("open");
  $("backdrop").hidden = true;
}
$("open-drawer").addEventListener("click", () => openDrawer());
$("close-drawer").addEventListener("click", closeDrawer);
$("backdrop").addEventListener("click", () => { closeDrawer(); setOptionsOpen(false); });
$("empty-search").addEventListener("click", () => openDrawer(true));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  setOptionsOpen(false);
  closeDrawer();
});

/* Divers --------------------------------------------------------------------- */

$("toggle-favorite").addEventListener("click", () => state.current && toggleFavorite(state.current));
$("reset-zoom").addEventListener("click", () => chart.resetZoom());

$("suggestions").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-symbol]");
  if (b) selectInstrument({ symbol: b.dataset.symbol, name: b.dataset.name, type: "INDEX", exchange: "" });
});

/* Compte ---------------------------------------------------------------------- */

let me = null;

function setMe(info) {
  me = info;
  $("username").textContent = info.username;
  $("avatar").textContent = info.username.slice(0, 1);
  $("admin-badge").hidden = !info.isAdmin;
  $("open-users").hidden = !info.isAdmin;
}

function setAccountMenuOpen(open) {
  $("account-menu").hidden = !open;
  $("account-btn").setAttribute("aria-expanded", String(open));
}
$("account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  setAccountMenuOpen($("account-menu").hidden);
});
document.addEventListener("click", (e) => {
  if (!$("account-menu").hidden && !e.target.closest("#account-btn")) setAccountMenuOpen(false);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setAccountMenuOpen(false); });

$("logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } finally { window.location.href = "/login"; }
});

const pwDialog = $("password-dialog");
$("open-password").addEventListener("click", () => {
  $("password-form").reset();
  $("password-error").hidden = true;
  pwDialog.showModal();
});
$("cancel-password").addEventListener("click", () => pwDialog.close());
$("password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $("password-error");
  err.hidden = true;
  if (f.new.value !== f.confirm.value) {
    err.textContent = "La confirmation ne correspond pas.";
    err.hidden = false;
    return;
  }
  try {
    await api("/api/password", { method: "POST", body: { current: f.current.value, new: f.new.value } });
    pwDialog.close();
    toast("Mot de passe modifié. Les autres appareils ont été déconnectés.");
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

/* Administration des utilisateurs ------------------------------------------- */

const usersDialog = $("users-dialog");
let users = [];
let editingUser = null; // null = création

const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const fmtDayTime = (ts) => new Date(ts * 1000).toLocaleString("fr-FR", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

function renderUsers() {
  const list = $("user-list");
  list.replaceChildren();
  for (const u of users) {
    const isMe = u.id === me?.id;
    const meta = [
      `créé le ${fmtDay(u.createdAt)}`,
      u.lastLoginAt ? `dernière connexion ${fmtDayTime(u.lastLoginAt)}` : "jamais connecté",
      plural(u.favorites, "favori"),
      u.sessions > 1 ? `${u.sessions} sessions actives` : `${u.sessions} session active`,
    ].join(" · ");
    list.append(el("li", { class: "user-row" },
      el("span", { class: "avatar", "aria-hidden": "true" }, u.username.slice(0, 1)),
      el("div", { class: "user-info" },
        el("div", { class: "user-name" },
          u.username, " ",
          u.isAdmin ? el("span", { class: "badge index" }, "admin") : null,
          isMe ? el("span", { class: "badge" }, "vous") : null,
        ),
        el("div", { class: "user-meta" }, meta),
      ),
      el("div", { class: "actions" },
        el("button", {
          class: "text-btn", disabled: u.sessions === 0,
          title: "Fermer toutes les sessions de cet utilisateur (sur tous ses appareils)",
          onclick: () => revokeUserSessions(u),
        }, "Déconnecter"),
        el("button", { class: "text-btn", onclick: () => openUserForm(u) }, "Modifier"),
      ),
    ));
  }
}

function showUsersList() {
  $("users-list-view").hidden = false;
  $("user-form").hidden = true;
}

async function openUsers() {
  showUsersList();
  usersDialog.showModal();
  try {
    users = (await api("/api/admin/users")).users;
    renderUsers();
  } catch (err) {
    toast(err.message);
  }
}

function openUserForm(user) {
  editingUser = user;
  const f = $("user-form");
  f.reset();
  $("user-error").hidden = true;
  const isMe = user && user.id === me?.id;
  $("user-form-title").textContent = user ? `Modifier « ${user.username} »` : "Nouvel utilisateur";
  $("user-password-label").textContent = user ? "Nouveau mot de passe (laisser vide pour le conserver)" : "Mot de passe";
  $("save-user").textContent = user ? "Enregistrer" : "Créer";
  $("delete-user").hidden = !user || isMe;
  f.username.value = user ? user.username : "";
  f.isAdmin.checked = !!user?.isAdmin;
  $("user-form-hint").textContent = user
    ? (isMe
      ? "Changer votre mot de passe déconnecte vos autres appareils, pas celui-ci."
      : "Changer le mot de passe déconnecte cet utilisateur de tous ses appareils.")
    : "L'utilisateur pourra changer son mot de passe depuis le menu de son compte.";
  $("users-list-view").hidden = true;
  f.hidden = false;
  f.username.focus();
}

async function afterSelfChange() {
  setMe(await api("/api/me"));
  if (!me.isAdmin) {
    usersDialog.close();
    toast("Vous n'êtes plus administrateur.");
    return false;
  }
  return true;
}

$("open-users").addEventListener("click", openUsers);
$("close-users").addEventListener("click", () => usersDialog.close());
$("new-user").addEventListener("click", () => openUserForm(null));
$("cancel-user").addEventListener("click", showUsersList);

$("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $("user-error");
  err.hidden = true;
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };

  const username = f.username.value.trim();
  const password = f.password.value;
  if (!username) return fail("Indiquez un nom d'utilisateur.");
  if (!editingUser && !password) return fail("Indiquez un mot de passe.");
  if (password && password !== f.confirm.value) return fail("La confirmation ne correspond pas.");

  const button = $("save-user");
  button.disabled = true;
  try {
    let res;
    if (editingUser) {
      const body = {};
      if (username !== editingUser.username) body.username = username;
      if (f.isAdmin.checked !== editingUser.isAdmin) body.isAdmin = f.isAdmin.checked;
      if (password) body.password = password;
      if (!Object.keys(body).length) { showUsersList(); return; }
      res = await api(`/api/admin/users/${editingUser.id}`, { method: "PATCH", body });
      toast(`Compte « ${username} » modifié.`);
    } else {
      res = await api("/api/admin/users", { method: "POST", body: { username, password, isAdmin: f.isAdmin.checked } });
      toast(`Compte « ${username} » créé.`);
    }
    users = res.users;
    if (editingUser && editingUser.id === me.id && !(await afterSelfChange())) return;
    renderUsers();
    showUsersList();
  } catch (ex) {
    fail(ex.message);
  } finally {
    button.disabled = false;
  }
});

$("delete-user").addEventListener("click", async () => {
  const u = editingUser;
  if (!u || !window.confirm(`Supprimer définitivement « ${u.username} » et ses favoris ?`)) return;
  try {
    users = (await api(`/api/admin/users/${u.id}`, { method: "DELETE" })).users;
    toast(`Compte « ${u.username} » supprimé.`);
    renderUsers();
    showUsersList();
  } catch (ex) {
    $("user-error").textContent = ex.message;
    $("user-error").hidden = false;
  }
});

async function revokeUserSessions(u) {
  try {
    const res = await api(`/api/admin/users/${u.id}/logout`, { method: "POST" });
    users = res.users;
    renderUsers();
    toast(u.id === me.id
      ? "Vos autres appareils ont été déconnectés."
      : `${plural(res.revoked, "session")} de « ${u.username} » fermée${res.revoked > 1 ? "s" : ""}.`);
  } catch (ex) {
    toast(ex.message);
  }
}

/* Rafraîchissement automatique ---------------------------------------------- */

function periodicRefresh() {
  if (document.visibilityState !== "visible") return;
  refreshQuotes();
  if (!state.current || !state.data) return;
  // Intraday : chaque minute ; sinon toutes les 10 minutes.
  const every = state.data.intraday ? 60_000 : 600_000;
  if (Date.now() - state.lastFullRefresh >= every - 1000) {
    state.lastFullRefresh = Date.now();
    loadChart({ silent: true });
  }
}
setInterval(periodicRefresh, 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    state.lastFullRefresh = 0;
    periodicRefresh();
  }
});

/* Démarrage ------------------------------------------------------------------ */

(async function init() {
  try {
    const [meInfo, settings] = await Promise.all([api("/api/me"), api("/api/settings"), loadFavorites()]);
    setMe(meInfo);
    state.options = settings.settings?.chart || {};
  } catch (err) {
    toast(err.message);
  }
  syncOptionInputs();
  if (!state.current && state.favorites.length) state.current = state.favorites[0];
  renderHeader();
  renderFavorites();
  if (state.current) {
    state.lastFullRefresh = Date.now();
    loadChart();
  }
  refreshQuotes();
})();
