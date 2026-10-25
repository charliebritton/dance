// Cloth for the follower's dress: a ring-and-row grid of particles (position-based Verlet). The top ring is sewn to
// the waist and moves with the hips; the rest falls under gravity and keeps its length and flare through distance
// constraints (along each panel, round each hem ring, across the diagonals, and every other ring for stiffness).
// The legs and hips push it out as capsules. Small enough to run every frame on a phone.
import * as THREE from "./vendor/three.module.min.js";

const G = -9.81, STEP = 1 / 120, MAX_STEPS = 6, ITER = 6, DAMP = 0.985;

export function makeSkirt({ segs = 32, rows = 10, top = 0.13, hem = 0.36, length = 0.52, color = 0xcc4466 } = {}) {
  const n = segs * rows, rest = new Float32Array(n * 3), pos = new Float32Array(n * 3), prev = new Float32Array(n * 3);
  const idx = (r, s) => r * segs + (((s % segs) + segs) % segs);
  // the dress at rest, in the waist's frame: x right, y up, z forward; a flared cone hanging from the waist
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1), rad = top + (hem - top) * Math.pow(t, 0.8), y = -length * t;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2, i = idx(r, s) * 3;
      rest[i] = Math.cos(a) * rad; rest[i + 1] = y; rest[i + 2] = Math.sin(a) * rad;
    }
  }
  const links = [];
  const link = (a, b) => {
    const dx = rest[a * 3] - rest[b * 3], dy = rest[a * 3 + 1] - rest[b * 3 + 1], dz = rest[a * 3 + 2] - rest[b * 3 + 2];
    links.push(a, b, Math.hypot(dx, dy, dz));
  };
  for (let r = 0; r < rows; r++) for (let s = 0; s < segs; s++) {
    link(idx(r, s), idx(r, s + 1));                                          // round the ring: keeps the flare
    if (r + 1 < rows) { link(idx(r, s), idx(r + 1, s)); link(idx(r, s), idx(r + 1, s + 1)); link(idx(r, s + 1), idx(r + 1, s)); }
    if (r + 2 < rows) link(idx(r, s), idx(r + 2, s));                        // bend stiffness down the panel
  }
  const L = new Float32Array(links);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const faces = [];
  for (let r = 0; r + 1 < rows; r++) for (let s = 0; s < segs; s++) {
    const a = idx(r, s), b = idx(r, s + 1), c = idx(r + 1, s), d = idx(r + 1, s + 1);
    faces.push(a, c, b, b, c, d);
  }
  geo.setIndex(faces);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.75, side: THREE.DoubleSide }));
  mesh.castShadow = true; mesh.frustumCulled = false;

  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  let ready = false;
  function pinTop(waist) {
    for (let s = 0; s < segs; s++) {
      const i = idx(0, s) * 3;
      v.set(rest[i], rest[i + 1], rest[i + 2]).applyMatrix4(waist);
      pos[i] = prev[i] = v.x; pos[i + 1] = prev[i + 1] = v.y; pos[i + 2] = prev[i + 2] = v.z;
    }
  }
  /** Hang the dress straight from the waist (after a jump in the animation). */
  function reset(waist) {
    for (let i = 0; i < n * 3; i += 3) {
      v.set(rest[i], rest[i + 1], rest[i + 2]).applyMatrix4(waist);
      pos[i] = prev[i] = v.x; pos[i + 1] = prev[i + 1] = v.y; pos[i + 2] = prev[i + 2] = v.z;
    }
    mesh.userData.waist = waist.clone();
    ready = true;
  }
  // push a point out of a capsule a–b of radius rad
  function capsule(i, a, b, rad) {
    const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, ab2 = abx * abx + aby * aby + abz * abz || 1e-9;
    let t = ((px - a.x) * abx + (py - a.y) * aby + (pz - a.z) * abz) / ab2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
    let dx = px - cx, dy = py - cy, dz = pz - cz; const d = Math.hypot(dx, dy, dz);
    if (d >= rad) return;
    if (d < 1e-6) { dx = 0; dy = 0; dz = 1; } else { dx /= d; dy /= d; dz /= d; }
    pos[i] = cx + dx * rad; pos[i + 1] = cy + dy * rad; pos[i + 2] = cz + dz * rad;
  }
  /** Advance by dt seconds. waist: the waist's world matrix; caps: [{a, b, r}] colliders (legs, hips). */
  function step(dt, waist, caps) {
    if (!ready) reset(waist);
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.round(dt / STEP))), h = Math.min(dt, MAX_STEPS * STEP) / steps;
    const prevWaist = m.copy(mesh.userData.waist || waist);
    for (let k = 1; k <= steps; k++) {
      // the waistband follows the hips smoothly across the sub-steps
      const w = lerpMatrix(prevWaist, waist, k / steps);
      for (let i = segs * 3; i < n * 3; i++) {
        const x = pos[i], vx = (x - prev[i]) * DAMP;
        prev[i] = x; pos[i] = x + vx + ((i % 3) === 1 ? G * h * h : 0);
      }
      pinTop(w);
      for (let it = 0; it < ITER; it++) {
        for (let j = 0; j < L.length; j += 3) {
          const a = L[j] * 3, b = L[j + 1] * 3, len = L[j + 2];
          const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2], d = Math.hypot(dx, dy, dz) || 1e-9;
          const wa = a < segs * 3 ? 0 : 1, wb = b < segs * 3 ? 0 : 1;
          if (!wa && !wb) continue;
          const c = (d - len) / d / (wa + wb);
          pos[a] += dx * c * wa; pos[a + 1] += dy * c * wa; pos[a + 2] += dz * c * wa;
          pos[b] -= dx * c * wb; pos[b + 1] -= dy * c * wb; pos[b + 2] -= dz * c * wb;
        }
        for (let i = segs * 3; i < n * 3; i += 3) {
          for (const c of caps) capsule(i, c.a, c.b, c.r);
          if (pos[i + 1] < 0.01) pos[i + 1] = 0.01;
        }
      }
    }
    mesh.userData.waist = waist.clone();
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return { mesh, step, reset, setColor: (c) => mesh.material.color.set(c) };
}

const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), sa = new THREE.Vector3(), out = new THREE.Matrix4();
function lerpMatrix(A, B, t) {
  A.decompose(pa, qa, sa); B.decompose(pb, qb, sa);
  return out.compose(pa.lerp(pb, t), qa.slerp(qb, t), sa);
}
