// Recording a lesson in the browser: MediaRecorder, a screen wake lock, and every 10 s of audio saved to IndexedDB as it
// comes, so a reload, a crash or the phone killing the tab doesn't lose the lesson (the lesson page offers what's left).
// Phones: iPhone Safari stops the microphone when the screen locks or another app comes to the front, so the screen has
// to stay on (the wake lock does that). Android Chrome usually keeps recording with the screen off. A watch or phone
// voice-memo app is the safe choice for a pocket: record there, then upload the file.

const MIMES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
export const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
export const extFor = (mime) => (mime.includes("mp4") ? ".m4a" : mime.includes("ogg") ? ".ogg" : ".webm");

// state: "idle" | "recording" | "stopped"; stoppedBy: "you" | "phone" (the microphone was taken away)
export const rec = { state: "idle", id: null, lesson: null, started: 0, ms: 0, size: 0, mime: "", locked: false, stoppedBy: "", gaps: 0 };
let mr = null, stream = null, lock = null, done = null, changed = () => {};

// ── IndexedDB: meta {id, lesson, started, ms, mime, size}; chunks {rec, n, blob} ──
function idb() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open("rf-recordings", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("meta", { keyPath: "id" });
      r.result.createObjectStore("chunks", { keyPath: ["rec", "n"] });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function store(names, mode, fn) {
  const db = await idb();
  return new Promise((ok, fail) => {
    const t = db.transaction(names, mode), out = fn(...names.map((n) => t.objectStore(n)));
    t.oncomplete = () => { db.close(); ok(out?.result ?? out); };
    t.onerror = () => { db.close(); fail(t.error); };
  });
}
const saveMeta = () => store(["meta"], "readwrite", (m) => m.put({ id: rec.id, lesson: rec.lesson, started: rec.started, ms: rec.ms, mime: rec.mime, size: rec.size })).catch(() => {});

/** Recordings of this lesson that were never sent (not the one going now). */
export async function leftovers(lessonId) {
  try {
    const all = await store(["meta"], "readonly", (m) => m.getAll());
    return all.filter((x) => x.lesson === lessonId && x.id !== (rec.state === "recording" ? rec.id : null) && x.size > 0);
  } catch { return []; }
}
export async function blobOf(id) {
  const meta = await store(["meta"], "readonly", (m) => m.get(id));
  const chunks = await store(["chunks"], "readonly", (c) => c.getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
  return new Blob(chunks.map((c) => c.blob), { type: meta?.mime || "audio/webm" });
}
export async function forget(id) {
  await store(["meta", "chunks"], "readwrite", (m, c) => { m.delete(id); c.delete(IDBKeyRange.bound([id, 0], [id, Infinity])); }).catch(() => {});
  if (rec.id === id && rec.state !== "recording") Object.assign(rec, { state: "idle", id: null, ms: 0, size: 0, stoppedBy: "", gaps: 0 });
}

// ── keeping the screen on ──
async function wake() {
  try { lock = await navigator.wakeLock?.request("screen"); rec.locked = !!lock; lock?.addEventListener("release", () => { rec.locked = false; changed(); }); }
  catch { rec.locked = false; }
}
// the browser drops the lock whenever the page is hidden; take it again on the way back
document.addEventListener("visibilitychange", () => { if (!document.hidden && rec.state === "recording") wake(); });

export async function start(lessonId, onChange) {
  if (rec.state === "recording") return;
  changed = onChange || (() => {});
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, autoGainControl: true } });
  const mime = MIMES.find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
  mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
  Object.assign(rec, { state: "recording", id: "r" + Date.now().toString(36), lesson: lessonId, started: Date.now(), ms: 0, size: 0,
    mime: mr.mimeType || mime || "audio/webm", stoppedBy: "", gaps: 0 });
  let n = 0;
  mr.ondataavailable = (e) => {
    if (!e.data.size) return;
    rec.size += e.data.size; rec.ms = Date.now() - rec.started;
    const k = n++;
    store(["chunks"], "readwrite", (c) => c.put({ rec: rec.id, n: k, blob: e.data })).then(saveMeta, () => {});
  };
  const track = stream.getAudioTracks()[0];
  track.onmute = () => { rec.gaps++; changed(); };
  track.onended = () => { if (mr?.state === "recording") { rec.stoppedBy = "phone"; mr.stop(); } };
  done = new Promise((ok) => (mr.onstop = () => {
    rec.ms = Date.now() - rec.started; rec.state = "stopped"; rec.stoppedBy ||= "phone";
    stream.getTracks().forEach((t) => t.stop()); lock?.release().catch(() => {}); lock = null;
    setTimeout(async () => { await saveMeta(); ok(); changed(); }, 300);   // let the last chunk land in IndexedDB
  }));
  mr.onerror = () => { if (mr.state !== "inactive") mr.stop(); };
  mr.start(10000);
  await saveMeta();
  await wake();
  changed();
}

/** Stop and return the recording's id (its audio is in IndexedDB until it's sent). */
export async function stop() {
  if (rec.state !== "recording") return rec.id;
  rec.stoppedBy = "you";
  mr.stop();
  await done;
  return rec.id;
}

// a reload or closing the tab would end the recording (what's saved so far stays in IndexedDB), so ask first
addEventListener("beforeunload", (e) => { if (rec.state === "recording") e.preventDefault(); });

export const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
