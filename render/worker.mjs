// Render worker: films each figure's 3D dancers frame by frame in a headless browser and encodes an MP4 with ffmpeg.
// Run it on any machine with a GPU (your own, or a render farm box). It asks the server which figures need a
// video (new, or the chart was edited since its last render), renders them and uploads the results.
//
//   node worker.mjs --server https://chza.me/dance --token $RENDER_TOKEN            render everything that's due
//   node worker.mjs --server … --fig chacha.new-york --out ./clips --no-upload       one figure, keep it locally
//
// Use a machine with a GPU (laptop, NAS, farm), never the small VPS: software rendering there is ~2.5 s a frame.
// Needs ffmpeg on the PATH and a Chromium: `npx playwright install chromium`, or --chrome /path/to/chrome.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { setPriority } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2), opt = { figs: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => args[++i];
  if (a === "--server") opt.server = next().replace(/\/$/, "");
  else if (a === "--token") opt.token = next();
  else if (a === "--fig") opt.figs.push(next());
  else if (a === "--out") opt.out = next();
  else if (a === "--size") opt.size = +next();
  else if (a === "--fps") opt.fps = +next();
  else if (a === "--chrome") opt.chrome = next();
  else if (a === "--no-upload") opt.noUpload = true;
  else if (a === "--all") opt.all = true;
  else if (a === "--software") opt.software = true;
  else { console.error("Unknown option " + a); process.exit(2); }
}
opt.token ||= process.env.RENDER_TOKEN;
opt.size ||= 960; opt.fps ||= 50; opt.out ||= "./clips";
if (!opt.server) { console.error("Pass --server, e.g. --server https://chza.me/dance"); process.exit(2); }
const upload = !opt.noUpload;
if (upload && !opt.token) { console.error("Uploading needs --token (or RENDER_TOKEN). Use --no-upload to keep clips locally."); process.exit(2); }
mkdirSync(opt.out, { recursive: true });
// Lowest CPU priority for this process and the browser it starts, so the machine stays usable. For hard caps run it
// in a container (docker run --cpus 2 --memory 2g …) or under systemd-run -p CPUQuota=… -p MemoryMax=….
try { setPriority(19); } catch {}

const auth = opt.token ? { Authorization: "Bearer " + opt.token } : {};
async function jobs() {
  const q = new URLSearchParams();
  if (opt.all || opt.figs.length) q.set("all", "1");
  const r = await fetch(`${opt.server}/api/render/jobs?${q}`, { headers: auth });
  if (!r.ok) throw new Error(`Job list: ${r.status} ${await r.text()}`);
  const list = (await r.json()).jobs;
  return opt.figs.length ? list.filter((j) => opt.figs.includes(j.fig)) : list;
}

function encoder(file) {
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(opt.fps), "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((ok, bad) => ff.on("close", (c) => (c ? bad(new Error("ffmpeg exited " + c)) : ok())));
  return { write: (buf) => new Promise((ok) => (ff.stdin.write(buf) ? ok() : ff.stdin.once("drain", ok))), end: () => (ff.stdin.end(), done) };
}

const gpu = opt.software ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--enable-gpu", "--ignore-gpu-blocklist", "--use-gl=angle"];
const browser = await chromium.launch({ executablePath: opt.chrome, args: ["--no-sandbox", "--renderer-process-limit=1", ...gpu] });
const page = await browser.newPage({ viewport: { width: opt.size, height: opt.size } });
page.on("pageerror", (e) => console.error("page:", e.message));
await page.goto(`${opt.server}/static/render.html`);
const renderer = await page.evaluate(() => window.gl?.() || "");

const todo = await jobs();
console.log(`${todo.length} figure${todo.length === 1 ? "" : "s"} to render${renderer ? " · " + renderer : ""}`);
let n = 0;
for (const job of todo) {
  const t0 = Date.now();
  const info = await page.evaluate((f) => window.setupFigure(f), job.fig);
  const frames = Math.ceil(info.duration * opt.fps), file = join(opt.out, `${job.fig}.mp4`);
  const enc = encoder(file);
  for (let i = 0; i < frames; i++) {
    const url = await page.evaluate((t) => window.frame(t), i / opt.fps);
    await enc.write(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  }
  await enc.end();
  let note = "kept locally";
  if (upload) {
    const fd = new FormData();
    fd.append("file", new Blob([readFileSync(file)], { type: "video/mp4" }), `${job.fig}.mp4`);
    for (const [k, v] of Object.entries({ hash: job.hash, rig: info.rig, fps: opt.fps, bpm: info.bpm, lead: info.lead, tail: info.tail, size: opt.size })) fd.append(k, String(v));
    const r = await fetch(`${opt.server}/api/render/${encodeURIComponent(job.fig)}`, { method: "PUT", headers: auth, body: fd });
    note = r.ok ? "uploaded" : `upload failed: ${r.status} ${await r.text()}`;
  }
  console.log(`[${++n}/${todo.length}] ${job.fig} · ${frames} frames · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${note}`);
}
await browser.close();
