// App shell: sign-in, routing, header, hero, and polling so each partner sees the other's changes.
import { drawFrame, makePlayer } from "./engine.js";
import { BASE, $, $$, S, api, esc, hooks, layersFor, loadSyllabus, ls, refresh, toast } from "./core.js";
import * as syllabus from "./views/syllabus.js";
import * as routines from "./views/routines.js";
import * as practice from "./views/practice.js";

const VIEWS = { syllabus, routines, practice };
let current = { view: "syllabus", params: {} };

function parse() {
  const [a, b, c] = location.pathname.slice(BASE.length).split("/").filter(Boolean);
  if (a === "routines") return { view: "routines", params: { id: b } };
  if (a === "practice") return { view: "practice", params: { id: b } };
  if (a === "login") return { view: "login", params: {} };
  return { view: "syllabus", params: { dance: b, fig: c } };
}

function header() {
  $("#nav").innerHTML = ["syllabus", "routines", "practice"].map((n) =>
    `<a href="${BASE}/${n}" data-link class="tab" aria-current="${current.view === n ? "page" : "false"}">${n[0].toUpperCase() + n.slice(1)}</a>`).join("");
  $("#roleSeg").innerHTML = [["man", "Leader"], ["lady", "Follower"], ["both", "Both"]].map(([k, l]) =>
    `<button data-role="${k}" aria-pressed="${S.role === k}">${l}</button>`).join("");
  $("#who").textContent = S.me?.name || "";
}

function hero() {
  const show = current.view === "syllabus" && !current.params.fig && !current.params.dance;
  $("#hero").hidden = !show;
  if (!show) { heroPlayer.pause(); return; }
  $("#sFigs").textContent = S.figs.size;
  $("#sCharts").textContent = new Set([...Object.keys(S.starter), ...Object.keys(S.charts)]).size;
  $("#sRoutines").textContent = S.routines.length;
  if (!heroLayers) {
    heroPaint(-1);
    let t = 0;
    heroPlayer.load(heroLayers[0].steps.map((s) => { const e = { start: t, dur: +s.b || 1 }; t += e.dur; return e; }), { bpm: 66, bpb: 3, loop: true, metro: false });
  }
  if (!heroPlayer.playing && !matchMedia("(prefers-reduced-motion: reduce)").matches) heroPlayer.play(0);
  else if (!heroPlayer.playing) heroPaint(5.999);
}
let heroLayers = null;
const heroPaint = (pos) => {
  const svg = $("#heroSvg"); if (!svg) return;
  heroLayers ||= (() => { const l = layersFor(S.starter["waltz.natural-turn"], { style: "Standard" }, "man"); l[0].color = "var(--hero-fg)"; l[0].bodyColor = "var(--hero-fg)"; return l; })();
  drawFrame(svg, heroLayers, pos, { room: false, min: 150 });
};
const heroPlayer = makePlayer((i, f) => heroPaint(i + f));

export function render() {
  header();
  const root = $("#view");
  if (current.view === "login") return;
  hero();
  if (current.view !== "syllabus") syllabus.stopSyllabus();
  if (current.view !== "practice") practice.stopPractice();
  VIEWS[current.view].render(root, current.params);
  if (S.me?.readonly) lockInputs(root);
}

// public preview: nothing can be saved, so editing fields become read-only (pickers and playback still work)
function lockInputs(root) {
  for (const el of root.querySelectorAll("#figNote, #rName, #rLevel, #rBrief, .item input")) el.disabled = true;
}

function route() {
  current = parse();
  if (S.me?.readonly && current.view === "login") { history.replaceState(null, "", BASE + "/syllabus"); current = parse(); }
  if (current.view === "login" || !S.me) { showLogin(); return; }
  document.body.classList.remove("signed-out");
  render();
  window.scrollTo({ top: 0 });
}
hooks.render = render;
hooks.route = route;

function showLogin() {
  document.body.classList.add("signed-out");
  $("#hero").hidden = true;
  if (location.pathname !== BASE + "/login") history.replaceState(null, "", BASE + "/login");
  const mode = ls.get("loginMode", "in");
  $("#view").innerHTML = `<section class="login panel pad">
    <h1 class="display">${mode === "in" ? "Sign in" : "Create your account"}</h1>
    <p class="muted">${mode === "in" ? "Rise & Fall is shared between you and your partner." : "You'll need the invite code from whoever set up the site."}</p>
    <form id="authForm" class="stack">
      <label class="field">Your name<input class="input" name="name" autocomplete="username" required maxlength="40"></label>
      <label class="field">Password<input class="input" name="password" type="password" autocomplete="${mode === "in" ? "current-password" : "new-password"}" required minlength="6"></label>
      ${mode === "up" ? `<label class="field">Invite code<input class="input" name="invite" required></label>` : ""}
      <button class="btn solid" type="submit">${mode === "in" ? "Sign in" : "Create account"}</button>
      <p class="err" id="authErr" role="alert"></p>
    </form>
    <button class="btn ghost sm" id="authSwap">${mode === "in" ? "New here? Create an account" : "Already have an account? Sign in"}</button>
  </section>`;
  $("#authSwap").onclick = () => { ls.set("loginMode", mode === "in" ? "up" : "in"); showLogin(); };
  $("#authForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(ev.target));
    try {
      await api("POST", mode === "in" ? "/api/login" : "/api/signup", fd);
      S.me = await api("GET", "/api/me"); await refresh();
      history.replaceState(null, "", BASE + "/syllabus"); route();
    } catch (e) { $("#authErr").textContent = e.message; }
  };
}

// ── global events ────────────────────────────────────────────────────
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a[data-link]");
  if (a && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey) {
    ev.preventDefault();
    if (a.getAttribute("href") !== location.pathname) history.pushState(null, "", a.getAttribute("href"));
    route();
    return;
  }
  const role = ev.target.closest("#roleSeg [data-role]");
  if (role) { S.role = role.dataset.role; ls.set("role", S.role); render(); return; }
  if (ev.target.closest("#signOut")) api("POST", "/api/logout").finally(() => { S.me = null; location.href = BASE + "/login"; });
});
window.addEventListener("popstate", route);

// notation tooltips: hover on desktop, tap on phones
const tipbox = Object.assign(document.createElement("div"), { className: "tipbox", hidden: true, role: "tooltip" });
document.body.append(tipbox);
let tipFor = null;
function showTip(el) {
  tipFor = el; tipbox.textContent = el.dataset.tip; tipbox.hidden = false;
  const r = el.getBoundingClientRect(), b = tipbox.getBoundingClientRect();
  let x = Math.min(Math.max(12, r.left + r.width / 2 - b.width / 2), innerWidth - b.width - 12);
  let y = r.top - b.height - 10, below = y < 70;
  if (below) y = r.bottom + 10;
  tipbox.classList.toggle("below", below);
  tipbox.style.left = x + "px"; tipbox.style.top = y + "px";
  tipbox.style.setProperty("--ax", Math.min(b.width - 12, Math.max(12, r.left + r.width / 2 - x)) + "px");
}
const hideTip = () => { tipbox.hidden = true; tipFor = null; };
document.addEventListener("pointerover", (e) => { const t = e.target.closest?.("[data-tip]"); if (t && e.pointerType === "mouse") showTip(t); });
document.addEventListener("pointerout", (e) => { if (e.pointerType === "mouse" && tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); });
document.addEventListener("click", (e) => { const t = e.target.closest?.("[data-tip]"); if (t && t !== tipFor) { e.stopPropagation(); showTip(t); } else if (!t) hideTip(); }, true);
addEventListener("scroll", hideTip, { passive: true, capture: true });

// pick up your partner's changes without trampling what you're doing
let lastState = "";
async function poll() {
  if (!S.me || document.hidden) return;
  try {
    await refresh();
    const sig = JSON.stringify([S.routines, S.charts, S.notes, S.videos, S.users]);
    if (sig === lastState) return;
    const first = !lastState; lastState = sig;
    if (first) return;
    const a = document.activeElement;
    const typing = a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox") || a.tagName === "SELECT");
    if (typing || VIEWS[current.view]?.isBusy?.()) return;
    render();
  } catch (e) { if (e.status === 401) location.href = BASE + "/login"; }
}
setInterval(poll, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

async function boot() {
  try { await loadSyllabus(); }
  catch { $("#view").innerHTML = `<div class="panel pad empty">Couldn't reach the server. Check your connection and reload.</div>`; return; }
  try { S.me = await api("GET", "/api/me"); await refresh(); lastState = JSON.stringify([S.routines, S.charts, S.notes, S.videos, S.users]); }
  catch { S.me = null; }
  if (S.me?.readonly) { document.body.classList.add("readonly"); $("#roBanner").hidden = false; }
  if (S.me && location.pathname === BASE + "/login") history.replaceState(null, "", BASE + "/syllabus");
  route();
}
boot();
