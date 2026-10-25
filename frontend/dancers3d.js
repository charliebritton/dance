// Low-poly 3D dancers. The chart's footprints (engine.simulate) drive two simple figures: feet follow the
// footprint paths, the hips follow the weight, legs and arms are solved with two-bone IK, and the hold is worked
// out from where the partners are. Rendered in the browser with three.js, so nothing is generated on the server.
// three.js r162 is vendored on purpose: the last release that falls back to WebGL 1 when WebGL 2 is off or blocked.
// Same timing input as drawFrame: step index + progress through that step (-1 = the starting position).
import * as THREE from "./vendor/three.module.min.js";
import { along } from "./engine.js";
import { makeSkirt } from "./cloth.js";

export const RIG = "4";                         // bump when the rig changes, so the server asks for fresh renders
import { UNITS_PER_M as U } from "./floor.js";   // engine units per metre
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0), Y = V(0, 1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
const rad = (d) => (d * Math.PI) / 180;
const fwdOf = (h) => V(Math.sin(rad(h)), 0, -Math.cos(rad(h)));     // engine heading → world direction
const rightOf = (h) => V(Math.cos(rad(h)), 0, Math.sin(rad(h)));
const world = (p) => V(p.x / U, 0, p.y / U);

// body sizes in metres (the follower is drawn at 94%)
const BODY = { thigh: 0.45, shin: 0.44, ankle: 0.075, hip: 0.09, torso: 0.5, shoulder: 0.19, upper: 0.29, fore: 0.27, head: 0.105 };

/** Rise and fall through one step, read from the chart's rise and fall column as the technique book words it
 *  ("Commence to rise e/o 1", "Continue to rise on 2 and 3", "Up on 3, lower e/o 3", "NFR", "No rise"…).
 *  start is the level carried in from the step before (0 = down, 1 = fully up); at(e) the level through the step. */
function riseShape(rf, start) {
  const t = String(rf || "").toLowerCase(), late = /e\/o|end of/.test(t);
  let main = start, lateRise = false;
  if (/no rise/.test(t)) main = 0;
  else if (/commence to rise/.test(t)) { main = Math.max(start, 0.3); lateRise = late; }
  else if (/slight rise/.test(t)) { main = Math.max(start, 0.2); lateRise = late; }
  else if (/continue to rise/.test(t)) main = Math.max(start + 0.35, 0.65);
  else if (/\bup\b/.test(t)) main = 1;
  else if (/hover/.test(t)) main = 0.85;
  else if (/\brise\b/.test(t)) { main = Math.max(start, 0.6); lateRise = late; }
  else if (/^\s*lower\b/.test(t) && !late) main = 0;
  main = Math.min(1, main);
  const lowerEnd = /lower (e\/o|at the end|at end|end of)/.test(t);
  return {
    nfr: /\bnfr\b|no foot rise/.test(t), flex: /flex/.test(t), end: lowerEnd ? 0 : main,
    at(e) {
      let v = lateRise ? lerp(start, main, ease(clamp((e - 0.6) / 0.4, 0, 1))) : lerp(start, main, ease(clamp(e / 0.75, 0, 1)));
      if (lowerEnd) v = lerp(v, 0, ease(clamp((e - 0.7) / 0.3, 0, 1)));
      return v;
    },
  };
}

/** Footwork column, cleaned: "T (RF: TH)" → "T", "IE of B, F" → "BF", "HT, then flat" → "HTF". */
const fwOf = (fw) => String(fw || "").replace(/\(.*?\)/g, "").replace(/IE of/gi, "").replace(/then flat/gi, "F").replace(/[^HTBFW]/gi, "").toUpperCase();

/** Where everything is for one dancer at time pos. */
function poseOf(layer, pos, latin, s) {
  const P = layer.sim.prints, steps = layer.steps, n = steps.length;
  let cur = pos < 0 ? -1 : Math.min(n - 1, Math.floor(pos));
  const e = pos < 0 ? 0 : pos >= n ? 1 : ease(clamp((pos - cur) / 0.9, 0, 1));
  const feet = { L: { p: P[0], fw: "", at: -1 }, R: { p: P[1], fw: "", at: -1 } };
  let sup = { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 }, side = 0, sway = 0, h = P[0].h;
  const swayOf = (k) => ({ L: -1, R: 1 }[steps[k]?.sw] || 0);
  let level = 0;                                    // rise and fall carried from step to step
  for (let k = 0; k < cur; k++) {
    const p = P[k + 2], st = steps[k];
    feet[p.foot] = { p, fw: fwOf(st.fw), at: k };
    if (p.w) { sup = p; side = p.foot === "R" ? 1 : -1; }
    sway = swayOf(k); h = p.body ?? p.h;
    if (!latin) level = riseShape(st.rf, level).end;
  }
  const shape = !latin && cur >= 0 ? riseShape(steps[cur].rf, level) : null;
  const lvl = shape ? shape.at(e) : 0, nfr = !!shape?.nfr;
  const out = { feet: {}, h, level: lvl };
  // knees: soft when down, straighter as the body rises; "flex the knees" goes lower; Latin keeps straight legs
  out.flexDrop = latin ? 0.004 : shape?.flex ? 0.09 : 0.012 + 0.045 * (1 - lvl);
  const st0 = cur >= 0 ? steps[cur] : null;
  out.pp = !!st0 && (/\bPP\b|promenade/i.test((st0.p || "") + " " + (st0.al || "")) || !!st0.mv);
  let w = 0, m = null, prevSup = sup, prevSide = side;
  if (cur >= 0) {
    m = P[cur + 2];
    const st = steps[cur];
    w = m.w ? ease(clamp((e - 0.15) / 0.85, 0, 1)) : 0;
    out.h = lerp(m.bodyFrom ?? h, m.body ?? m.h, e);
    sway = lerp(sway, swayOf(cur), e);
    if (m.w) { sup = { x: lerp(prevSup.x, m.x, w), y: lerp(prevSup.y, m.y, w) }; side = lerp(prevSide, m.foot === "R" ? 1 : -1, w); }
  }
  for (const f of ["L", "R"]) {
    const moving = m && m.foot === f;
    if (moving) {
      const q = along(m, e), dist = Math.hypot(m.x - m.from.x, m.y - m.from.y);
      const air = dist > 6 ? Math.sin(Math.PI * e) : 0;
      // Latin: the foot travels with a pointed toe and lands ball then flat. Standard: a heel lead (H…) lifts the toe
      // just before it lands; a toe step (T…) arrives with the heel off the floor, as high as the rise.
      const fw = fwOf(steps[cur].fw);
      let pitch = latin ? 28 * air : 10 * air;
      if (!latin && fw[0] === "H" && e > 0.55) pitch = -14 * Math.sin(Math.PI * clamp((e - 0.55) / 0.45, 0, 1));
      const landed = latin ? (fw === "B" ? 15 : 0) : fw[0] === "T" || (fw[0] === "B" && fw[1] !== "F") ? Math.max(18, nfr ? 0 : 30 * lvl) : 0;
      if (e > 0.85) pitch = lerp(pitch, landed, (e - 0.85) / 0.15);
      out.feet[f] = { x: q.x, y: q.y, h: lerp(m.from.h, m.h, e), lift: (latin ? 0.025 : 0.04) * air, pitch, weight: w };
    } else {
      // the standing foot: heel up as far as the body has risen (not with NFR, where the heel stays down), staying on
      // the toe for a T step, and lowering through the next step after a TH ("toe heel")
      const ft = feet[f];
      let pitch = latin ? (ft.fw === "B" ? 15 : 0) : nfr ? 0 : 30 * lvl;
      if (!latin && ft.at >= 0) {
        if (/T$/.test(ft.fw)) pitch = Math.max(pitch, 18);
        if (/TH$/.test(ft.fw) && ft.at === cur - 1) pitch *= 1 - e;
        if (/^H$|F$/.test(ft.fw)) pitch = Math.min(pitch, 8);
      }
      out.feet[f] = { x: ft.p.x, y: ft.p.y, h: ft.p.h, lift: 0, pitch, weight: m ? (m.w ? 1 - w : 1) : 0.5 };
    }
  }
  out.sup = sup; out.side = side; out.sway = sway; out.latin = latin; out.s = s; out.lady = s < 1;
  return out;
}

/** Moves the follower's pose (pl) so her weight keeps its starting place in the leader's turning frame. */
function couple(layers, pm, pl) {
  const M = layers[0].sim.prints, F = layers[1].sim.prints;
  const mid = (P) => ({ x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 });
  const m0 = mid(M), f0 = mid(F), off = { x: f0.x - m0.x, y: f0.y - m0.y };
  const a = rad(pm.h - M[0].h), c = Math.cos(a), sn = Math.sin(a);
  const want = { x: pm.sup.x + off.x * c - off.y * sn, y: pm.sup.y + off.x * sn + off.y * c };
  const dx = want.x - pl.sup.x, dy = want.y - pl.sup.y;
  pl.sup = want;
  for (const f of ["L", "R"]) pl.feet[f] = { ...pl.feet[f], x: pl.feet[f].x + dx, y: pl.feet[f].y + dy };
  return { dx, dy };
}

/** Two-bone IK: joint between a and target b, bending towards hint. Returns [joint, end].
 *  Limits: never straighter than 179.4° (no hyperextension; the hint fixes which way it bends) and never folded
 *  tighter than minDeg at the joint (default 32°, about as far as a knee or elbow closes). */
function ik(a, b, l1, l2, hint, minDeg = 32) {
  const shortest = Math.sqrt(l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(rad(minDeg)));
  const d = b.clone().sub(a), len = clamp(d.length(), shortest, (l1 + l2) * 0.999);
  const dir = d.normalize(), end = a.clone().addScaledVector(dir, len);
  const x = (l1 * l1 - l2 * l2 + len * len) / (2 * len), y = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const perp = hint.clone().addScaledVector(dir, -hint.dot(dir));
  if (perp.lengthSq() < 1e-6) perp.set(0, 0, 1);
  return [a.clone().addScaledVector(dir, x).addScaledVector(perp.normalize(), y), end];
}

// ── meshes ───────────────────────────────────────────────────────────────
function mat(color) { return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0 }); }

function makeDancer(scene, colors, lady) {
  const parts = {};
  const add = (name, geo, m) => { const o = new THREE.Mesh(geo, m); o.castShadow = true; scene.add(o); parts[name] = o; return o; };
  const limb = (r1, r2) => new THREE.CylinderGeometry(r1, r2, 1, 6);
  for (const sd of ["L", "R"]) {
    add("thigh" + sd, limb(0.075, 0.052), colors.legs);
    add("shin" + sd, limb(0.05, 0.036), colors.legs);
    add("knee" + sd, new THREE.IcosahedronGeometry(0.052, 0), colors.legs);
    const foot = new THREE.BoxGeometry(0.085, 0.055, 0.26); foot.translate(0, 0.0275, -0.06);
    add("foot" + sd, foot, colors.shoes);
    add("upper" + sd, limb(0.045, 0.036), colors.top);
    add("fore" + sd, limb(0.034, 0.028), colors.skin);
    add("elbow" + sd, new THREE.IcosahedronGeometry(0.037, 0), colors.top);
    add("hand" + sd, new THREE.IcosahedronGeometry(0.045, 0), colors.skin);
  }
  add("pelvis", new THREE.BoxGeometry(0.3, 0.17, 0.19), lady ? colors.top : colors.legs);
  const torso = new THREE.CylinderGeometry(0.17, 0.12, 1, 6); torso.scale(1, 1, 0.62);
  add("torso", torso, colors.top);
  add("neck", limb(0.045, 0.05), colors.skin);
  add("head", new THREE.IcosahedronGeometry(BODY.head, 1), colors.skin);
  if (lady) {
    add("hair", new THREE.IcosahedronGeometry(0.07, 0), colors.hair);
  } else add("hair", new THREE.IcosahedronGeometry(BODY.head * 1.02, 1), colors.hair);
  return parts;
}

function setBone(o, a, b) {
  o.position.copy(a).add(b).multiplyScalar(0.5);
  o.quaternion.setFromUnitVectors(Y, a.clone().sub(b).normalize());
  o.scale.set(1, a.distanceTo(b), 1);
}
const basis = new THREE.Matrix4();
function setFrame(o, pos, up, fwd) {
  const z = fwd.clone().addScaledVector(up, -fwd.dot(up)).normalize(), x = up.clone().cross(z).normalize();
  basis.makeBasis(x, up, z); o.quaternion.setFromRotationMatrix(basis); o.position.copy(pos);
}

/** Body (legs, hips, torso) for a pose; arms are done afterwards, once both partners are placed. */
// The solver's output for one dancer, J: everything a renderer needs to pose a body. The primitive figure below and
// the rigged human (skinned.js) both draw from it, and a physics engine can later produce it instead of this solver.
//   J = { pel, hipUp, fw, rt, up, neck, headC, legs: { L|R: { hip, knee, ankle, ball, toeDir, footUp } }, arms: { L|R: { sh, el, hand } } }
function placeBody(parts, ps) {
  const k = ps.s, B = ps.B || Object.fromEntries(Object.entries(BODY).map(([n, v]) => [n, v * k]));
  B.hipDrop ??= 0.04 * k; B.shoulderDrop ??= 0.05 * k; B.ballBack ??= 0.13 * k; B.torsoBase ??= 0.06 * k;
  const fw = fwdOf(ps.h), rt = rightOf(ps.h);
  const feet = {};
  for (const f of ["L", "R"]) {
    const q = ps.feet[f], o = parts["foot" + f], yaw = Math.PI - rad(q.h), pitch = rad(q.pitch);
    const c = world(q), ff = fwdOf(q.h);
    o.position.copy(c).addScaledVector(ff, 0.06 * k);                     // the ball of the foot
    o.position.y = q.lift + (pitch < 0 ? 0.19 * k * Math.sin(-pitch) : 0);
    o.rotation.set(pitch, yaw, 0, "YXZ"); o.scale.setScalar(k);
    o.updateMatrixWorld();
    feet[f] = { ankle: V(0, B.ankle / k, -B.ballBack / k).applyMatrix4(o.matrixWorld), q, ball: o.position.clone(),
      toeDir: V(0, 0, 1).applyQuaternion(o.quaternion), footUp: V(0, 1, 0).applyQuaternion(o.quaternion) };
  }
  // hips over the weight; Latin hips settle sideways over the standing leg and tip (Cuban motion)
  const roll = ps.latin ? rad(7) * ps.side : 0, swayA = rad(5) * ps.sway;
  const pel = world(ps.sup).addScaledVector(rt, ps.latin ? 0.035 * ps.side * k : 0);
  const reach = (B.thigh + B.shin) * 0.995;
  let y = Infinity;
  for (const f of ["L", "R"]) {
    const sd = f === "R" ? 1 : -1, hipOff = rt.clone().multiplyScalar(sd * B.hip);
    const wt = ps.feet[f].weight;
    if (wt < 0.12 && ps.feet[f].lift > 0) continue;                    // a foot in the air doesn't hold the hips up
    // a trailing foot with no weight on it can peel its heel up to reach (below), so it allows a little more
    const r = reach + (wt < 0.12 ? 0.07 * k : 0), hp = pel.clone().add(hipOff), a = feet[f].ankle;
    const dxz = Math.hypot(hp.x - a.x, hp.z - a.z);
    y = Math.min(y, a.y + Math.sqrt(Math.max(0.05, r * r - dxz * dxz)) - sd * B.hip * Math.sin(roll) + B.hipDrop);
  }
  pel.y = (isFinite(y) ? y : 0.95 * k) - (ps.flexDrop ?? 0.03) * k;
  const hipUp = UP.clone().applyAxisAngle(fw, roll);
  const hipRt = rt.clone().applyAxisAngle(fw, roll);
  setFrame(parts.pelvis, pel, hipUp, fw); parts.pelvis.scale.setScalar(k);
  const legs = {};
  for (const f of ["L", "R"]) {
    const sd = f === "R" ? 1 : -1, hp = pel.clone().addScaledVector(hipRt, sd * B.hip).addScaledVector(hipUp, -B.hipDrop);
    // Stretched behind or in front, a foot rolls onto its ball (heel up) rather than being dragged off its mark,
    // as far as a dancer's foot goes (60°).
    const o = parts["foot" + f], q = ps.feet[f];
    for (let pitch = Math.max(0, q.pitch); hp.distanceTo(feet[f].ankle) > reach && pitch < 60; ) {
      pitch = Math.min(60, pitch + 4);
      o.rotation.set(rad(pitch), Math.PI - rad(q.h), 0, "YXZ"); o.updateMatrixWorld();
      feet[f].ankle = V(0, B.ankle / k, -B.ballBack / k).applyMatrix4(o.matrixWorld);
      feet[f].toeDir = V(0, 0, 1).applyQuaternion(o.quaternion); feet[f].footUp = V(0, 1, 0).applyQuaternion(o.quaternion);
    }
    const [knee, end] = ik(hp, feet[f].ankle, B.thigh, B.shin, fw.clone().addScaledVector(rt, sd * 0.15));
    setBone(parts["thigh" + f], hp, knee); setBone(parts["shin" + f], knee, end); parts["knee" + f].position.copy(knee);
    legs[f] = { hip: hp, knee, ankle: end, ball: feet[f].ball, toeDir: feet[f].toeDir, footUp: feet[f].footUp };
  }
  // torso leans against the hip tilt (Latin) or into the sway (Standard)
  // Standard follower: upper body back and to her left, out of the leader's way
  const tUp = UP.clone().applyAxisAngle(fw, -roll * 0.7 + swayA).addScaledVector(fw, ps.latin ? 0.02 : ps.lady ? -0.12 : -0.03)
    .addScaledVector(rt, !ps.latin && ps.lady ? -0.07 : 0).normalize();
  const base = pel.clone().addScaledVector(hipUp, B.torsoBase), neck = base.clone().addScaledVector(tUp, B.torso);
  setFrame(parts.torso, base.clone().add(neck).multiplyScalar(0.5), tUp, fw);
  parts.torso.scale.set(k, B.torso, k);
  const tRt = tUp.clone().cross(fw).multiplyScalar(-1).normalize();      // right-hand side of the chest
  const headC = neck.clone().addScaledVector(tUp, 0.06 * k + B.head);
  setBone(parts.neck, neck.clone().addScaledVector(tUp, 0.09 * k), neck.clone().addScaledVector(tUp, -0.02));
  parts.head.position.copy(headC);
  if (ps.lady) parts.hair.position.copy(headC).addScaledVector(fw, -0.09 * k).addScaledVector(tUp, 0.04 * k);
  else { parts.hair.position.copy(headC).addScaledVector(tUp, 0.035).addScaledVector(fw, -0.025); parts.hair.scale.set(1, 0.7, 1); parts.hair.rotation.y = Math.PI - rad(ps.h); }
  const sh = (sd) => neck.clone().addScaledVector(tUp, -B.shoulderDrop).addScaledVector(tRt, sd * B.shoulder);
  // heads: in closed position the follower looks over her left shoulder and the leader a little to his left; in
  // promenade both look along the joined hands, the way they're travelling (leader to his left, follower to her right)
  const turnHead = ps.latin ? 0 : ps.lady ? (ps.pp ? -45 : 40) : ps.pp ? 35 : 12;
  const headFw = fw.clone().applyAxisAngle(UP, rad(turnHead));
  return { pel, hipUp, neck, headC, headFw, fw, rt: tRt, up: tUp, B, sh: { L: sh(-1), R: sh(1) }, legs, arms: {} };
}

function placeArm(parts, f, body, target, hintOut, elbowDir) {
  const sd = f === "R" ? 1 : -1, s = body.sh[f];
  const hint = elbowDir || body.rt.clone().multiplyScalar(sd * (hintOut ?? 0.6)).addScaledVector(body.up, -1).addScaledVector(body.fw, -0.3);
  const [el, hand] = ik(s, target, body.B.upper, body.B.fore, hint, 28);
  body.arms[f] = { sh: s, el, hand };
  setBone(parts["upper" + f], s, el); setBone(parts["fore" + f], el, hand);
  parts["elbow" + f].position.copy(el); parts["hand" + f].position.copy(hand);
}

/** Hands: closed hold when the partners face each other close up (always in Standard), otherwise the nearest hands
 *  join if they can reach, and a free arm goes out to the side. */
function placeArms(pm, pl, bm, bl, latin, pp) {
  const facing = bm.fw.dot(bl.fw) < -0.45, gap = Math.hypot(bm.pel.x - bl.pel.x, bm.pel.z - bl.pel.z);
  // a free arm reaches out to the side, a little forward, just below shoulder height (Latin styling)
  const free = (parts, b, f) => placeArm(parts, f, b, b.sh[f].clone().addScaledVector(b.rt, (f === "R" ? 1 : -1) * 0.5 * b.B.upper / 0.29)
    .addScaledVector(b.up, -0.06).addScaledVector(b.fw, 0.12), 1.2);
  if (!latin || (facing && gap < 0.62)) {
    // The frame. Leader's left hand holds the follower's right out to his left at about her eye level, both elbows
    // up and out; his right hand on her left shoulder blade, elbow level with it; her left arm along his right upper
    // arm, hand near his shoulder. Latin closed hold is the same shape, lower and further apart.
    const out = (b, sd, down) => b.rt.clone().multiplyScalar(sd).addScaledVector(b.up, -down).addScaledVector(b.fw, -0.15);
    // in promenade the joined hands point forward, the way the couple is travelling
    const join = pp && !latin
      ? bm.sh.L.clone().addScaledVector(bm.fw, 0.34).addScaledVector(bm.rt, -0.14).addScaledVector(UP, 0.06)
      : bm.sh.L.clone().addScaledVector(bm.rt, latin ? -0.26 : -0.33).addScaledVector(bm.fw, latin ? 0.2 : 0.16).addScaledVector(UP, latin ? -0.02 : 0.12);
    if (!pp) join.lerp(bl.sh.R.clone().addScaledVector(UP, latin ? -0.02 : 0.12), 0.15);
    placeArm(pm, "L", bm, join, 0, out(bm, -1, 0.45));
    placeArm(pl, "R", bl, join, 0, out(bl, 1, 0.45));
    placeArm(pm, "R", bm, bl.neck.clone().addScaledVector(bl.up, -0.16).addScaledVector(bl.fw, -0.07).addScaledVector(bl.rt, -0.1), 0, out(bm, 1, 0.3));
    const upperArm = bm.arms.R.sh.clone().lerp(bm.arms.R.el, latin ? 0.25 : 0.45).addScaledVector(UP, 0.05);
    placeArm(pl, "L", bl, upperArm, 0, out(bl, -1, 0.35));
    return;
  }
  const pairs = [["L", "R"], ["R", "L"], ["R", "R"], ["L", "L"]].map(([a, b]) => ({ a, b, d: bm.sh[a].distanceTo(bl.sh[b]) })).sort((x, y) => x.d - y.d);
  const best = pairs[0];
  if (best.d < 1.25) {
    const j = bm.sh[best.a].clone().add(bl.sh[best.b]).multiplyScalar(0.5); j.y = (bm.sh[best.a].y + bl.sh[best.b].y) / 2 - 0.3;
    placeArm(pm, best.a, bm, j, 0.5); placeArm(pl, best.b, bl, j, 0.5);
    free(pm, bm, best.a === "L" ? "R" : "L"); free(pl, bl, best.b === "L" ? "R" : "L");
  } else { for (const f of ["L", "R"]) { free(pm, bm, f); free(pl, bl, f); } }
}

// ── surroundings: wooden floor with the room drawn on it, and the hall around it ─────────────────
export const SCENES = { plain: "Plain floor", ballroom: "Empty ballroom", crowd: "Ballroom with a crowd" };
export const VIEWS = { orbit: "Free (drag to look round)", side: "From the side", judge: "Judge's view", overhead: "Overhead", lead: "Behind the leader", follow: "Behind the follower" };

let seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** 2 × 2 m of maple-ish parquet strips, tileable. */
function woodTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 1024;
  const g = c.getContext("2d"), rows = 20, ph = c.height / rows;
  seed = 11;
  for (let r = 0; r < rows; r++) {
    let x = -rnd() * 400;
    while (x < c.width) {
      const len = 260 + rnd() * 520, l = 60 + rnd() * 7, sat = 30 + rnd() * 10, hue = 32 + rnd() * 5;
      for (const dx of [0, -c.width, c.width]) {
        g.fillStyle = `hsl(${hue} ${sat}% ${l}%)`; g.fillRect(x + dx, r * ph, len, ph);
        for (let k = 0; k < 5; k++) {
          const y = r * ph + ((k + 0.5) / 5) * ph + (rnd() - 0.5) * 4;
          g.strokeStyle = `rgba(110,70,30,${0.04 + rnd() * 0.05})`; g.lineWidth = 0.8 + rnd();
          g.beginPath(); g.moveTo(x + dx, y); g.bezierCurveTo(x + dx + len * 0.3, y + (rnd() - 0.5) * 5, x + dx + len * 0.7, y + (rnd() - 0.5) * 5, x + dx + len, y); g.stroke();
        }
        g.fillStyle = "rgba(60,35,15,.3)"; g.fillRect(x + dx, r * ph, 2, ph);
      }
      x += len;
    }
    g.fillStyle = "rgba(60,35,15,.28)"; g.fillRect(0, r * ph, c.width, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** The room's markings painted on the floor: edge, LOD arrows round the room, and any path (a routine's floor plan). */
function planTexture(W, H, paths, ink, acc) {
  const px = 64, c = document.createElement("canvas"); c.width = W * px; c.height = H * px;
  const g = c.getContext("2d"), m = (v) => v * px, inset = 0.75;
  g.strokeStyle = ink; g.globalAlpha = 0.55; g.lineWidth = 6; g.strokeRect(3, 3, c.width - 6, c.height - 6);
  // LOD runs anticlockwise: along the bottom (wall) side to the right, up the right, back along the top, down the left
  const sides = [[inset * 2, H - inset, W - inset * 2, H - inset], [W - inset, H - inset * 2, W - inset, inset * 2],
    [W - inset * 2, inset, inset * 2, inset], [inset, inset * 2, inset, H - inset * 2]];
  g.globalAlpha = 0.3; g.lineWidth = 5; g.setLineDash([m(0.5), m(0.35)]);
  g.font = `600 ${m(0.32)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  for (const [x1, y1, x2, y2] of sides) {
    g.strokeStyle = ink; g.beginPath(); g.moveTo(m(x1), m(y1)); g.lineTo(m(x2), m(y2)); g.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1);
    g.save(); g.setLineDash([]); g.translate(m(x2), m(y2)); g.rotate(a);
    g.fillStyle = ink; g.beginPath(); g.moveTo(0, 0); g.lineTo(-m(0.35), -m(0.18)); g.lineTo(-m(0.35), m(0.18)); g.fill();
    g.restore();
    g.save(); g.translate(m((x1 + x2) / 2), m((y1 + y2) / 2)); g.rotate(a); g.fillStyle = ink; g.fillText("LINE OF DANCE  →", 0, -m(0.42)); g.restore();
  }
  g.setLineDash([]); g.globalAlpha = 0.3; g.fillStyle = ink; g.font = `600 ${m(0.3)}px system-ui, sans-serif`;
  g.fillText("WALL", c.width / 2, c.height - m(0.25)); g.fillText("CENTRE", c.width / 2, m(1.6));
  g.globalAlpha = 0.75; g.strokeStyle = acc; g.lineWidth = m(0.07); g.lineJoin = g.lineCap = "round";
  for (const path of paths || []) {
    g.beginPath(); path.forEach((p, k) => (k ? g.lineTo(m(p.x), m(p.y)) : g.moveTo(m(p.x), m(p.y)))); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

const flat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, ...extra });

/** Walls, chandeliers and (optionally) spectators and judges round a W × H floor, in room metres (origin top-left). */
function hall(W, H, crowd) {
  const g = new THREE.Group(), gap = 3, wallH = 4.6, X0 = -gap, X1 = W + gap, Z0 = -gap, Z1 = H + gap;
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0, Z1 - Z0), flat(0x6b1f2a, { roughness: 1 }));
  carpet.rotation.x = -Math.PI / 2; carpet.position.set(W / 2, -0.002, H / 2); carpet.receiveShadow = true; g.add(carpet);
  const wall = flat(0xe9dcc3), wood = flat(0x5a3a22), gold = flat(0xc9a24a, { emissive: 0x6b5520, roughness: 0.5 }), glass = flat(0x9fb4c8, { roughness: 0.2, metalness: 0.3 });
  const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
  for (const [len, x, z, rot] of [[X1 - X0, W / 2, Z0, 0], [X1 - X0, W / 2, Z1, 0], [Z1 - Z0, X0, H / 2, 1], [Z1 - Z0, X1, H / 2, 1]]) {
    const wx = rot ? 0.2 : len, wz = rot ? len : 0.2;
    box(wx, wallH, wz, wall, x, wallH / 2, z);
    box(rot ? 0.24 : len, 1.1, rot ? len : 0.24, wood, x, 0.55, z);                       // panelling
    box(rot ? 0.26 : len, 0.18, rot ? len : 0.26, gold, x, wallH - 0.3, z);               // cornice
    for (let k = 1; k < Math.floor(len / 3); k++) {                                         // pilasters and tall windows
      const t = -len / 2 + k * 3;
      box(rot ? 0.32 : 0.36, wallH, rot ? 0.36 : 0.32, wall, x + (rot ? 0 : t), wallH / 2, z + (rot ? t : 0));
      if (k % 2) box(rot ? 0.22 : 1.3, 2.2, rot ? 1.3 : 0.22, glass, x + (rot ? 0 : t + 1.5), 2.6, z + (rot ? t + 1.5 : 0));
    }
  }
  for (let k = 0; k < 3; k++) {                                                              // chandeliers
    const c = new THREE.Group(); c.position.set(W * (k + 1) / 4, 3.7, H / 2);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.7, 8), gold); cone.rotation.x = Math.PI; c.add(cone);
    for (let j = 0; j < 8; j++) {
      const b = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), new THREE.MeshBasicMaterial({ color: 0xfff1c4 }));
      b.position.set(Math.cos(j * Math.PI / 4) * 0.55, -0.25, Math.sin(j * Math.PI / 4) * 0.55); c.add(b);
    }
    g.add(c);
  }
  if (crowd) {
    seed = 5;
    const spots = [];
    for (let row = 0; row < 3; row++) {
      const off = 1.4 + row * 0.7;
      for (let x = -1.5; x < W + 1.5; x += 0.62 + rnd() * 0.2) { if (rnd() < 0.85) spots.push([x, -off]); if (rnd() < 0.85) spots.push([x, H + off]); }
      for (let z = 0; z < H; z += 0.65 + rnd() * 0.2) if (rnd() < 0.7) spots.push([W + off, z]);
    }
    const body = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.17, 0.21, 1.3, 6).translate(0, 0.65, 0), flat(0xffffff), spots.length);
    const head = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.11, 0).translate(0, 1.43, 0), flat(0xd8c2a3), spots.length);
    const palette = [0x2b3150, 0x6a2c3a, 0x3b5d4a, 0x22252e, 0x7a6a55, 0x4b4f7a, 0x8a3b2e, 0x2f4f6f, 0x5d5d5d, 0xa88f5a];
    const mtx = new THREE.Matrix4(), col = new THREE.Color();
    spots.forEach(([x, z], k) => {
      const s = 0.9 + rnd() * 0.2;
      mtx.makeScale(1, s, 1).setPosition(x, 0, z); body.setMatrixAt(k, mtx); head.setMatrixAt(k, mtx);
      body.setColorAt(k, col.set(palette[Math.floor(rnd() * palette.length)]));
    });
    g.add(body, head);
    for (let k = 0; k < 5; k++) {                                                            // judges along the wall side
      const j = new THREE.Group(); j.position.set(W * (k + 1) / 6, 0, H + 0.75);
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 1.35, 6), flat(0x1b1e30)); b.position.y = 0.68;
      const h = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), flat(0xd8c2a3)); h.position.y = 1.48;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.02), flat(0xf4f1e8)); pad.position.set(0, 1.05, -0.2); pad.rotation.x = -0.6;
      j.add(b, h, pad); g.add(j);
    }
  }
  return g;
}

// ── stage ────────────────────────────────────────────────────────────────
function cssColor(expr, fallback) {
  const el = document.createElement("span"); el.style.color = expr; el.style.display = "none"; document.body.append(el);
  const c = getComputedStyle(el).color; el.remove();
  return c && c !== "rgba(0, 0, 0, 0)" ? c : fallback;
}

/** A WebGL stage that keeps its canvas across re-renders: call mount(host) before draw(). Returns null without WebGL.
 *  onView(name) is told when dragging switches the camera to the free view. */
export let failure = "";                          // why the last createStage() couldn't start, to show the viewer
export function createStage({ capture = false, onView = null, onReady = null } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: capture }); }
  catch (e) {
    const probe = document.createElement("canvas");
    failure = probe.getContext("webgl2") ? String(e?.message || e) : probe.getContext("webgl") ? String(e?.message || e)
      : "this browser has WebGL (3D graphics) switched off or blocked for its graphics driver";
    console.error("3D dancers:", e);
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement; canvas.className = "dia3";
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(40, 1, 0.05, 120);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8890a8, 1.6); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
  scene.add(sun, sun.target);
  const wood = woodTexture();
  const room = new THREE.Group(); scene.add(room);                 // floor, markings and hall, in room metres
  const marks = new THREE.Group(); scene.add(marks);

  const colors = {}, dancers = [];
  // rigged humans (skinned.js), loaded in the background; the simple figures stand in until then, or if it fails
  let skins = null, skinTry = null;
  const MODELS = ["models/dancer.glb", "models/dev-mannequin.glb"].map((m) => new URL(m, import.meta.url).href);
  function loadSkins() {
    skinTry ||= (async () => {
      const sk = await import("./skinned.js");
      let gltf = null;
      for (const url of MODELS) { try { gltf = await sk.loadModel(url); break; } catch { /* try the next */ } }
      if (!gltf) return;
      const made = [sk.makeSkinned(gltf, { height: 1.8, look: colors.lead }), sk.makeSkinned(gltf, { height: 1.68, look: colors.follow })];
      if (made.some((x) => !x)) return;
      skins = made;
      for (const x of skins) scene.add(x.root);
      key = "";                                          // re-pose with the rig's own proportions
      if (last) api.draw(...last);
      onReady?.();
    })().catch((e) => console.warn("3D dancers: using the simple figures", e));
  }
  let host = null, key = "", roomKey = "", theme = "", bodies = [], roomTurn = 0;
  let view = "orbit", sceneName = "plain", orbit = { az: 0.35, el: 0.42, dist: 4.4 }, defaults = {};
  const follow = V(0, 0.9, 0), eye = V(0, 1.6, 4), look = V(0, 0.9, 0), roomBox = { x0: -2, x1: 14, z0: -8, z1: 2 };
  let walls = null;                                                // inside of the hall, so the camera never goes through a wall

  function themeColors() {
    const ink = cssColor("var(--ink)", "#1E2240"), acc = cssColor("var(--accent)", "#7F8CFF"), surf = cssColor("var(--surface)", "#fff");
    const sig = ink + acc + surf;
    if (sig === theme) return; theme = sig; roomKey = "";
    Object.assign(colors, {
      lead: { top: mat(0x2b3150), legs: mat(0x1b1e30), shoes: mat(0x111111), skin: mat(0xd8c2a3), hair: mat(0x3b2d22) },
      follow: { top: mat(new THREE.Color(acc)), legs: mat(0xd8c2a3), shoes: mat(0xcfa76a), skin: mat(0xd8c2a3), hair: mat(0x5a3a22) },
      acc: new THREE.Color(acc), ink: new THREE.Color(ink), inkCss: ink, accCss: acc, surf,
    });
    for (const d of dancers) for (const o of Object.values(d)) scene.remove(o);
    dancers.length = 0; key = "";
    skins?.[0].recolour(colors.lead); skins?.[1].recolour(colors.follow); dress?.setColor(colors.follow.top.color);
  }

  /** The room: W × H metres, placed so the figure's starting point sits at `at` (metres from the left and centre walls). */
  function buildRoom(r) {
    const k = [r.w, r.h, r.at.x, r.at.z, sceneName, theme, JSON.stringify(r.paths || [])].join("|");
    if (k === roomKey) return; roomKey = k;
    for (const o of [...room.children]) { room.remove(o); o.traverse?.((x) => { x.geometry?.dispose(); }); }
    room.position.set(-r.at.x, 0, -r.at.z);
    Object.assign(roomBox, { x0: -r.at.x, x1: r.w - r.at.x, z0: -r.at.z, z1: r.h - r.at.z });
    const m = sceneName === "crowd" ? 1.1 : 2.6;
    walls = sceneName === "plain" ? null : { x0: roomBox.x0 - m, x1: roomBox.x1 + m, z0: roomBox.z0 - m, z1: roomBox.z1 + m };
    const tex = wood.clone(); tex.repeat.set(r.w / 2, r.h / 2); tex.needsUpdate = true;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(r.w / 2, 0, r.h / 2); floor.receiveShadow = true; room.add(floor);
    const plan = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), new THREE.MeshBasicMaterial({ map: planTexture(r.w, r.h, r.paths, "#2a1a10", colors.accCss), transparent: true, depthWrite: false }));
    plan.rotation.x = -Math.PI / 2; plan.position.set(r.w / 2, 0.002, r.h / 2); room.add(plan);
    if (sceneName === "plain") {
      const sur = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.surf), roughness: 1 }));
      sur.rotation.x = -Math.PI / 2; sur.position.set(r.w / 2, -0.003, r.h / 2); sur.receiveShadow = true; room.add(sur);
      scene.background = new THREE.Color(colors.surf); scene.fog = new THREE.Fog(colors.surf, 9, 22);
      hemi.color.set(0xffffff); hemi.groundColor.set(0x8890a8); hemi.intensity = 1.6;
    } else {
      room.add(hall(r.w, r.h, sceneName === "crowd"));
      scene.background = new THREE.Color(0x2a211c); scene.fog = new THREE.Fog(0x2a211c, 18, 45);
      hemi.color.set(0xfff4e0); hemi.groundColor.set(0x6b4a3a); hemi.intensity = 1.9;
    }
  }

  // drag to look round (switches to the free view), wheel or pinch to zoom, double-click to reset
  const ptrs = new Map(); let pinch = 0;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => { ptrs.set(e.pointerId, e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    if (ptrs.size === 1) {
      if (view !== "orbit") { seedOrbit(); view = "orbit"; onView?.(view); }
      orbit.az -= (e.clientX - p.clientX) * 0.008; orbit.el = clamp(orbit.el + (e.clientY - p.clientY) * 0.006, 0.05, 1.5);
    }
    ptrs.set(e.pointerId, e);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch) orbit.dist = clamp(orbit.dist * (pinch / d), 1.2, 22); pinch = d;
    }
    render();
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); orbit.dist = clamp(orbit.dist * (e.deltaY > 0 ? 1.1 : 1 / 1.1), 1.2, 22); render(); }, { passive: false });
  canvas.addEventListener("dblclick", () => { orbit = { ...orbit, ...defaults }; view = "orbit"; onView?.(view); render(); });
  // start the free view from wherever the camera is now, so switching to it doesn't jump
  function seedOrbit() {
    const d = eye.clone().sub(follow), dist = d.length();
    orbit = { az: Math.atan2(d.x, d.z) - roomTurn, el: clamp(Math.asin(d.y / dist), 0.05, 1.5), dist: clamp(dist, 1.2, 22) };
  }

  function resize() {
    if (!host) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    }
  }
  const ro = new ResizeObserver(() => { resize(); render(); });

  /** Where the camera wants to be for the current view; moving cameras ease towards it. */
  function aim(snap) {
    const want = V(), at = follow.clone();
    if (view === "overhead") { want.set(follow.x + Math.sin(roomTurn) * 2.2, 8.5, follow.z + Math.cos(roomTurn) * 2.2); }
    else if (view === "side") { want.set(follow.x + Math.sin(roomTurn) * 5.5, 1.5, follow.z + Math.cos(roomTurn) * 5.5); at.y = 0.75; }
    else if (view === "judge") {                                    // between the judges standing along the wall side
      const w = roomBox.x1 - roomBox.x0, cx = roomBox.x0 + w / 2 + w / 12;
      want.set(cx + (follow.x - cx) * 0.3, 1.65, roomBox.z1 + 0.3); at.y = 0.8;
    }
    else if ((view === "lead" || view === "follow") && bodies.length === 2) {
      const b = bodies[view === "lead" ? 0 : 1], head = b.neck.clone().addScaledVector(UP, 0.25);
      want.copy(head).addScaledVector(b.fw, -2.3).addScaledVector(UP, 0.7);
      at.copy(head).addScaledVector(b.fw, 1.6).addScaledVector(UP, -0.95);
    } else {
      const az = orbit.az + roomTurn;
      want.set(follow.x + Math.sin(az) * Math.cos(orbit.el) * orbit.dist, follow.y + Math.sin(orbit.el) * orbit.dist, follow.z + Math.cos(az) * Math.cos(orbit.el) * orbit.dist);
      snap = true;
    }
    if (walls) { want.x = clamp(want.x, walls.x0, walls.x1); want.z = clamp(want.z, walls.z0, walls.z1); want.y = Math.min(want.y, 4.1); }
    if (snap) { eye.copy(want); look.copy(at); } else { eye.lerp(want, 0.08); look.lerp(at, 0.12); }
  }

  function render(snap) {
    resize();
    aim(snap);
    cam.position.copy(eye); cam.lookAt(look);
    sun.position.set(follow.x + 2, 6, follow.z + 3); sun.target.position.copy(follow);
    renderer.render(scene, cam);
  }

  function footMarks(layers, latin) {
    marks.clear();
    const shape = new THREE.Shape();
    shape.absellipse(0, -0.05, 0.045, 0.085, 0, Math.PI * 2);
    const heel = new THREE.Shape(); heel.absellipse(0, 0.1, 0.035, 0.045, 0, Math.PI * 2);
    const geo = new THREE.ShapeGeometry([shape, heel]); geo.rotateX(-Math.PI / 2);
    layers.forEach((l, li) => {
      const c = li ? colors.acc : colors.ink;
      for (let p of l.sim.prints) {
        // the follower's marks move with her, where the couple frame (couple()) puts each step as it lands
        const sh = li === 1 && !latin && p.i >= 0 ? couple(layers, poseOf(layers[0], p.i + 0.999, false, 1), poseOf(layers[1], p.i + 0.999, false, 0.94)) : { dx: 0, dy: 0 };
        p = { ...p, x: p.x + sh.dx, y: p.y + sh.dy };
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: p.i < 0 ? 0.12 : 0.22, depthWrite: false }));
        m.position.copy(world(p)); m.position.y = 0.004; m.rotation.y = Math.PI - rad(p.h); m.userData.i = p.i; m.userData.li = li;
        marks.add(m);
      }
    });
  }

  let last = null;                                   // the latest draw() call, to redraw when the rigged humans arrive

  // the follower's dress: cloth (cloth.js) sewn to her waist, pushed out by her legs and hips
  let dress = null, clock = null;
  const waist = new THREE.Matrix4();
  function moveDress(b, k, pos, time) {
    // a ball gown: full, floor length, from the natural waist
    if (!dress) { dress = makeSkirt({ segs: 36, rows: 14, top: 0.15, hem: 0.56, length: 1.02, color: colors.follow.top.color }); scene.add(dress.mesh); }
    const at = b.pel.clone().addScaledVector(b.hipUp, 0.12), left = b.hipUp.clone().cross(b.fw).normalize();
    waist.makeBasis(left, b.hipUp, b.fw.clone().addScaledVector(b.hipUp, -b.fw.dot(b.hipUp)).normalize()).setPosition(at);
    const now = time ?? performance.now() / 1000, dt = clock ? now - clock.t : 0;
    // a jump (new figure, seeking, the loop starting again, a long pause) re-hangs the dress
    if (!clock || clock.k !== k || dt <= 0 || dt > 0.25 || Math.abs(pos - clock.pos) > 1.2) dress.reset(waist);
    else {
      const g = b.legs, caps = [{ a: g.L.hip, b: g.R.hip, r: 0.15 }];
      for (const f of ["L", "R"]) caps.push({ a: g[f].hip, b: g[f].knee, r: 0.085 }, { a: g[f].knee, b: g[f].ankle, r: 0.065 });
      dress.step(dt, waist, caps);
    }
    clock = { t: now, k, pos };
  }
  const api = {
    canvas,
    mount(el) {
      if (host !== el) { if (host) ro.unobserve(host); host = el; el.append(canvas); ro.observe(el); }
      else if (!canvas.isConnected) el.append(canvas);
    },
    setView(v) { if (VIEWS[v] && v !== view) { view = v; if (v === "orbit") orbit = { ...orbit, ...defaults }; render(true); } },
    setScene(n) { if (SCENES[n] && n !== sceneName) { sceneName = n; roomKey = ""; } },
    /** Resolves once the rigged humans are in (or it has given up and kept the simple figures). */
    get ready() { loadSkins(); return skinTry; },
    get view() { return view; },
    get scene() { return sceneName; },
    /** layers: [lead, follow] from layersFor(…, "both").
     *  opt: latin; room {w, h, at: {x, z}, paths}; turn (degrees to turn the room, from the compass); snap. */
    draw(layers, pos, opt = {}) {
      last = [layers, pos, opt];
      themeColors();
      const latin = !!opt.latin;
      const r = opt.room || { w: 16, h: 10 };
      buildRoom({ ...r, at: r.at || (latin ? { x: r.w / 2, z: r.h / 2 + 1 } : { x: 2.2, z: r.h - 1.6 }) });
      const k = layers.map((l) => l.sim.prints.length + ":" + Math.round(l.sim.prints[0].x) + ":" + Math.round(l.sim.prints[0].y)).join("|") + latin;
      if (!dancers.length) { dancers.push(makeDancer(scene, colors.lead, false), makeDancer(scene, colors.follow, true)); }
      loadSkins();
      // with the rigged humans showing, the simple figures only keep the follower's skirt
      for (const d of dancers) for (const o of Object.values(d)) o.visible = !skins;
      let snap = opt.snap;
      if (k !== key) {
        const fresh = !key; key = k; footMarks(layers, latin); snap = true;
        defaults = latin ? { az: 1.1, el: 0.32, dist: 4.2 } : { az: 0.25, el: 0.5, dist: 4.4 };
        if (fresh) orbit = { ...defaults };
      }
      roomTurn = rad(opt.turn || 0);
      const poses = layers.map((l, i) => poseOf(l, pos, latin, i ? 0.94 : 1));
      if (skins) poses.forEach((p, i) => (p.B = { ...skins[i].B }));
      // Standard is danced in hold, so the couple turns as one: the follower's weight stays where it started relative
      // to the leader (in front, a little to his right), carried round as he turns. Her feet keep their own layout
      // round her weight and her own turns (so promenade still opens), but on a pivot (Natural Spin Turn…) she now
      // goes round the outside of him instead of each partner spinning on the spot through the other.
      if (poses.length === 2 && !latin) couple(layers, poses[0], poses[1]);
      // Each partner's steps come from their own half of the chart, so through turns they can drift into each
      // other: keep the hips at least a hold's distance apart (closer in Standard, where the bodies touch).
      if (poses.length === 2) {
        const [a, b] = poses, min = (latin ? 0.4 : a.pp || b.pp ? 0.22 : 0.27) * U;   // side by side in promenade
        const dx = b.sup.x - a.sup.x, dy = b.sup.y - a.sup.y, d = Math.hypot(dx, dy);
        if (d < min) {
          const ux = d > 1 ? dx / d : Math.sin(rad(a.h)), uy = d > 1 ? dy / d : -Math.cos(rad(a.h)), push = (min - d) / 2;
          a.sup = { x: a.sup.x - ux * push, y: a.sup.y - uy * push };
          b.sup = { x: b.sup.x + ux * push, y: b.sup.y + uy * push };
        }
      }
      bodies = poses.map((p, i) => placeBody(dancers[i], p));
      if (bodies.length === 2) placeArms(dancers[0], dancers[1], bodies[0], bodies[1], latin, poses[0].pp || poses[1].pp);
      if (skins) bodies.forEach((b, i) => skins[i].pose(b));
      if (bodies.length === 2) moveDress(bodies[1], k, pos, opt.time);
      const cur = pos < 0 ? -1 : Math.floor(pos);
      for (const m of marks.children) m.material.opacity = m.userData.i === cur ? 0.6 : m.userData.i < 0 ? 0.1 : m.userData.i < cur ? 0.25 : 0.14;
      const mid = bodies.reduce((a, b) => a.add(b.pel), V()).multiplyScalar(1 / bodies.length); mid.y = 0.85;
      if (snap || follow.distanceTo(mid) > 3) follow.copy(mid); else follow.lerp(mid, 0.12);
      render(snap);
    },
    /** Records the canvas while play() runs for ms milliseconds; resolves with a WebM blob. */
    async record(ms, play) {
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm" });
      const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      rec.start(); play(); await new Promise((r) => setTimeout(r, ms)); rec.stop(); await done;
      return new Blob(chunks, { type: "video/webm" });
    },
    render,
  };
  return api;
}
