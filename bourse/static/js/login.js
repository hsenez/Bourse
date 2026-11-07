"use strict";

const form = document.getElementById("login-form");
const errorEl = document.getElementById("login-error");
let setupMode = false;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// Base vide : formulaire de création du premier compte administrateur.
api("/api/setup").then(({ needed, allowed }) => {
  if (!needed) return;
  if (!allowed) {
    document.getElementById("setup-remote").hidden = false;
    form.querySelector("#login-submit").disabled = true;
    return;
  }
  setupMode = true;
  document.title = "Première installation · Bourse";
  document.getElementById("setup-intro").hidden = false;
  document.getElementById("confirm-label").hidden = false;
  form.password.autocomplete = "new-password";
  form.password.placeholder = "10 caractères minimum";
  document.getElementById("login-submit").textContent = "Créer le compte administrateur";
}).catch(() => {});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) {
    showError("Renseignez l'utilisateur et le mot de passe.");
    return;
  }
  if (setupMode && password !== form.confirm.value) {
    showError("La confirmation ne correspond pas.");
    return;
  }
  const button = document.getElementById("login-submit");
  button.disabled = true;
  try {
    await api(setupMode ? "/api/setup" : "/api/login", { method: "POST", body: { username, password } });
    window.location.replace("/");
  } catch (err) {
    showError(err.message);
    form.password.select();
  } finally {
    button.disabled = false;
  }
});
