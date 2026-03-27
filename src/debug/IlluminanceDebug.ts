import * as THREE from 'three';
import { sampleGrid, sampleEv, sampleGlare } from './IlluminanceSampler';
import { FIELD_W, FIELD_H } from '../config';

// ─────────────────────────────────────────────────────────────────────────────
// False-colour scale for E_h visualisation on the field
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps E_h [lux] to a false-colour via linear interpolation between keypoints.
 *
 * Scale is calibrated to FIFA Class V targets (E_h = 2000–3500 lux):
 *
 *   [lux]   colour         meaning
 *     0     near-black     unlit
 *   200     deep violet
 *   500     deep blue
 *   800     blue
 *  1200     blue-cyan
 *  1500     cyan           approaching FIFA minimum
 *  2000     cyan-green     FIFA Class V lower bound
 *  2500     pure green     FIFA Class V midpoint
 *  3000     yellow-green   FIFA Class V upper bound
 *  3500     yellow         mild overexposure
 *  4000     yellow-orange
 *  4500     orange
 *  5000     orange-red
 *  6000     red            strong overexposure
 *  8000     bright red     severe overexposure
 * 10000     magenta        extreme
 *
 * Using interpolation (not hard steps) gives continuous gradation that
 * reveals the smooth illuminance gradient across the field.
 */
function luxToColor(lux: number): THREE.Color {
  // Each entry: [lux, r, g, b] in linear [0,1] range.
  const K: [number, number, number, number][] = [
    [    0, 0.00, 0.00, 0.04],
    [  200, 0.05, 0.00, 0.20],
    [  500, 0.00, 0.00, 0.70],
    [  800, 0.00, 0.15, 1.00],
    [ 1200, 0.00, 0.55, 1.00],
    [ 1500, 0.00, 0.90, 0.90],
    [ 2000, 0.00, 1.00, 0.50],
    [ 2500, 0.10, 1.00, 0.00],
    [ 3000, 0.55, 1.00, 0.00],
    [ 3500, 1.00, 1.00, 0.00],
    [ 4000, 1.00, 0.70, 0.00],
    [ 4500, 1.00, 0.40, 0.00],
    [ 5000, 1.00, 0.15, 0.00],
    [ 6000, 0.95, 0.00, 0.00],
    [ 8000, 1.00, 0.10, 0.00],
    [10000, 1.00, 0.00, 0.60],
  ];

  if (lux <= K[0][0]) return new THREE.Color(K[0][1], K[0][2], K[0][3]);
  const last = K[K.length - 1];
  if (lux >= last[0]) return new THREE.Color(last[1], last[2], last[3]);

  for (let i = 0; i < K.length - 1; i++) {
    if (lux <= K[i + 1][0]) {
      const t = (lux - K[i][0]) / (K[i + 1][0] - K[i][0]);
      return new THREE.Color(
        K[i][1] + t * (K[i + 1][1] - K[i][1]),
        K[i][2] + t * (K[i + 1][2] - K[i][2]),
        K[i][3] + t * (K[i + 1][3] - K[i][3]),
      );
    }
  }
  return new THREE.Color(last[1], last[2], last[3]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orange sphere + faint line for each SpotLight's aim target.
 * Immediately reveals where all beams converge and exposes clustering.
 */
function buildAimTargets(
  lights: readonly THREE.SpotLight[],
  group:  THREE.Group,
): void {
  const geo    = new THREE.SphereGeometry(0.6, 8, 8);
  const mat    = new THREE.MeshBasicMaterial({ color: 0xff6600, toneMapped: false, depthTest: false });
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xff6600, transparent: true, opacity: 0.12, toneMapped: false, depthTest: false,
  });

  lights.forEach(spot => {
    const tgt = spot.target.position;

    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(tgt).setY(0.25);
    sphere.renderOrder = 5;
    group.add(sphere);

    // Line: light position → aim target
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      spot.position.clone(),
      tgt.clone().setY(0.25),
    ]);
    const line = new THREE.Line(lineGeo, lineMat);
    line.renderOrder = 5;
    group.add(line);
  });
}

/**
 * False-colour 11×11 disc grid (FIFA measurement grid) on the field.
 * Each disc = one measurement point; colour = E_h [lux].
 *
 * Disc radius 2.5 m so discs are visible but do not fully tile the field.
 */
function buildHeatmap(
  lights: readonly THREE.SpotLight[],
  group:  THREE.Group,
  iesExp: number,
): void {
  const stats = sampleGrid(lights, 11, 11, iesExp);
  const geo   = new THREE.CylinderGeometry(2.5, 2.5, 0.06, 12);

  for (let r = 0; r < stats.rows; r++) {
    for (let c = 0; c < stats.cols; c++) {
      const E    = stats.grid[r][c];
      const mat  = new THREE.MeshBasicMaterial({ color: luxToColor(E), toneMapped: false, depthTest: false });
      const disc = new THREE.Mesh(geo, mat);
      disc.position.set(stats.xs[c], 0.12, stats.zs[r]);
      disc.renderOrder = 5;
      group.add(disc);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console reports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logs the full 11×11 illuminance grid + uniformity metrics.
 *
 * Values are raw E_h [lux] before maintenance factor.
 * Compare against FIFA Class V targets:
 *   E_h = 2000–3500 lux,  U1 ≥ 0.7,  U2 ≥ 0.8
 */
function logIlluminanceGrid(lights: readonly THREE.SpotLight[], iesExp: number): void {
  const s = sampleGrid(lights, 11, 11, iesExp);

  console.group('=== E_h Illuminance Grid 11×11 [lux] ===');

  const header = 'z\\x  ' + s.xs.map(x => String(Math.round(x)).padStart(5)).join(' ');
  console.log(header);

  for (let r = s.rows - 1; r >= 0; r--) {
    const row = `${String(Math.round(s.zs[r])).padStart(4)}: ` +
      s.grid[r].map(v => String(Math.round(v)).padStart(5)).join(' ');
    console.log(row);
  }

  console.log('');
  console.log(`  Min  = ${Math.round(s.min)} lux  at (${Math.round(s.minAt.x)}, ${Math.round(s.minAt.z)})`);
  console.log(`  Max  = ${Math.round(s.max)} lux  at (${Math.round(s.maxAt.x)}, ${Math.round(s.maxAt.z)})`);
  console.log(`  Avg  = ${Math.round(s.avg)} lux`);
  console.log(`  U1   = min/avg = ${s.U1.toFixed(3)}   (FIFA ≥ 0.70)`);
  console.log(`  U2   = min/max = ${s.U2.toFixed(3)}   (FIFA ≥ 0.80)`);
  console.groupEnd();
}

/**
 * Logs each SpotLight's position on the oval, which "side" it was classified as,
 * its aim target, and the arc-length to the next light.
 *
 * Arc-length element for ellipse x=a·cos(t), z=b·sin(t):
 *   ds/dt = sqrt((a·sin t)² + (b·cos t)²)
 *
 * Equal angular spacing → unequal arc-length spacing.
 * Lights cluster at t≈0 and t≈π (oval X-extremes = positions behind goals),
 * which violates the FIFA 20° goal-zone exclusion rule.
 */
function logSpacingAndAiming(lights: readonly THREE.SpotLight[]): void {
  console.group('=== SpotLight Placement & Aiming ===');

  const N = lights.length;

  // Find semi-axes from actual positions
  let maxAbsX = 0, maxAbsZ = 0;
  lights.forEach(l => {
    maxAbsX = Math.max(maxAbsX, Math.abs(l.position.x));
    maxAbsZ = Math.max(maxAbsZ, Math.abs(l.position.z));
  });
  const a = maxAbsX; // ovalHalfLength (along X, field-length axis)
  const b = maxAbsZ; // ovalHalfWidth  (along Z, field-width axis)

  // Classification uses Z-axis: long-side lights are those alongside the 105 m touchlines.
  // Mirrors computeAimTarget() in LightRig.ts.
  const thresholdZ = b * 0.4;

  let nLong = 0, nGoalEnd = 0;

  console.log(
    '#'.padStart(3) + ' ' +
    'lx'.padStart(7) + ' ' + 'lz'.padStart(7) + ' ' +
    'side'.padStart(8) + ' ' +
    'tx'.padStart(7) + ' ' + 'tz'.padStart(7) + ' ' +
    'ds/dθ'.padStart(7),
  );

  for (let i = 0; i < N; i++) {
    const spot = lights[i];
    const lx   = spot.position.x;
    const lz   = spot.position.z;
    const tx   = spot.target.position.x;
    const tz   = spot.target.position.z;

    // Parametric angle for arc-length density reporting
    const t    = Math.atan2(lz / b, lx / a);
    const dsdt = Math.sqrt(Math.pow(a * Math.sin(t), 2) + Math.pow(b * Math.cos(t), 2));

    // Long-side: alongside touchlines (large |lz|); goal-end: behind goals (large |lx|).
    const isLongSide = Math.abs(lz) >= thresholdZ;
    const side = isLongSide
      ? (lz > 0 ? 'NORTH' : 'SOUTH')
      : 'GOALEND';

    if (isLongSide) nLong++; else nGoalEnd++;

    console.log(
      String(i + 1).padStart(3) + ' ' +
      lx.toFixed(1).padStart(7) + ' ' + lz.toFixed(1).padStart(7) + ' ' +
      side.padStart(8) + ' ' +
      tx.toFixed(1).padStart(7) + ' ' + tz.toFixed(1).padStart(7) + ' ' +
      dsdt.toFixed(1).padStart(7),
    );
  }

  console.log('');
  console.log(`  Long-side lights (N/S): ${nLong} of ${N}`);
  console.log(`  Goal-end lights:        ${nGoalEnd} of ${N}  <- FIFA: lights within 20deg of goal-line normal should be excluded`);
  console.log(`  Arc density at Z-apex (ds/dt=${a.toFixed(0)}) vs X-apex (ds/dt=${b.toFixed(0)})`);
  console.log(`  -> Equal angular spacing gives ~${((a - b) / a * 100).toFixed(0)}% more arc-length per light on the Z-axis (fewer lights/m there).`);
  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Glare probe visualisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe positions and types.
 *
 * Player probes (3 × 3 grid) sample the field at mid-body height (1.5 m).
 * Goalkeeper probes sit exactly at each goal mouth, facing the opposite end.
 *
 * Physical reference — FIFA mounting height requirement:
 *   Minimum elevation angle from any field position to any fixture = 25° (approx).
 *   At h = 50 m, the nearest catwalk light (horizontal dist ≈ 27 m from touchline,
 *   ≈ 15 m from the nearest player near the touchline) is at:
 *     arctan(48.5 / 15) ≈ 72° — no issue.
 *   The farthest light (opposite long side, dist ≈ 121 m) from a goalkeeper at
 *   the goal mouth is at:
 *     arctan(48.5 / 125) ≈ 21° — in the glare zone.
 *   This is the cross-fire trade-off: opposite-side lights must be high enough
 *   that their elevation at the goalkeeper > 25° (FIFA comfort guideline).
 *   At 50 m, that requires horizontal distance < 48.5 / tan(25°) ≈ 104 m.
 *   Our oval semi-axis = 80 m → the farthest opposite light is at
 *     dist = sqrt(80+52.5)² + 55² ≈ 146 m → elevation ≈ 18° < 25°.
 *   This means our current rig may produce glare for goalkeepers — flagged in red.
 *
 * Elevation thresholds (colour coding):
 *   minElevDeg > 45°: green  — no practical glare risk.
 *   30° < minElevDeg ≤ 45°: yellow — acceptable but notable.
 *   minElevDeg ≤ 30°: red    — potential disability glare (FIFA comfort concern).
 */

interface ProbeEntry {
  pos:     THREE.Vector3;
  isGK:    boolean;   // goalkeeper position (has gaze direction)
  gazDir?: THREE.Vector3;  // unit vector (looking direction for GK)
}

function buildProbeList(): ProbeEntry[] {
  const probes: ProbeEntry[] = [];
  const H = 1.5; // observer eye height [m]

  // 3 × 3 player grid
  const pxs = [-FIELD_W * 0.36, 0, FIELD_W * 0.36];
  const pzs = [-FIELD_H * 0.36, 0, FIELD_H * 0.36];
  for (const z of pzs) {
    for (const x of pxs) {
      probes.push({ pos: new THREE.Vector3(x, H, z), isGK: false });
    }
  }

  // 2 goalkeeper probes facing field centre
  probes.push({
    pos:    new THREE.Vector3( FIELD_W / 2, H, 0),
    isGK:   true,
    gazDir: new THREE.Vector3(-1, 0, 0),  // east GK looks west
  });
  probes.push({
    pos:    new THREE.Vector3(-FIELD_W / 2, H, 0),
    isGK:   true,
    gazDir: new THREE.Vector3( 1, 0, 0),  // west GK looks east
  });

  return probes;
}

/** Elevation threshold for glare risk. */
const GLARE_ELEV_RED    = 30; // [deg]  red zone — potential disability glare
const GLARE_ELEV_YELLOW = 45; // [deg]  yellow zone — notable but tolerable

function elevToColor(minElevDeg: number): THREE.Color {
  if (minElevDeg <= GLARE_ELEV_RED)    return new THREE.Color(1.0, 0.15, 0.05);
  if (minElevDeg <= GLARE_ELEV_YELLOW) return new THREE.Color(1.0, 0.85, 0.00);
  return new THREE.Color(0.05, 0.90, 0.20);
}

/**
 * Builds a sphere at each probe position, coloured by the minimum elevation
 * of any in-cone SpotLight as seen from that position.
 * Goalkeeper probes additionally show a faint gaze-direction arrow.
 */
function buildGlareProbes(
  lights: readonly THREE.SpotLight[],
  group:  THREE.Group,
  iesExp: number,
): void {
  const probes   = buildProbeList();
  const sphGeo   = new THREE.SphereGeometry(1.0, 10, 10);
  const gkSphGeo = new THREE.SphereGeometry(1.4, 10, 10);

  const arrowMat = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.35, toneMapped: false, depthTest: false,
  });

  // Visual display height — raised above field to avoid depth-precision z-fighting
  // at large camera distances. Measurement (sampleGlare/sampleEv) still uses the
  // physically correct eye height stored in probe.pos (1.5 m).
  const DISPLAY_Y = 3.0; // [m] visual sphere centre height

  for (const probe of probes) {
    const result = sampleGlare(lights, probe.pos, 35, iesExp);
    const color  = elevToColor(result.minElevDeg);
    const mat    = new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false });
    const geo    = probe.isGK ? gkSphGeo : sphGeo;
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(probe.pos.x, DISPLAY_Y, probe.pos.z);
    sphere.renderOrder = 10;
    group.add(sphere);

    // Gaze arrow for goalkeeper probes
    if (probe.isGK && probe.gazDir) {
      const origin = new THREE.Vector3(probe.pos.x, DISPLAY_Y, probe.pos.z);
      const end    = origin.clone().addScaledVector(probe.gazDir, 8);
      const linGeo = new THREE.BufferGeometry().setFromPoints([origin, end]);
      const line   = new THREE.Line(linGeo, arrowMat);
      line.renderOrder = 10;
      group.add(line);

      // E_v in gaze direction — vertical bar (height = Ev/300, cap 10 m)
      const Ev     = sampleEv(lights, probe.pos, probe.gazDir, iesExp);
      const barH   = Math.min(Ev / 300, 10);
      const barBot = origin.clone();
      const barTop = origin.clone().setY(DISPLAY_Y + barH);
      const barGeo = new THREE.BufferGeometry().setFromPoints([barBot, barTop]);
      const barMat = new THREE.LineBasicMaterial({
        color: 0x00ccff, toneMapped: false, depthTest: false,
      });
      const bar = new THREE.Line(barGeo, barMat);
      bar.renderOrder = 10;
      group.add(bar);
    }
  }
}

/**
 * Console report: per-probe glare assessment.
 *
 * Columns:
 *   pos      — (x, z) [m]
 *   type     — PLAYER or GK
 *   minElev  — elevation [deg] of the lowest in-cone light
 *   risk     — OK / CAUTION / GLARE
 *   Ev_gaze  — E_v [lux] in gaze direction (GK only)
 */
function logGlareReport(lights: readonly THREE.SpotLight[], iesExp: number): void {
  console.group('=== Glare Probe Report (player head height 1.5 m) ===');
  console.log(
    'type  '.padEnd(7) +
    'x'.padStart(6) + ' ' +
    'z'.padStart(6) + ' ' +
    'minElev[deg]'.padStart(13) + ' ' +
    'risk'.padStart(8) + ' ' +
    'Ev_gaze[lux]'.padStart(13),
  );

  const probes = buildProbeList();

  for (const probe of probes) {
    const result   = sampleGlare(lights, probe.pos, 35, iesExp);
    const minElev  = result.minElevDeg;
    const risk     = minElev <= GLARE_ELEV_RED    ? 'GLARE'
                   : minElev <= GLARE_ELEV_YELLOW ? 'CAUTION'
                   : 'OK';

    let evGaze = '-';
    if (probe.isGK && probe.gazDir) {
      const Ev = sampleEv(lights, probe.pos, probe.gazDir, iesExp);
      evGaze   = Math.round(Ev).toString();
    }

    const type = probe.isGK ? 'GK' : 'player';
    console.log(
      type.padEnd(7) +
      probe.pos.x.toFixed(0).padStart(6) + ' ' +
      probe.pos.z.toFixed(0).padStart(6) + ' ' +
      minElev.toFixed(1).padStart(13) + ' ' +
      risk.padStart(8) + ' ' +
      evGaze.padStart(13),
    );
  }

  console.groupEnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public class
// ─────────────────────────────────────────────────────────────────────────────

function disposeGroup(g: THREE.Group): void {
  g.traverse(obj => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const m = obj.material;
      Array.isArray(m) ? m.forEach(x => x.dispose()) : (m as THREE.Material).dispose();
    }
  });
  g.clear();
}

export class IlluminanceDebug {
  private aimGroup   = new THREE.Group();
  private heatGroup  = new THREE.Group();
  private glareGroup = new THREE.Group();

  showAimTargets  = false;
  showHeatmap     = false;
  showGlareProbes = false;
  /** Beam concentration exponent — must be kept in sync with params.iesExponent. */
  iesExponent     = 3;

  init(scene: THREE.Scene): void {
    scene.add(this.aimGroup);
    scene.add(this.heatGroup);
    scene.add(this.glareGroup);
  }

  rebuild(lights: readonly THREE.SpotLight[]): void {
    disposeGroup(this.aimGroup);
    disposeGroup(this.heatGroup);
    disposeGroup(this.glareGroup);

    if (this.showAimTargets)  buildAimTargets(lights, this.aimGroup);
    if (this.showHeatmap)     buildHeatmap(lights, this.heatGroup, this.iesExponent);
    if (this.showGlareProbes) buildGlareProbes(lights, this.glareGroup, this.iesExponent);
  }

  /** Full console report: placement analysis + illuminance grid + glare. */
  logReport(lights: readonly THREE.SpotLight[]): void {
    logSpacingAndAiming(lights);
    logIlluminanceGrid(lights, this.iesExponent);
    logGlareReport(lights, this.iesExponent);
  }
}
