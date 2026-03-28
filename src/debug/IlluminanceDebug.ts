import * as THREE from 'three';
import { sampleGrid, sampleGR, sourceLuminance, GridStats } from './IlluminanceSampler';
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
 * False-colour 31×31 disc grid (high-res measurement grid) on the field.
 * Each disc = one measurement point; colour = E_h [lux].
 *
 * Disc radius 0.8 m so discs are visible but do not fully tile the field.
 */
function buildHeatmap(
  lights: readonly THREE.SpotLight[],
  group:  THREE.Group,
  iesExp: number,
): void {
  const stats = sampleGrid(lights, 31, 31, iesExp);
  const geo   = new THREE.CylinderGeometry(0.8, 0.8, 0.06, 12);

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
 * Logs the full 21×21 illuminance grid + uniformity metrics.
 *
 * Interpretation guide:
 *
 * FIFA Class V targets:
 *   E_h minimum ≥ 2000 lux  (maintained, i.e. after applying MF = 0.80)
 *   U1 = min / avg ≥ 0.70
 *   U2 = min / max ≥ 0.80
 *
 * "2000–3500 lux" is the MINIMUM maintained value at the worst grid point,
 * not the average.  In practice, high-end stadiums reach 3000–5000 lux average.
 *
 * Two correction factors are NOT applied here (simulation shows ideal conditions):
 *
 *   Maintenance Factor (MF = 0.80):
 *     Accounts for LED lumen depreciation and lens dust over the fixture lifetime.
 *     Multiply all E_h values by 0.80 to get maintained levels.
 *
 *   Utilisation Coefficient (UC ≈ 0.35–0.50 for real venues):
 *     In a real stadium ~50–65% of emitted flux illuminates stands, façades, and
 *     spill areas outside the pitch.  Our simulation has no stands, so UC ≈ 1.0
 *     and simulated E_h values are 2–3× higher than measured UEFA venue averages.
 *     Total rig flux (312 × 165 klm = 51.5 Mlm) on 7140 m² → 7212 lux theoretical
 *     max; real average of ~2800 lux implies UC × MF ≈ 2800 / 7212 ≈ 0.39.
 *
 * The primary diagnostic value of this report is UNIFORMITY (U1, U2), not the
 * absolute lux numbers.
 */
function logIlluminanceGrid(s: GridStats): void {

  console.group('=== E_h Illuminance Grid 21×21 [lux] (initial, UC=1, MF=1) ===');

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
  console.log('');
  console.log('  Note: values are initial conditions (no MF, no UC).');
  console.log(`  Maintained min  = ${Math.round(s.min * 0.80)} lux  (×MF 0.80)  — FIFA requires ≥ 2000 lux`);
  console.log(`  Real-venue est. avg ≈ ${Math.round(s.avg * 0.39)} lux  (×UC 0.39 × MF 0.80 combined)`);
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
// Observer probes
// ─────────────────────────────────────────────────────────────────────────────

/** 3×3 player grid at 1.5 m eye height + 2 GK probes at goal mouths. */
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

// ─────────────────────────────────────────────────────────────────────────────
// GR probe visualisation (CIE 112)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a CIE 112 GR value to a colour following EN 12193 risk zones:
 *   GR < 30  : green   — safe
 *   30–40    : yellow  — disturbing
 *   40–50    : orange  — intolerable / limit zone
 *   > 50     : red     — exceeds EN 12193 / FIFA Class V limit
 */
function grToColor(GR: number): THREE.Color {
  if (GR < 30) return new THREE.Color(0.05, 0.90, 0.20);
  if (GR < 40) return new THREE.Color(1.00, 0.85, 0.00);
  if (GR < 50) return new THREE.Color(1.00, 0.40, 0.00);
  return new THREE.Color(1.00, 0.15, 0.05);
}

/** Canvas sprite showing "GR: N" above the probe sphere. */
function makeGrLabel(GR: number, pos: THREE.Vector3): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width  = 200;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle    = 'rgba(0,0,0,0.55)';
  ctx.roundRect(2, 2, 196, 60, 6);
  ctx.fill();
  ctx.fillStyle    = GR >= 50 ? '#ff4422' : GR >= 40 ? '#ff8800' : GR >= 30 ? '#ffdd00' : '#22ee55';
  ctx.font         = 'bold 36px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`GR ${GR.toFixed(0)}`, 100, 32);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, toneMapped: false }),
  );
  sprite.position.copy(pos);
  sprite.scale.set(6, 2, 1);
  sprite.renderOrder = 11;
  return sprite;
}

/**
 * Gaze directions sampled for player probes (4 cardinal horizontals).
 * The worst-case GR over all directions is taken — mirrors EN 12193 protocol.
 */
const CARDINAL_DIRS: THREE.Vector3[] = [
  new THREE.Vector3( 1, 0,  0),
  new THREE.Vector3(-1, 0,  0),
  new THREE.Vector3( 0, 0,  1),
  new THREE.Vector3( 0, 0, -1),
];

/**
 * Builds GR probe spheres coloured by CIE 112 Glare Rating.
 *
 * Each sphere:
 *   - Colour follows EN 12193 risk zones (green / yellow / orange / red).
 *   - A vertical bar (height = GR / 5 m, capped at 12 m) encodes GR magnitude.
 *   - A canvas label shows the numeric GR value.
 *
 * Player probes: worst GR over 4 cardinal horizontal gaze directions.
 * Goalkeeper probes: GR in the player's gaze direction (toward field centre).
 *
 * @param avgEh     - mean E_h on field [lux] — needed for L_ve background term
 * @param fieldRefl - grass reflectance ρ
 */
function buildGrProbes(
  lights:    readonly THREE.SpotLight[],
  group:     THREE.Group,
  iesExp:    number,
  avgEh:     number,
  fieldRefl: number,
): void {
  const probes   = buildProbeList();
  const sphGeo   = new THREE.SphereGeometry(1.1, 12, 12);
  const gkSphGeo = new THREE.SphereGeometry(1.5, 12, 12);
  const DISPLAY_Y = 3.5; // [m] base of sphere above pitch

  for (const probe of probes) {
    // Determine worst-case GR and the gaze direction that produced it.
    let worstGR  = 0;
    let worstDir = CARDINAL_DIRS[0];

    const dirs = probe.isGK && probe.gazDir ? [probe.gazDir] : CARDINAL_DIRS;
    for (const dir of dirs) {
      const res = sampleGR(lights, probe.pos, dir, avgEh, fieldRefl, iesExp);
      if (res.GR > worstGR) { worstGR = res.GR; worstDir = dir; }
    }

    const color = grToColor(worstGR);
    const mat   = new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false });
    const geo   = probe.isGK ? gkSphGeo : sphGeo;
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(probe.pos.x, DISPLAY_Y, probe.pos.z);
    sphere.renderOrder = 10;
    group.add(sphere);

    // Vertical bar: height = GR / 5 (GR=50 → 10 m), capped at 12 m.
    const barH   = Math.min(worstGR / 5, 12);
    const barBot = new THREE.Vector3(probe.pos.x, DISPLAY_Y, probe.pos.z);
    const barTop = new THREE.Vector3(probe.pos.x, DISPLAY_Y + barH, probe.pos.z);
    const barGeo = new THREE.BufferGeometry().setFromPoints([barBot, barTop]);
    const barMat = new THREE.LineBasicMaterial({ color, toneMapped: false, depthTest: false });
    const bar    = new THREE.Line(barGeo, barMat);
    bar.renderOrder = 10;
    group.add(bar);

    // Gaze arrow for GK (shows which direction was evaluated).
    if (probe.isGK) {
      const origin  = new THREE.Vector3(probe.pos.x, DISPLAY_Y, probe.pos.z);
      const arrowEnd = origin.clone().addScaledVector(worstDir, 8);
      const linGeo  = new THREE.BufferGeometry().setFromPoints([origin, arrowEnd]);
      const linMat  = new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.4, toneMapped: false, depthTest: false,
      });
      group.add(new THREE.Line(linGeo, linMat));
    }

    // Canvas label above the bar.
    group.add(makeGrLabel(worstGR, new THREE.Vector3(probe.pos.x + 2, DISPLAY_Y + barH + 1.5, probe.pos.z)));
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// CIE 112 Glare Rating report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interprets a CIE 112 GR value according to EN 12193 / FIFA Class V limits.
 *
 * EN 12193 Table 1 (outdoor football):
 *   Class I (top-level competition, broadcast): GR ≤ 50
 *   Class II (competition):                     GR ≤ 50
 *   Class III (training):                       GR ≤ 55
 * FIFA Class V (UHD broadcast): GR ≤ 50
 */
function grLabel(GR: number): string {
  if (GR < 10) return 'Imperceptible';
  if (GR < 20) return 'Perceptible / not annoying';
  if (GR < 30) return 'Annoying';
  if (GR < 40) return 'Disturbing';
  if (GR < 50) return 'Intolerable (limit zone)';
  return 'EXCEEDS EN 12193 / FIFA Class V limit (GR > 50)';
}

/**
 * Logs CIE 112 Glare Rating for standard probe positions.
 *
 * For each observer (player mid-field, GK at each goal) the GR is evaluated
 * for 4 cardinal horizontal gaze directions. The worst-case (maximum) GR per
 * observer is reported — this mirrors the EN 12193 measurement protocol where
 * GR must be checked in the "most unfavourable" viewing direction.
 *
 * Source luminance statistics (Philips ArenaVision LED gen3 aperture model):
 *   Peak L_s [cd/m²] for the brightest fixture as seen from each position.
 *   Typical real range: 1 × 10⁶ – 8 × 10⁶ cd/m²  (varies with off-axis angle).
 *
 * @param avgEh         - mean E_h on field [lux], from sampleGrid
 * @param fieldRefl     - field surface reflectance ρ (grass: 0.25)
 * @param fixtureArea   - nominal single-fixture aperture area [m²] (MVF403: 0.166 m²)
 * @param iesExp        - IES beam exponent
 */
function logGrReport(
  lights:       readonly THREE.SpotLight[],
  avgEh:        number,
  fieldRefl:    number,
  fixtureArea:  number,
  iesExp:       number,
): void {
  console.group('=== CIE 112 Glare Rating (GR) — EN 12193 / FIFA Class V limit ≤ 50 ===');
  console.log(
    '  Reference fixture: Philips ArenaVision LED gen3 (MVF403), aperture 540×308 mm = 0.166 m²',
  );

  // Gaze directions: 4 cardinal horizontal azimuths.
  const gazeDirs: [string, THREE.Vector3][] = [
    ['E (+X)', new THREE.Vector3(1, 0, 0)],
    ['W (-X)', new THREE.Vector3(-1, 0, 0)],
    ['N (+Z)', new THREE.Vector3(0, 0, 1)],
    ['S (-Z)', new THREE.Vector3(0, 0, -1)],
  ];

  // Observer positions: mid-field player + goalkeepers.
  const observers: [string, THREE.Vector3][] = [
    ['Player (centre)',   new THREE.Vector3(0,           1.5, 0)],
    ['GK (east goal)',    new THREE.Vector3(FIELD_W / 2, 1.5, 0)],
    ['GK (west goal)',    new THREE.Vector3(-FIELD_W / 2, 1.5, 0)],
  ];

  console.log('');
  console.log(
    'observer'.padEnd(20) +
    'gaze'.padEnd(8) +
    'GR'.padStart(5) + ' ' +
    'L_vl[cd/m2]'.padStart(13) + ' ' +
    'L_ve[cd/m2]'.padStart(13) + ' ' +
    'status',
  );

  for (const [obsName, obsPos] of observers) {
    let worstGR   = 0;
    let worstDir  = '';
    let worstLvl  = 0;
    let worstLve  = 0;

    for (const [dirName, dir] of gazeDirs) {
      const res = sampleGR(lights, obsPos, dir, avgEh, fieldRefl, iesExp);
      if (res.GR > worstGR) {
        worstGR  = res.GR;
        worstDir = dirName;
        worstLvl = res.L_vl;
        worstLve = res.L_ve;
      }
    }

    console.log(
      obsName.padEnd(20) +
      worstDir.padEnd(8) +
      worstGR.toFixed(1).padStart(5) + ' ' +
      worstLvl.toExponential(2).padStart(13) + ' ' +
      worstLve.toFixed(2).padStart(13) + ' ' +
      grLabel(worstGR),
    );
  }

  // Source luminance statistics — sample worst-case observer (centre player, looking E).
  const centrePos = new THREE.Vector3(0, 1.5, 0);
  let peakLs = 0;
  let sumLs  = 0;
  let nLs    = 0;

  for (const light of lights) {
    const Ls = sourceLuminance(light, centrePos, fixtureArea, iesExp);
    if (Ls > 0) {
      peakLs = Math.max(peakLs, Ls);
      sumLs += Ls;
      nLs++;
    }
  }

  console.log('');
  console.log('  Source luminance (centre-field observer, Philips MVF403 aperture model):');
  console.log(`    Peak L_s  = ${(peakLs / 1e6).toFixed(2)} × 10⁶ cd/m²  (typical LED floodlight: 1–8 × 10⁶ cd/m²)`);
  console.log(`    Mean L_s  = ${(nLs > 0 ? sumLs / nLs / 1e6 : 0).toFixed(2)} × 10⁶ cd/m²  (in-cone fixtures only)`);
  console.log(`    L_ve      = ${(avgEh * fieldRefl / Math.PI).toFixed(2)} cd/m²  (field background, ρ = ${fieldRefl})`);
  console.log('');
  console.log('  Note: GR is evaluated for the worst-case horizontal gaze direction per EN 12193.');
  console.log('  FIFA Class V requirement: GR ≤ 50 at any playing position.');
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
  private aimGroup  = new THREE.Group();
  private heatGroup = new THREE.Group();
  private grGroup   = new THREE.Group();

  showAimTargets = false;
  showHeatmap    = false;
  /** CIE 112 GR probe visualisation — spheres coloured by Glare Rating. */
  showGrProbes   = false;
  /** Beam concentration exponent — must be kept in sync with params.iesExponent. */
  iesExponent     = 3;
  /** Philips ArenaVision LED gen3 (MVF403) aperture: 540×308 mm = 0.166 m². */
  fixtureLuminousArea = 0.166;
  /** Diffuse reflectance of playing surface ρ (grass: 0.25). */
  fieldReflectance    = 0.25;

  init(scene: THREE.Scene): void {
    scene.add(this.aimGroup);
    scene.add(this.heatGroup);
    scene.add(this.grGroup);
  }

  rebuild(lights: readonly THREE.SpotLight[]): void {
    disposeGroup(this.aimGroup);
    disposeGroup(this.heatGroup);
    disposeGroup(this.grGroup);

    if (this.showAimTargets) buildAimTargets(lights, this.aimGroup);
    if (this.showHeatmap)    buildHeatmap(lights, this.heatGroup, this.iesExponent);

    if (this.showGrProbes) {
      // avgEh is needed for L_ve background term; reuse a coarse 11×11 grid.
      const { avg } = sampleGrid(lights, 11, 11, this.iesExponent);
      buildGrProbes(lights, this.grGroup, this.iesExponent, avg, this.fieldReflectance);
    }
  }

  /** Full console report: placement analysis + illuminance grid + glare + GR. */
  logReport(lights: readonly THREE.SpotLight[]): void {
    logSpacingAndAiming(lights);
    const stats = sampleGrid(lights, 21, 21, this.iesExponent);
    logIlluminanceGrid(stats);
    logGrReport(
      lights,
      stats.avg,
      this.fieldReflectance,
      this.fixtureLuminousArea,
      this.iesExponent,
    );
  }
}
