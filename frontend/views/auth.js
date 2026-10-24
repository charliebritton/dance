// Sign in, join with an invite link, and your account (name, lead/follow, groups, passkeys, password).
import { createPasskey, deviceLabel, getPasskey, passkeysSupported } from "../passkey.js";
import { $, BASE, S, api, attempt, confirmTap, esc, fmtDate, hooks, loadMe, refresh, toast } from "../core.js";

const DANCE_ROLES = [["lead", "Lead"], ["follow", "Follow"], ["both", "Both"]];

async function signedIn(to = "/") {
  await loadMe(); await refresh();
  history.replaceState(null, "", BASE + to);
  hooks.route();
}

function rolePicker(name, value) {
  return `<fieldset class="choice"><legend>I usually dance</legend>${DANCE_ROLES.map(([k, l]) =>
    `<label><input type="radio" name="${name}" value="${k}" ${k === value ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>`;
}
function groupPicker(groups, chosen) {
  if (!groups.length) return "";
  return `<fieldset class="choice"><legend>My groups <span class="muted small">pick any</span></legend>${groups.map((g) =>
    `<label><input type="checkbox" name="groups" value="${g.id}" ${chosen.includes(g.id) ? "checked" : ""}> ${esc(g.name)}</label>`).join("")}</fieldset>`;
}
const pickedGroups = (form) => [...form.querySelectorAll('input[name="groups"]:checked')].map((i) => +i.value);

// ── sign in ─────────────────────────────────────────────────────────────

export function renderLogin(el) {
  const pk = passkeysSupported();
  el.innerHTML = `<section class="authcard panel pad">
    <h1 class="display">Sign in</h1>
    <p class="muted">Members see lessons, videos, competitions and their own routines. New here? Ask a committee member for the society's join link.</p>
    ${pk ? `<button class="btn solid big" id="pkLogin">Sign in with a passkey</button>` : `<p class="small muted">This browser can't use passkeys, so sign in with your password.</p>`}
    <details ${pk ? "" : "open"}><summary>Use a password instead</summary>
      <form id="pwLogin" class="stack">
        <label class="field">Your name<input class="input" name="name" autocomplete="username" required maxlength="60"></label>
        <label class="field">Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn" type="submit">Sign in</button>
      </form></details>
    <p class="err" id="authErr" role="alert"></p>
  </section>`;
  const err = (e) => ($("#authErr").textContent = e.message);
  if (pk) $("#pkLogin").onclick = async () => {
    try {
      const { cid, options } = await api("POST", "/api/passkey/login/begin");
      const credential = await getPasskey(options);
      await api("POST", "/api/passkey/login/finish", { cid, credential });
      await signedIn("/");
    } catch (e) { err(e); }
  };
  $("#pwLogin").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("POST", "/api/login", Object.fromEntries(new FormData(ev.target))); await signedIn("/"); } catch (e) { err(e); }
  };
}

// ── join with an invite link ────────────────────────────────────────────

export async function renderJoin(el, token) {
  el.innerHTML = `<section class="authcard panel pad"><p class="muted">Checking your join link…</p></section>`;
  let inv;
  try { inv = await api("GET", `/api/invites/${encodeURIComponent(token)}`); }
  catch (e) { el.innerHTML = `<section class="authcard panel pad"><h1 class="display">Join Rise &amp; Fall</h1><p class="err">${esc(e.message)}</p></section>`; return; }
  const pk = passkeysSupported(), p = inv.person;
  el.innerHTML = `<section class="authcard panel pad">
    <h1 class="display">${p ? `Welcome, ${esc(p.name)}` : "Join Rise &amp; Fall"}</h1>
    <p class="muted">${p ? "Your account is ready and waiting: this link is just for you. Check your details, then choose how you'll sign in. Anything you've already been added to, like routines with a partner or your groups, is there when you arrive."
      : "Make an account to keep your own routines, see what your group covered in lessons, watch the videos and check the competitions list."}</p>
    <form id="joinForm" class="stack">
      <label class="field">Your name <span class="small">as people in the society know you</span><input class="input" name="name" autocomplete="name" required maxlength="40" value="${esc(p?.name || "")}"></label>
      ${rolePicker("dance_role", p?.dance_role || "both")}
      ${groupPicker(inv.groups, p?.groups || [])}
      <div class="pwonly" ${pk ? "hidden" : ""}><label class="field">Password <span class="small">at least 8 characters</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="8"></label></div>
      <button class="btn solid big" type="submit" id="joinBtn">${pk ? "Create account with a passkey" : "Create account"}</button>
      ${pk ? `<p class="small muted">A passkey signs you in with your fingerprint, face or device PIN. No password to remember. <button class="linkish" type="button" id="usePw">Use a password instead</button></p>` : ""}
      <p class="err" id="authErr" role="alert"></p>
    </form></section>`;
  let usePw = !pk;
  if (pk) $("#usePw").onclick = () => { usePw = true; el.querySelector(".pwonly").hidden = false; $("#joinBtn").textContent = "Create account"; $("#usePw").parentElement.hidden = true; };
  $("#joinForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target, body = { token, name: f.name.value, dance_role: f.dance_role.value, groups: pickedGroups(f) };
    try {
      if (usePw) await api("POST", "/api/join/password", { ...body, password: f.password.value });
      else {
        const { cid, options } = await api("POST", "/api/passkey/register/begin", body);
        const credential = await createPasskey(options);
        await api("POST", "/api/passkey/register/finish", { cid, credential, label: deviceLabel() });
      }
      if (["lead", "follow"].includes(body.dance_role)) { try { localStorage.removeItem("rf.role"); } catch {} S.role = null; }
      toast("Welcome! You're signed in");
      await signedIn("/");
    } catch (e) { $("#authErr").textContent = e.message; }
  };
}

// ── your account ────────────────────────────────────────────────────────

export async function renderAccount(el) {
  const me = S.me;
  el.innerHTML = `<div class="narrowpage">
    <h1 class="display">Your account</h1>
    <form id="profile" class="panel pad stack">
      <label class="field">Name<input class="input" name="name" value="${esc(me.name)}" required maxlength="40"></label>
      ${rolePicker("dance_role", me.dance_role)}
      ${groupPicker(S.groups, me.groups)}
      <div class="row"><button class="btn solid" type="submit">Save</button><span class="muted small">Role: ${esc(me.role === "admin" ? "Site admin" : me.role === "committee" ? "Committee" : "Member")}</span></div>
    </form>
    <section class="panel pad stack">
      <div class="sec-title flush"><span>Passkeys</span></div>
      <div id="keys"><p class="muted small">Loading…</p></div>
      ${passkeysSupported() ? `<button class="btn" id="addKey">Add a passkey on this device</button>` : `<p class="small muted">This browser can't make passkeys.</p>`}
    </section>
    <section class="panel pad stack">
      <div class="sec-title flush"><span>Password</span></div>
      <p class="small muted">${me.has_password ? "You can also sign in with a password." : "You sign in with passkeys only. A password is a fallback for browsers without passkeys."}</p>
      <form id="pwForm" class="row"><input class="input grow" name="password" type="password" autocomplete="new-password" minlength="8" placeholder="${me.has_password ? "New password" : "Set a password"}" required><button class="btn" type="submit">${me.has_password ? "Change" : "Set password"}</button></form>
      ${me.has_password ? `<button class="btn ghost sm danger" id="rmPw">Remove my password</button>` : ""}
    </section>
    <button class="btn ghost" id="signOut2">Sign out</button>
  </div>`;
  loadKeys();
  $("#profile").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (await attempt(() => api("PATCH", "/api/account", { name: f.name.value, dance_role: f.dance_role.value, groups: pickedGroups(f) }), "Saved")) { await loadMe(); hooks.render(); }
  };
  if ($("#addKey")) $("#addKey").onclick = async () => {
    try {
      const { cid, options } = await api("POST", "/api/passkey/register/begin", {});
      const credential = await createPasskey(options);
      await api("POST", "/api/passkey/register/finish", { cid, credential, label: deviceLabel() });
      toast("Passkey added"); await loadMe(); hooks.render();
    } catch (e) { toast(e.message); }
  };
  $("#pwForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (await attempt(() => api("PUT", "/api/account/password", { password: ev.target.password.value }), "Password saved")) { await loadMe(); hooks.render(); }
  };
  if ($("#rmPw")) $("#rmPw").onclick = async (ev) => {
    if (!confirmTap(ev.target, "Sure? Passkeys only")) return;
    if (await attempt(() => api("DELETE", "/api/account/password"), "Password removed")) { await loadMe(); hooks.render(); }
  };
  $("#signOut2").onclick = () => api("POST", "/api/logout").finally(() => { S.me = null; location.href = BASE + "/"; });
}

async function loadKeys() {
  const keys = await attempt(() => api("GET", "/api/account/passkeys"));
  const el = $("#keys"); if (!el || !keys) return;
  el.innerHTML = keys.length ? `<ul class="keys">${keys.map((k) => `<li><span><b>${esc(k.label)}</b><br><span class="small muted">Added ${fmtDate(k.created_at)}${k.last_used ? ` · last used ${fmtDate(k.last_used)}` : ""}</span></span>
    <button class="btn sm ghost danger" data-key="${esc(k.id)}">Remove</button></li>`).join("")}</ul>` : `<p class="small muted">No passkeys yet.</p>`;
  el.onclick = async (ev) => {
    const b = ev.target.closest("[data-key]"); if (!b) return;
    if (!confirmTap(b, "Remove?")) return;
    if (await attempt(() => api("DELETE", `/api/account/passkeys/${encodeURIComponent(b.dataset.key)}`), "Passkey removed")) { await loadMe(); loadKeys(); }
  };
}
