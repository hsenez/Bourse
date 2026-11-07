"use strict";

const form = document.getElementById("login-form");
const errorEl = document.getElementById("login-error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) {
    errorEl.textContent = "Renseignez l'utilisateur et le mot de passe.";
    errorEl.hidden = false;
    return;
  }
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: { username, password } });
    window.location.replace("/");
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    form.password.select();
  } finally {
    button.disabled = false;
  }
});
