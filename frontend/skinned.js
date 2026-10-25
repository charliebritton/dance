// Rigged human dancers: a skinned glTF humanoid posed from the solver's joints (J, see placeBody in dancers3d.js).
// Each driven bone is turned from its rest pose so that it points from its joint to the next one while keeping a
// reference direction (which way the knee faces, which way the elbow bends, where the chest faces). That makes it
// work with any humanoid rig whatever its bones' local axes. Bones are found by name: Mixamo ("mixamorig:LeftUpLeg"),
// Unity/Quaternius ("UpperLeg.L", "LeftUpperLeg") and Blender ("thigh.L") styles.
import * as THREE from "./vendor/three.module.min.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { clone } from "./vendor/SkeletonUtils.js";

const UP = new THREE.Vector3(0, 1, 0);

// rig prefixes to ignore: "mixamorig:" (three's loader drops the colon), Rigify "DEF-"/"ORG-", 3ds Max "Bip01 "
const bare = (name) => name.replace(/^.*[:|]/, "").replace(/^(mixamorig\d*|def[-_]|org[-_]|bip\d*[ _])/i, "");

function sideOf(name) {
  const s = bare(name);
  if (/left/i.test(s) || /[._\s-]l$/i.test(s) || /^l[._\s-]/i.test(s)) return "L";
  if (/right/i.test(s) || /[._\s-]r$/i.test(s) || /^r[._\s-]/i.test(s)) return "R";
  return "";
}

function partOf(name) {
  let s = bare(name).toLowerCase().replace(/left|right/g, "").replace(/[._\s-][lr]$/, "").replace(/^[lr][._\s-]/, "");
  s = s.replace(/[^a-z0-9]/g, "");
  if (/end$|top|eye|jaw|thumb|index|middle|ring|pinky|finger|twist|roll|ik|pole|target|breast|tail/.test(s)) return null;
  if (/^(hips|pelvis)$/.test(s)) return "hips";
  if (/^(spine\d*|chest|upperchest)$/.test(s)) return "spine";
  if (/^neck\d*$/.test(s)) return "neck";
  if (/^head$/.test(s)) return "head";
  if (/^(upleg|upperleg|thigh)$/.test(s)) return "thigh";
  if (/^(leg|lowerleg|calf|shin|knee)$/.test(s)) return "shin";
  if (/^(foot|ankle)$/.test(s)) return "foot";
  if (/^(toebase|toe|toes|ball)$/.test(s)) return "toe";
  if (/^(shoulder|clavicle)$/.test(s)) return "clav";
  if (/^(arm|upperarm)$/.test(s)) return "upper";
  if (/^(forearm|lowerarm|elbow)$/.test(s)) return "fore";
  if (/^(hand|wrist)$/.test(s)) return "hand";
  return null;
}

function findBones(root) {
  const by = { spine: [] };
  root.traverse((b) => {
    if (!b.isBone) return;
    const p = partOf(b.name);
    if (!p) return;
    if (p === "spine") by.spine.push(b);
    else { const key = ["hips", "neck", "head"].includes(p) ? p : p + sideOf(b.name); by[key] ||= b; }
  });
  return by;
}
const NEEDED = ["hips", "neck", "head", ..."thigh shin foot toe upper fore hand".split(" ").flatMap((p) => [p + "L", p + "R"])];

// rotation taking the frame (y = aim, z = reference) to world axes
const basis = new THREE.Matrix4(), tq = new THREE.Quaternion();
function frame(d, r, out = new THREE.Quaternion()) {
  const y = d.clone().normalize(), z = r.clone().addScaledVector(y, -r.dot(y));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = y.clone().cross(z);
  basis.makeBasis(x, y, z);
  return out.setFromRotationMatrix(basis);
}
/** The part of v square to d, or fallback when v runs along d (a straight limb has no bend to read). */
function across(v, d, fallback) {
  const u = v.clone().addScaledVector(d, -v.dot(d) / d.lengthSq());
  return u.lengthSq() > 1e-6 ? u : fallback.clone();
}

const sources = new Map();
export function loadModel(url) {
  if (!sources.has(url)) sources.set(url, new GLTFLoader().loadAsync(url));
  return sources.get(url);
}

/** One dancer from the loaded glTF: scaled to height (metres), coloured. Returns null if the rig isn't a humanoid. */
export function makeSkinned(gltf, { height, look }) {
  const root = clone(gltf.scene);
  const bones = findBones(root);
  const missing = NEEDED.filter((k) => !bones[k]);
  if (missing.length || !bones.spine.length) { console.warn("3D dancers: rig is missing", missing); return null; }
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; meshes.push(o); } });
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  root.scale.multiplyScalar(height / (box.max.y - box.min.y));
  root.updateMatrixWorld(true);
  const ground = new THREE.Box3().setFromObject(root).min.y;

  const P = (b) => b.getWorldPosition(new THREE.Vector3());
  const fwd0 = P(bones.thighL).sub(P(bones.thighR)).cross(UP).normalize();   // which way the model faces at rest
  const len = (a, b) => P(a).distanceTo(P(b));
  const flat = (a, b) => { const v = P(b).sub(P(a)); return Math.hypot(v.x, v.z); };
  const B = {
    thigh: len(bones.thighL, bones.shinL), shin: len(bones.shinL, bones.footL),
    upper: len(bones.upperL, bones.foreL), fore: len(bones.foreL, bones.handL),
    ankle: P(bones.footL).y - ground, ballBack: flat(bones.footL, bones.toeL),
    hip: flat(bones.thighR, bones.thighL) / 2, hipDrop: P(bones.hips).y - P(bones.thighL).y,
    torso: len(bones.hips, bones.neck), torsoBase: 0,
    shoulder: flat(bones.upperR, bones.upperL) / 2, shoulderDrop: P(bones.neck).y - P(bones.upperL).y,
    head: 0.11 * height / 1.8,
  };

  // each driven bone: its child joint (for the aim), its rest reference, and rest-frame⁻¹ × rest world rotation
  const chain = [bones.hips, ...bones.spine, bones.neck];
  const drive = [];
  const add = (key, bone, child, ref0) => {
    const q0 = bone.getWorldQuaternion(new THREE.Quaternion());
    const d0 = child ? P(child).sub(P(bone)) : UP.clone();
    drive.push({ key, bone, A: frame(d0, ref0).invert().multiply(q0) });
  };
  chain.forEach((b, i) => add(i === 0 ? "hips" : i === chain.length - 1 ? "neck" : "spine" + (i - 1), b, chain[i + 1] || bones.head, fwd0));
  add("head", bones.head, null, fwd0);
  for (const f of ["L", "R"]) {
    add("thigh" + f, bones["thigh" + f], bones["shin" + f], fwd0);
    add("shin" + f, bones["shin" + f], bones["foot" + f], fwd0);
    add("foot" + f, bones["foot" + f], bones["toe" + f], UP);
    add("upper" + f, bones["upper" + f], bones["fore" + f], fwd0);
    add("fore" + f, bones["fore" + f], bones["hand" + f], fwd0);
  }
  const nSpine = bones.spine.length;

  function recolour(c) {
    for (const m of meshes) {
      const name = (m.material?.name || "") + " " + m.name;
      const skin = /skin|body|face|head|hand/i.test(name) && !/shirt|cloth|pant|dress|shoe/i.test(name);
      const joint = /joint/i.test(name);
      const pick = skin ? c.skin : joint ? c.legs : c.top;               // a colour, or a material to take it from
      m.material = new THREE.MeshStandardMaterial({ color: pick?.color ?? pick, roughness: 0.6, metalness: 0.05 });
    }
  }
  recolour(look);

  const tmp = new THREE.Quaternion(), pq = new THREE.Quaternion(), inv = new THREE.Matrix4();
  /** Pose from the solver's joints J (world space). */
  function pose(J) {
    const want = {};
    want.hips = [J.hipUp, J.fw];
    for (let i = 0; i < nSpine; i++) want["spine" + i] = [J.hipUp.clone().lerp(J.up, (i + 1) / (nSpine + 1)), J.fw];
    want.neck = [J.up, J.fw];
    want.head = [J.up.clone().add(UP).normalize(), J.headFw || J.fw];
    for (const f of ["L", "R"]) {
      const g = J.legs[f], thighD = g.knee.clone().sub(g.hip), shinD = g.ankle.clone().sub(g.knee);
      const kneeRef = across(g.knee.clone().sub(g.hip.clone().add(g.ankle).multiplyScalar(0.5)), g.ankle.clone().sub(g.hip), J.fw);
      want["thigh" + f] = [thighD, kneeRef];
      want["shin" + f] = [shinD, across(thighD, shinD, kneeRef)];
      want["foot" + f] = [g.ball.clone().sub(g.ankle), g.footUp];
      const a = J.arms[f];
      if (a) {
        const upD = a.el.clone().sub(a.sh), foreD = a.hand.clone().sub(a.el);
        const bend = across(foreD, upD, J.fw);
        want["upper" + f] = [upD, bend];
        want["fore" + f] = [foreD, across(upD.clone().negate(), foreD, bend)];
      }
    }
    for (const { key, bone, A } of drive) {
      const w = want[key];
      if (!w) continue;
      tmp.copy(frame(w[0], w[1])).multiply(A);                 // the bone's new world rotation
      bone.parent.getWorldQuaternion(pq);
      bone.quaternion.copy(pq.invert().multiply(tmp));
      if (key === "hips") {
        bone.parent.updateWorldMatrix(true, false);
        bone.position.copy(J.pel).applyMatrix4(inv.copy(bone.parent.matrixWorld).invert());
      }
      bone.updateMatrixWorld(true);
    }
  }
  return { root, B, pose, recolour };
}
