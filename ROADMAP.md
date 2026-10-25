# Rise & Fall roadmap

What's live, what's on the `3d-dancers` branch (dev copy at https://chza.me/dance-dev/, amber DEV bar), and what's next.

## Live (main)
- ISTD medal and BDC restricted syllabi, step charts for the core dances (marked "Not checked yet" until checked).
- Members: passkeys, personal invites, admin-added people, routines with partners, lessons, competitions.
- Claude routine drafting (admin only, paid API).

## On the `3d-dancers` branch (not in production yet)
- **3D dancers** in the browser (three.js r162, falls back to WebGL 1): Footprints / 3D switch on figure pages and in
  the routine player, where the couple travels round the floor plan. Wooden floor with the room and LOD painted on it;
  plain floor, empty ballroom, or ballroom with a crowd and judges; free, side, judge, overhead and
  behind-the-leader/follower cameras.
- **Motion from the charts**: legs and arms by two-bone IK with joint limits; rise and fall and heel/toe from the
  technique columns (rise and fall wording, NFR, HT/TH/T/BF); trailing heels peel up instead of feet dragging; Cuban
  hip action in Latin; sway; head positions (closed and promenade).
- **Couple**: in Standard the follower's weight is held in the leader's turning frame, so on pivots she goes round the
  outside; a minimum hold distance; the frame (leader's left to follower's right, his right on her shoulder blade, her
  left along his arm); promenade hold with the hands forward.
- **Rigged humans** (`skinned.js`): any humanoid glTF, bones found by name (Mixamo, Quaternius, Blender). The dev
  mannequin (Mixamo X Bot) is gitignored and only for development.
- **Cloth gown** (`cloth.js`): floor-length, Verlet particles sewn to the natural waist, pushed out by legs and hips.
- **Practice**: "Room's way round" turns diagrams with the phone compass (and quarter turns at corners); spoken calls of
  the next figure for leader and follower; your own music at the practice speed.
- **Lesson recordings**: upload or record, local Whisper transcription (niced), free rough notes, copy-for-Claude.
- **Pre-rendered videos**: `render/worker.mjs` + `/api/render/jobs` (stale when a chart or the rig changes). Never on
  the VPS.
- **Ops**: `deploy/limited.sh` (cgroup caps for heavy jobs), `deploy/dev.sh` (capped dev copy), ENV_LABEL dev flag.

## Next
- [ ] Models: Quaternius Universal Base Characters (CC0, needs downloading by hand from itch.io), or a chosen rigged
      character; leader in tails with **cloth coat tails**, follower's bodice + the cloth gown.
- [ ] Check the motion figure by figure against the book: step sizes per dance, closed change, pivots, PP and the
      frame. Fix chart data where the starter charts are wrong (e.g. Three Cha Chas as locks).
- [ ] Gown: tune stiffness/petticoat, self-collision, wind from travel.
- [ ] Latin holds: hand-to-hand, fan, hockey stick, underarm turns (hand positions per figure, not just nearest hands).
- [ ] Footprints view: Latin diagrams pile up (New York); spread, label better, or default Latin to 3D.
- [ ] Routine planner (AI): better drafts; say what goes wrong.

## Learning from real dancing (needs a GPU box: NAS or laptop, never the VPS)
- [ ] **DD100** (Duolando, ICLR 2024): ~117 min of professional couples, all ten ballroom/Latin dances, leader and
      follower separately, SMPL-X with music; direct download from github.com/lisiyao21/Duolando. Also MDD
      (arXiv 2508.16911, ~10–15 h duets, text-annotated) and InterDance (arXiv 2412.16982) if obtainable.
- [ ] Reduce to our joint list (stick figures), segment into figures by matching foot contacts to the chart library
      and beats to the music.
- [ ] Fit, don't invent: tune the model's parameters (stride per dance, rise curve against count, partner offsets,
      hold geometry, heads, heel peel) to match; analysis by synthesis, figure by figure. A learned motion prior later
      to polish, not to generate steps.
- [ ] **Your own videos** with a known camera (phone on a tripod): 2D pose (RTMPose / MediaPipe), lift to 3D
      (GVHMR / WHAM), compare with our render through the same camera; report which figures and where they differ.
- [ ] **Unsupervised YouTube competitions**: couple detection and tracking (identity swaps in closed hold are the hard
      part), world-grounded lifting with a moving camera, beat tracking, figure recognition against the charts;
      confident segments as weak labels.
- [ ] Full physics engine (e.g. Rapier) for balance and momentum once the kinematic model matches the data.
- [ ] Render farm: `render/worker.mjs` on the NAS, then a GPU farm, pulling `/api/render/jobs`.
