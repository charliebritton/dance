// App shell: routing, header and nav (by role), hero, and polling so everyone sees each other's changes.
import { drawFrame, makePlayer } from "./engine.js";
import { BASE, $, S, api, hooks, isAdmin, layersFor, loadMe, loadSyllabus, ls, refresh } from "./core.js";
import * as home from "./views/home.js";
import * as syllabus from "./views/syllabus.js";
import * as routines from "./views/routines.js";
import * as practice from "./views/practice.js";
import * as lessons from "./views/lessons.js";
import * as competitions from "./views/competitions.js";
import * as admin from "./views/admin.js";
import { renderAccount, renderJoin, renderLogin } from "./views/auth.js";

const VIEWS = { home, syllabus, routines, practice, lessons, competitions, admin };
const MEMBERS_ONLY = new Set(["routines", "practice", "lessons", "competitions", "admin", "account"]);
let current = { view: "home", params: {} };

function parse() {
  const [a, b, c] = location.pathname.slice(BASE.length).split("/").filter(Boolean);
  switch (a) {
    case undefined: case "home": return { view: "home", params: {} };
    case "syllabus": return { view: "syllabus", params: { dance: b, fig: c } };
    case "routines": return { view: "routines", params: { id: b } };
    case "practice": return b === "lesson" ? { view: "practice", params: { lesson: c } } : { view: "practice", params: { id: b } };
    case "lessons": return { view: "lessons", params: { id: b } };
    case "competitions": case "admin": case "account": case "login": return { view: a, params: {} };
    case "join": return { view: "join", params: { token: b } };
    default: return { view: "syllabus", params: { dance: a, fig: b } };
  }
}

function header() {
  const tabs = [["home", "Home"], ["syllabus", "Syllabus"], ...(S.me ? [["routines", "Routines"], ["lessons", "Lessons"], ["competitions", "Competitions"]] : []),
    ...(isAdmin() ? [["admin", "Admin"]] : [])];
  $("#nav").innerHTML = tabs.map(([n, l]) =>
    `<a href="${BASE}/${n === "home" ? "" : n}" data-link class="tab" aria-current="${current.view === n || (n === "routines" && current.view === "practice") ? "page" : "false"}">${l}</a>`).join("");
  $("#roleSeg").innerHTML = [["man", "Leader"], ["lady", "Follower"], ["both", "Both"]].map(([k, l]) =>
    `<button data-role="${k}" aria-pressed="${S.role === k}">${l}</button>`).join("");
  $("#stepsFor").hidden = !["syllabus", "practice"].includes(current.view);
  $("#acct").innerHTML = S.me
    ? `<a class="acctlink" href="${BASE}/account" data-link aria-current="${current.view === "account" ? "page" : "false"}">${S.me.name.split(" ")[0]}</a>`
    : `<a class="btn sm acc" href="${BASE}/login" data-link>Sign in</a>`;
}

function hero() {
  const show = current.view === "home" && !S.me;
  $("#hero").hidden = !show;
  if (!show) { heroPlayer.pause(); return; }
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
  hero();
  const root = $("#view");
  if (current.view !== "syllabus") syllabus.stopSyllabus();
  if (current.view !== "practice") practice.stopPractice();
  root.onclick = root.onchange = root.oninput = root.onsubmit = root.onkeydown = null;
  if (current.view === "login") return renderLogin(root);
  if (current.view === "join") return renderJoin(root, current.params.token);
  if (current.view === "account") return renderAccount(root);
  VIEWS[current.view].render(root, current.params);
}

function route() {
  current = parse();
  if (MEMBERS_ONLY.has(current.view) && !S.me) { history.replaceState(null, "", BASE + "/login"); current = { view: "login", params: {} }; }
  if (current.view === "admin" && !isAdmin()) { history.replaceState(null, "", BASE + "/"); current = { view: "home", params: {} }; }
  if (S.me && (current.view === "login" || current.view === "join")) { history.replaceState(null, "", BASE + "/"); current = { view: "home", params: {} }; }
  render();
  window.scrollTo({ top: 0 });
}
hooks.render = render;
hooks.route = route;
hooks.headerOnly = () => header();

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
  if (document.hidden || ["login", "join", "account", "admin"].includes(current.view)) return;
  try {
    await refresh();
    const sig = stateSig();
    if (sig === lastState) return;
    const first = !lastState; lastState = sig;
    if (first) return;
    const a = document.activeElement;
    const typing = a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox") || a.tagName === "SELECT");
    if (typing || VIEWS[current.view]?.isBusy?.()) return;
    render();
  } catch {}
}
const stateSig = () => JSON.stringify([S.routines, S.charts, S.verified, S.notes, S.videos, S.users, S.lessons, S.competitions, S.comment_counts]);
setInterval(poll, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

async function boot() {
  try { await loadSyllabus(); await loadMe(); await refresh(); lastState = stateSig(); }
  catch { $("#view").innerHTML = `<div class="panel pad empty">Couldn't reach the server. Check your connection and reload.</div>`; return; }
  route();
}
boot();
