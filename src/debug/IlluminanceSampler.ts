import * as THREE from 'three';
import { FIELD_W, FIELD_H } from '../config';

// ─────────────────────────────────────────────────────────────────────────────
// Beam distribution models
// ─────────────────────────────────────────────────────────────────────────────

/**
 * smoothstep — matches Three.js getSpotAttenuation() in GLSL exactly.
 * Used only as a fallback when iesExponent = 0.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * IES-like power-cosine beam factor.
 *
 * Real stadium fixtures (Type V symmetric IES) concentrate luminous intensity
 * near the beam axis; the distribution falls off toward the field angle (outer edge).
 * A power-cosine profile is a practical analytical approximation:
 *
 *   w(θ) = (cos θ − cos θ_max) / (1 − cos θ_max)     [0, 1]
 *            ↑ 1 on-axis (θ=0)                ↑ 0 at beam edge (θ=θ_max)
 *
 *   I(θ)  = I_peak × w(θ)^n
 *
 * Flux conservation:
 *   Φ = ∫₀^θmax I(θ) × 2π sinθ dθ
 *     = I_peak × 2π (1 − cosθ_max) / (n + 1)
 *     = I_peak × Ω / (n + 1)
 *
 *   Setting I_peak = I_uniform × (n + 1)  preserves Φ.
 *
 * @returns I_uniform × (n+1) × w^n  — the combined beam factor (dimensionless × cd → cd)
 */
function iesBeamFactor(cosToPoint: number, cosOuter: number, n: number): number {
  const w = (cosToPoint - cosOuter) / (1.0 - cosOuter);
  if (w <= 0) return 0;
  return Math.pow(w, n) * (n + 1);
}

/**
 * Unified beam attenuation factor for one light-to-point pair.
 *
 * iesExp = 0: original Three.js smoothstep (uniform cone + penumbra edge).
 * iesExp > 0: IES power-cosine (concentrated on-axis, natural edge at cosOuter).
 *
 * The returned value is dimensionless; multiply by light.intensity [cd] and
 * divide by r² [m²] to obtain illuminance contribution [lux].
 */
function beamFactor(
  cosToPoint: number,
  cosOuter:   number,
  cosInner:   number,
  iesExp:     number,
): number {
  if (cosToPoint < cosOuter) return 0;
  if (iesExp > 0) return iesBeamFactor(cosToPoint, cosOuter, iesExp);
  return smoothstep(cosOuter, cosInner, cosToPoint);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core illuminance formulas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes horizontal illuminance E_h [lux] at point P from a set of SpotLights.
 *
 *   For each light i:
 *     dNorm_i   = normalize(P − lightPos_i)          direction light → surface
 *     cosInc_i  = dot((0,1,0), −dNorm_i)             angle of incidence on horiz. plane
 *     axis_i    = normalize(target_i − lightPos_i)   SpotLight beam axis
 *     cosToPoint = dot(dNorm_i, axis_i)
 *
 *     iesExp = 0:   bf = smoothstep(cosOuter, cosInner, cosToPoint)  (Three.js default)
 *     iesExp > 0:   bf = iesBeamFactor(cosToPoint, cosOuter, n) × (n+1)
 *
 *     E_h += I_i × bf × cosInc_i / r_i²              [lux]
 *
 * @param iesExp - beam concentration exponent (0 = uniform; 3 = realistic stadium fixture)
 */
export function sampleEh(
  lights:  readonly THREE.SpotLight[],
  point:   THREE.Vector3,
  iesExp = 0,
): number {
  let E = 0;

  for (const light of lights) {
    const dx = point.x - light.position.x;
    const dy = point.y - light.position.y;
    const dz = point.z - light.position.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    const r  = Math.sqrt(r2);

    const nx = dx / r;
    const ny = dy / r;
    const nz = dz / r;

    const cosInc = -ny;
    if (cosInc <= 0) continue;

    const ax  = light.target.position.x - light.position.x;
    const ay  = light.target.position.y - light.position.y;
    const az  = light.target.position.z - light.position.z;
    const al  = Math.sqrt(ax * ax + ay * ay + az * az);

    const cosToPoint = nx * (ax / al) + ny * (ay / al) + nz * (az / al);
    const cosOuter   = Math.cos(light.angle);
    const cosInner   = Math.cos(light.angle * (1 - light.penumbra));

    const bf = beamFactor(cosToPoint, cosOuter, cosInner, iesExp);
    if (bf === 0) continue;

    E += light.intensity * bf * cosInc / r2;
  }

  return E;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vertical illuminance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vertical illuminance E_v [lux] at `point`, for a sensor whose normal vector
 * is `direction` (unit vector pointing toward the "bright" side of the sensor).
 *
 * Formula:
 *   dToLight_i = normalize(lightPos_i − point)
 *   cosInc_i   = dot(direction, dToLight_i)    sensor foreshortening
 *   E_v += I_i × spotFactor_i × max(0, cosInc_i) / r²_i
 *
 * This is the vertical analogue of sampleEh — replace the horizontal surface
 * normal (0,1,0) with an arbitrary unit vector `direction`.
 *
 * Used for:
 *   - TV camera illuminance: sensor facing camera direction at 1.2 m above pitch.
 *   - Player glare assessment: sensor facing toward each light source in turn.
 *   - Goalkeeper check: sensor facing field centre at 1.5 m height.
 *
 * Note: if `direction = (0,1,0)` and `point.y = 0`, the result equals sampleEh.
 */
export function sampleEv(
  lights:    readonly THREE.SpotLight[],
  point:     THREE.Vector3,
  direction: THREE.Vector3,   // unit vector: sensor faces this direction
  iesExp = 0,
): number {
  let E = 0;

  for (const light of lights) {
    const dx = light.position.x - point.x;
    const dy = light.position.y - point.y;
    const dz = light.position.z - point.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    const r  = Math.sqrt(r2);
    if (r < 0.001) continue;

    const nx = dx / r;
    const ny = dy / r;
    const nz = dz / r;

    const cosInc = direction.x * nx + direction.y * ny + direction.z * nz;
    if (cosInc <= 0) continue;

    const ax  = light.target.position.x - light.position.x;
    const ay  = light.target.position.y - light.position.y;
    const az  = light.target.position.z - light.position.z;
    const al  = Math.sqrt(ax * ax + ay * ay + az * az);

    const cosToPoint = (-nx) * (ax / al) + (-ny) * (ay / al) + (-nz) * (az / al);
    const cosOuter   = Math.cos(light.angle);
    const cosInner   = Math.cos(light.angle * (1 - light.penumbra));

    const bf = beamFactor(cosToPoint, cosOuter, cosInner, iesExp);
    if (bf === 0) continue;

    E += light.intensity * bf * cosInc / r2;
  }

  return E;
}

// ─────────────────────────────────────────────────────────────────────────────
// Glare evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a simplified glare evaluation at a single probe position.
 *
 * Background — glare mechanics in a stadium:
 *   A light source causes disability glare when it appears bright relative to
 *   the background and is close to the observer's line of sight.  The CIE
 *   Unified Glare Rating (UGR) is the standard metric, but it requires knowing
 *   the source luminance L_s [cd/m²] and the source solid angle Ω [sr].
 *
 *   For our SpotLight point-source model, source luminance is undefined.
 *   We therefore use a simplified glare metric based on:
 *
 *     lowAngleEv:  E_v [lux] contributed by lights with elevation ≤ elevLimitDeg.
 *       = Σ_i [ I_i × spotFactor_i × cos(elevation_i) / r²_i ]
 *       where the sum is restricted to lights satisfying elevation_i ≤ elevLimitDeg.
 *
 *   Physical meaning: lowAngleEv is the irradiance on a hypothetical vertical
 *   sensor that only "sees" low-angle sources. High lowAngleEv → high glare risk.
 *
 *   FIFA mounting requirement:
 *     Minimum elevation angle from player eye level to any fixture ≥ 25° (approximately).
 *     At h = 50 m, the closest light (horizontal dist ≈ 15 m) is at elevation
 *       arctan(48.5 / 15) ≈ 72° → no near-field risk.
 *     The farthest west-side light seen from east goalkeeper (dist ≈ 125 m):
 *       arctan(48.5 / 125) ≈ 21° → enters glare zone.
 *     This is the primary glare risk in cross-fired stadium rigs.
 */
export interface GlareResult {
  minElevDeg:    number;  // elevation of the lowest visible (in-cone) light [deg]
  lowAngleEv:    number;  // E_v [lux] from lights at elevation ≤ elevLimitDeg
  worstLightIdx: number;  // index of lowest-elevation visible light, or -1
}

/**
 * Evaluates simplified glare at a probe position.
 *
 * @param point          - observer position (e.g. 1.5 m above field)
 * @param elevLimitDeg   - elevation threshold [deg]; lights below this are "glare sources"
 */
export function sampleGlare(
  lights:       readonly THREE.SpotLight[],
  point:        THREE.Vector3,
  elevLimitDeg: number,
  iesExp = 0,
): GlareResult {
  const elevLimitRad = THREE.MathUtils.degToRad(elevLimitDeg);

  let minElevDeg    = 90;
  let lowAngleEv    = 0;
  let worstLightIdx = -1;

  for (let i = 0; i < lights.length; i++) {
    const light = lights[i];
    const dx = light.position.x - point.x;
    const dy = light.position.y - point.y;
    const dz = light.position.z - point.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    const r  = Math.sqrt(r2);
    if (r < 0.001) continue;

    const nx = dx / r;
    const ny = dy / r;
    const nz = dz / r;

    const ax  = light.target.position.x - light.position.x;
    const ay  = light.target.position.y - light.position.y;
    const az  = light.target.position.z - light.position.z;
    const al  = Math.sqrt(ax * ax + ay * ay + az * az);
    const cosToPoint = (-nx) * (ax / al) + (-ny) * (ay / al) + (-nz) * (az / al);
    const cosOuter   = Math.cos(light.angle);
    const cosInner   = Math.cos(light.angle * (1 - light.penumbra));

    const bf = beamFactor(cosToPoint, cosOuter, cosInner, iesExp);
    if (bf === 0) continue;

    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const elevRad   = Math.atan2(dy, horizDist);
    const elevDeg   = THREE.MathUtils.radToDeg(elevRad);

    if (elevDeg < minElevDeg) {
      minElevDeg    = elevDeg;
      worstLightIdx = i;
    }

    if (elevRad <= elevLimitRad) {
      const cosIncHoriz = horizDist / r;
      lowAngleEv += light.intensity * bf * cosIncHoriz / r2;
    }
  }

  return { minElevDeg, lowAngleEv, worstLightIdx };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid sampling + statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface GridStats {
  grid:     number[][];   // [row][col], E_h [lux]
  min:      number;       // [lux]
  max:      number;       // [lux]
  avg:      number;       // [lux]
  U1:       number;       // min / avg  (FIFA target ≥ 0.7)
  U2:       number;       // min / max  (FIFA target ≥ 0.8)
  minAt:    { x: number; z: number };
  maxAt:    { x: number; z: number };
  cols:     number;
  rows:     number;
  xs:       number[];     // [m] x-positions
  zs:       number[];     // [m] z-positions
}

/**
 * Samples E_h on a FIFA-standard measurement grid.
 *
 * FIFA uses 11×11 (121 points) or 13×9 (117 points).
 * Sensor placed on ground (Y = 0), facing upward — horizontal illuminance.
 */
export function sampleGrid(
  lights: readonly THREE.SpotLight[],
  cols = 11,
  rows = 11,
  iesExp = 0,
): GridStats {
  const xs = Array.from({ length: cols }, (_, c) => -FIELD_W / 2 + c * (FIELD_W / (cols - 1)));
  const zs = Array.from({ length: rows }, (_, r) => -FIELD_H / 2 + r * (FIELD_H / (rows - 1)));

  const grid: number[][] = [];
  let minE = Infinity, maxE = -Infinity, sumE = 0;
  let minAt = { x: 0, z: 0 }, maxAt = { x: 0, z: 0 };

  const pt = new THREE.Vector3(0, 0, 0);
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      pt.set(xs[c], 0, zs[r]);
      const E = sampleEh(lights, pt, iesExp);
      grid[r][c] = E;
      sumE += E;
      if (E < minE) { minE = E; minAt = { x: xs[c], z: zs[r] }; }
      if (E > maxE) { maxE = E; maxAt = { x: xs[c], z: zs[r] }; }
    }
  }

  const avg = sumE / (cols * rows);
  return {
    grid, min: minE, max: maxE, avg,
    U1: minE / avg,
    U2: minE / maxE,
    minAt, maxAt, cols, rows, xs, zs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CIE 112 Glare Rating (GR) — outdoor sports lighting standard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a CIE 112 Glare Rating evaluation at a single observer position.
 *
 * CIE 112 / EN 12193 is the correct glare metric for outdoor sports lighting.
 * (UGR per CIE 117 is designed for indoor horizontal viewing; the Guth position
 * index saturates at high elevation angles typical of stadium rigs, making UGR
 * unsuitable for overhead floodlighting.)
 *
 * GR scale interpretation:
 *   GR < 10  : Imperceptible
 *   10–20    : Perceptible but not annoying
 *   20–30    : Annoying
 *   30–40    : Disturbing
 *   40–50    : Intolerable (limit for EN 12193 Class I / FIFA Class V)
 *   > 50     : Beyond limit
 *
 * EN 12193 / FIFA Class V limit: GR ≤ 50.
 *
 * Formula (Holladay, 1926; formalised in CIE 112, 1994):
 *
 *   GR = 27 + 24 × log₁₀(L_vl / L_ve^0.9)
 *
 *   L_vl = Σ(10 × E_eye_i / θ_i²)    [cd/m²]  veiling luminance from all in-cone sources
 *   L_ve = E_h_avg × ρ / π            [cd/m²]  adaptation luminance from field surface
 *
 *   E_eye_i  — illuminance at the observer's eye from source i, measured on a
 *              plane perpendicular to the line from eye to source [lux]:
 *                E_eye_i = I_i × bf_i / r_i²
 *   θ_i      — angle [degrees] between observer's gaze direction and direction
 *              to source i.  Small θ (source near line-of-sight) is worst-case.
 *              Clamped to ≥ 1.5° to prevent singularity.
 */
export interface GrResult {
  GR:    number;  // [0–100] Glare Rating, CIE 112 / EN 12193
  L_vl:  number;  // [cd/m²] total veiling luminance from sources
  L_ve:  number;  // [cd/m²] adaptation (background) luminance of field
}

/**
 * Computes CIE 112 Glare Rating for a single observer position and gaze direction.
 *
 * @param lights      - active SpotLight array
 * @param observerPos - observer eye position [m] (typically 1.5 m above pitch)
 * @param viewDir     - unit vector: observer's horizontal gaze direction
 * @param avgEh       - mean horizontal illuminance on field [lux] (from sampleGrid)
 * @param fieldRefl   - diffuse reflectance of playing surface ρ [0–1] (grass: 0.25)
 * @param iesExp      - IES beam concentration exponent
 */
export function sampleGR(
  lights:      readonly THREE.SpotLight[],
  observerPos: THREE.Vector3,
  viewDir:     THREE.Vector3,
  avgEh:       number,
  fieldRefl:   number,
  iesExp = 0,
): GrResult {
  // Background luminance: Lambertian field with diffuse reflectance ρ.
  const L_ve = avgEh * fieldRefl / Math.PI;

  let L_vl = 0;

  for (const light of lights) {
    const dx = light.position.x - observerPos.x;
    const dy = light.position.y - observerPos.y;
    const dz = light.position.z - observerPos.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    const r  = Math.sqrt(r2);
    if (r < 0.001) continue;

    // Direction from observer to source (normalised).
    const nx = dx / r;
    const ny = dy / r;
    const nz = dz / r;

    // Only sources in the upper hemisphere (above pitch level) contribute.
    if (ny <= 0) continue;

    // Beam factor: direction from light toward observer = (-nx, -ny, -nz).
    const ax  = light.target.position.x - light.position.x;
    const ay  = light.target.position.y - light.position.y;
    const az  = light.target.position.z - light.position.z;
    const al  = Math.sqrt(ax * ax + ay * ay + az * az);
    const cosToPoint = (-nx) * (ax / al) + (-ny) * (ay / al) + (-nz) * (az / al);
    const cosOuter   = Math.cos(light.angle);
    const cosInner   = Math.cos(light.angle * (1 - light.penumbra));

    const bf = beamFactor(cosToPoint, cosOuter, cosInner, iesExp);
    if (bf === 0) continue;

    // Illuminance at the eye on a plane perpendicular to direction to source.
    const E_eye = light.intensity * bf / r2;

    // Angle between gaze direction and direction to source [degrees].
    const cosTheta = viewDir.x * nx + viewDir.y * ny + viewDir.z * nz;
    const thetaDeg = THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, cosTheta))));

    // Holladay veiling luminance contribution. θ clamped to ≥ 1.5° to avoid singularity.
    const theta = Math.max(thetaDeg, 1.5);
    L_vl += 10 * E_eye / (theta * theta);
  }

  let GR = 0;
  if (L_vl > 0 && L_ve > 0) {
    GR = 27 + 24 * Math.log10(L_vl / Math.pow(L_ve, 0.9));
  }

  return { GR: Math.max(0, GR), L_vl, L_ve };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source luminance (nominal aperture model)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apparent source luminance L_s [cd/m²] for a single SpotLight as seen from
 * an observer position, using a nominal emitter aperture area.
 *
 * Model derivation:
 *   The fixture face normal is approximated as -axis (the beam points from fixture
 *   toward the target; the emitter face points the opposite way).
 *   cos(θ_view) = dot(direction_from_fixture_to_observer, -axis)
 *   A_proj      = fixtureArea × cos(θ_view)   [m²]  projected aperture
 *   L_s         = I(θ_obs) / A_proj           [cd/m²]
 *
 * Reference fixture: Philips ArenaVision LED gen3 (MVF403)
 *   fixtureArea ≈ 0.166 m²  (540 × 308 mm housing aperture)
 *   Typical on-axis L_s ≈ 2 × 10⁶ – 5 × 10⁶ cd/m²
 *
 * @param fixtureArea - nominal luminous aperture of one physical fixture [m²]
 * @returns L_s [cd/m²], or 0 if the source is outside the beam or behind the observer.
 */
export function sourceLuminance(
  light:        THREE.SpotLight,
  observerPos:  THREE.Vector3,
  fixtureArea:  number,
  iesExp = 0,
): number {
  const dx = observerPos.x - light.position.x;
  const dy = observerPos.y - light.position.y;
  const dz = observerPos.z - light.position.z;
  const r2 = dx * dx + dy * dy + dz * dz;
  const r  = Math.sqrt(r2);
  if (r < 0.001) return 0;

  // Direction from light to observer (normalised).
  const nx = dx / r;
  const ny = dy / r;
  const nz = dz / r;

  // Beam axis (normalised).
  const ax  = light.target.position.x - light.position.x;
  const ay  = light.target.position.y - light.position.y;
  const az  = light.target.position.z - light.position.z;
  const al  = Math.sqrt(ax * ax + ay * ay + az * az);
  const axN = ax / al;
  const ayN = ay / al;
  const azN = az / al;

  const cosToPoint = nx * axN + ny * ayN + nz * azN;
  const cosOuter   = Math.cos(light.angle);
  const cosInner   = Math.cos(light.angle * (1 - light.penumbra));

  const bf = beamFactor(cosToPoint, cosOuter, cosInner, iesExp);
  if (bf === 0) return 0;

  // Apparent intensity toward observer.
  const I_obs = light.intensity * bf;

  // cos(θ_view): angle between fixture face normal (-axis) and direction to observer.
  const cosView = Math.max(0, nx * (-axN) + ny * (-ayN) + nz * (-azN));
  const A_proj  = fixtureArea * cosView;
  if (A_proj < 1e-8) return 0;

  return I_obs / A_proj;
}
