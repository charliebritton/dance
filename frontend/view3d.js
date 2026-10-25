// The switch between footprints and 3D dancers, shared by the figure page and the routine player, and the one 3D
// stage (one WebGL context) both draw on. three.js loads only once someone picks "3D dancers".
import { $, esc, ls } from "./core.js";

export const s3 = { three: null, stage: null };          // stage: null = not loaded yet, false = can't start here
export const mode = () => (ls.get("stage", "3d") === "3d" && s3.stage !== false ? "3d" : "2d");

export async function load3d() {
  if (s3.stage != null) return s3.stage;
  try { s3.three = await import("./dancers3d.js"); }
  catch (e) { console.error(e); s3.stage = false; return false; }
  s3.stage = s3.three.createStage({ onView: (x) => { ls.set("view3", x); const sel = $("#cam3"); if (sel) sel.value = x; } }) || false;
  if (s3.stage) { s3.stage.setScene(ls.get("scene3", "ballroom")); s3.stage.setView(ls.get("view3", "orbit")); }
  return s3.stage;
}

const opts = (list, val) => Object.entries(list).map(([k, l]) => `<option value="${k}" ${k === val ? "selected" : ""}>${esc(l)}</option>`).join("");

/** Footprints / 3D buttons, and the camera and setting choices while in 3D. */
export function stageBar() {
  const { three, stage } = s3;
  return `<div class="stagebar"><div class="seg" role="group" aria-label="Show as">${[["2d", "Footprints"], ["3d", "3D dancers"]].map(([k, l]) =>
    `<button type="button" data-mode="${k}" aria-pressed="${mode() === k}">${l}</button>`).join("")}</div>
    ${stage === false ? `<span class="small warn">3D can't start here: ${esc(three?.failure || "the 3D code didn't load")}. In Firefox, look under WebGL in about:support; in Chrome, chrome://gpu.</span>` : ""}
    ${mode() === "3d" && three && stage ? `<select class="input auto sm" id="cam3" aria-label="Camera">${opts(three.VIEWS, stage.view)}</select><select class="input auto sm" id="scene3" aria-label="Setting">${opts(three.SCENES, stage.scene)}</select>` : ""}</div>`;
}

/** Handles the switch buttons. Returns true when it did something; rerender redraws the page. */
export async function onStageClick(ev, rerender) {
  const md = ev.target.closest("[data-mode]");
  if (!md) return false;
  ls.set("stage", md.dataset.mode);
  if (md.dataset.mode === "3d") await load3d();
  rerender();
  return true;
}

/** Handles the camera and setting choices. Returns true when it did something; redraw repaints the frame. */
export function onStageChange(t, redraw) {
  const { stage } = s3;
  if (!stage || (t.id !== "cam3" && t.id !== "scene3")) return false;
  if (t.id === "cam3") { ls.set("view3", t.value); stage.setView(t.value); }
  else { ls.set("scene3", t.value); stage.setScene(t.value); }
  redraw();
  return true;
}
