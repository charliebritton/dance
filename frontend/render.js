// Films one figure for the render worker: setupFigure(id) then frame(seconds) → PNG data URL, one call per frame.
import { S, api, chartFor, danceOf, layersFor, loadSyllabus, setAccent, tempoMid } from "./core.js";
import { RIG, createStage } from "./dancers3d.js";

const stage = createStage({ capture: true });
let ctx = null;

async function load() {
  if (S.dances.length) return;
  await loadSyllabus();
  S.charts = (await api("GET", "/api/state")).charts || {};
}

/** Lead-in and tail are beats of standing still before and after the figure, so the clip loops cleanly. */
window.setupFigure = async (fig, o = {}) => {
  await load();
  const f = S.figs.get(fig), c = chartFor(fig);
  if (!f || !c) throw new Error("No chart for " + fig);
  const d = danceOf(f.dance);
  setAccent(d.id);
  const layers = layersFor(c, d, "both"), steps = layers[0].steps;
  const bpm = o.bpm || tempoMid(d) * d.bpb, lead = o.lead ?? 1, tail = o.tail ?? 1;
  let t = 0;
  const starts = steps.map((s) => { const a = t; t += +s.b || 1; return a; });
  ctx = { layers, latin: d.style === "Latin", steps, starts, spb: 60 / bpm, lead, beats: t };
  stage.setScene(o.scene || "ballroom"); stage.setView(o.view || "orbit");
  stage.mount(document.getElementById("stage"));
  window.frame(0);
  await stage.ready;
  return { fig, rig: RIG, name: f.name, dance: d.id, bpm, lead, tail, beats: t, duration: (t + lead + tail) * ctx.spb };
};

/** Where the figure is, as drawFrame's position (step index + progress), at beat b of the figure. */
function posAt(b) {
  const { steps, starts } = ctx;
  if (b < 0) return -1;
  for (let k = steps.length - 1; k >= 0; k--) if (b >= starts[k]) return Math.min(k + (b - starts[k]) / (+steps[k].b || 1), steps.length);
  return -1;
}

/** Which GPU the browser is drawing with, so the worker can say whether it's hardware or software. */
window.gl = () => { const g = stage.canvas.getContext("webgl2"), x = g?.getExtension("WEBGL_debug_renderer_info"); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : ""; };

window.frame = (sec, type = "image/png") => {
  stage.draw(ctx.layers, posAt(sec / ctx.spb - ctx.lead), { latin: ctx.latin, time: sec });
  return stage.canvas.toDataURL(type);
};

// preview: render.html?fig=… plays the figure in a loop
const q = new URLSearchParams(location.search);
if (q.get("fig")) {
  const info = await window.setupFigure(q.get("fig"), { scene: q.get("scene"), view: q.get("view") });
  const t0 = performance.now();
  const tick = (now) => { window.frame(((now - t0) / 1000) % info.duration); if (!q.has("still")) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
