import * as THREE from 'three';
import { LightRigParams, FIELD_W, FIELD_H } from '../config';
import { cctToColor } from './colorTemp';

// ─────────────────────────────────────────────────────────────────────────────
// Physics types
// ─────────────────────────────────────────────────────────────────────────────

/** Photometric parameters computed for one simulated SpotLight group. */
export interface GroupPhysics {
  groupSize:    number; // real fixtures represented by one SpotLight     [qty]
  fluxPerGroup: number; // total luminous flux of one group               [lm]
  solidAngle:   number; // beam cone solid angle                          [sr]
  intensity:    number; // luminous intensity of one simulated SpotLight  [cd]
}

/** Metadata attached to each SpotLight via userData for labels and future sensor math. */
export interface SpotMeta {
  index:        number;
  groupSize:    number;
  fluxPerGroup: number; // [lm]
  intensityCd:  number; // [cd]
  solidAngle:   number; // [sr]
  aimTarget:    THREE.Vector3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Physics computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts total-rig parameters to per-simulated-SpotLight photometric values.
 *
 * Grouping:
 *   G = ceil(N_total / N_sim)               [fixtures per group, dimensionless]
 *   Φ_group = G × Φ_fixture                 [lm]
 *
 * Solid angle of a cone with full beam angle θ:
 *   Ω = 2π × (1 − cos(θ / 2))              [sr]
 *   where θ = beamAngleDeg converted to radians
 *
 * Luminous intensity from flux and solid angle:
 *   I = Φ_group / Ω                         [cd]
 *
 * Three.js physical mode (useLegacyLights = false, default since r155):
 *   SpotLight.intensity  → candela [cd]
 *   SpotLight.decay = 2  → inverse-square-law: E = I × cos(θ_inc) / r²  [lux]
 *
 * ── SpotLight model vs real IES profiles ─────────────────────────────────────
 *
 * Three.js SpotLight assumes a uniform-intensity cone with a smooth penumbra edge:
 *   I(θ) = I₀ × smoothstep(cosOuter, cosInner, cosθ)
 *   Rotationally symmetric. No near-field effects. No wavelength-dependent terms.
 *
 * Real stadium fixture (e.g., Philips ArenaVision MVF403, Musco TLC for LED):
 *   IES photometric file contains a measured angular intensity table.
 *   - Type V (rotationally symmetric) for most stadium floodlights: closest to SpotLight.
 *   - Intensity falls off roughly as cos^n(θ) or Gaussian from the axis peak.
 *   - Provides separate beam angle (50% intensity half-angle) and field angle (10%).
 *
 * Key mapping — IES angle definitions vs Three.js:
 *   IES beam angle: half-angle at I = 50% of peak.
 *   IES field angle: half-angle at I = 10% of peak.
 *   Three.js `angle` = outer cone half-angle, where I → 0 (penumbra start) or = 0 (no penumbra).
 *   → Three.js `angle` corresponds to the IES FIELD angle (10% point), not the beam angle.
 *   → For a real fixture with a 20° IES full field angle, set beamAngleDeg = 20.
 *   → FIFA Class V fixtures: IES field angle typically 20–35° full → beamAngleDeg = 20–35.
 *
 * SpotLight vs IES — accuracy for E_h simulation:
 *   The uniform-cone model assumes I₀ everywhere inside the beam, while a real IES
 *   profile peaks on-axis and falls off.  Effect on illuminance:
 *     • On-axis (aim point):  SpotLight UNDER-estimates by ~20–40% vs IES peak.
 *     • Off-axis edge:        SpotLight OVER-estimates vs IES (more gradual IES falloff).
 *     • Field-average E_h:    errors partially cancel; total flux is conserved.
 *     • U1 / U2 uniformity ratios: relative comparison valid; absolute lux ±20%.
 *
 * Penumbra calibration:
 *   Real stadium fixtures have a sharp beam edge. The soft-edge fraction in Three.js
 *   should be 0.05–0.15 (corresponding to ~5–10° transition zone at the cone edge).
 *   Default changed from 0.25 (too diffuse) to 0.10 in config.ts.
 *
 * Is full IES simulation needed?
 *   For aiming-strategy comparison and E_h uniformity analysis: NO — SpotLight is
 *   adequate if beam angle and flux are set correctly.
 *   For absolute lux values (±5%), E_v camera quality, or UGR glare calculations:
 *   YES — asymmetric IES profiles should be loaded and sampled per-fixture.
 *   IES integration is deferred; it will be added alongside the sensor module.
 */
export function computeGroupPhysics(p: LightRigParams): GroupPhysics {
  const groupSize    = Math.ceil(p.fixtureCount / p.simulatedCount);
  const fluxPerGroup = groupSize * p.fluxPerFixture;                    // [lm]

  // Full beam angle → half-angle for solid-angle formula
  const theta      = THREE.MathUtils.degToRad(p.beamAngleDeg);
  const solidAngle = 2 * Math.PI * (1 - Math.cos(theta / 2));          // [sr]

  // I = Φ / Ω   [cd]
  const intensity  = fluxPerGroup / solidAngle;

  return { groupSize, fluxPerGroup, solidAngle, intensity };
}

// ─────────────────────────────────────────────────────────────────────────────
// IES cookie texture
// ─────────────────────────────────────────────────────────────────────────────

// buildIesTexture() was removed: applying SpotLight.map to 40+ lights exceeds
// MAX_TEXTURE_IMAGE_UNITS (16) in WebGL fragment shaders.  IES is handled
// entirely in the CPU sampler (IlluminanceSampler.ts, sampleEh / sampleEv).

// ─────────────────────────────────────────────────────────────────────────────
// LightRig class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages an array of shadow-free SpotLights arranged on an elliptical catwalk.
 * Each SpotLight represents a group of G real LED floodlight fixtures.
 *
 * Physical setup:
 *   - SpotLight.intensity = I_group  [cd]  (see computeGroupPhysics)
 *   - SpotLight.decay     = 2        → E [lux] = I [cd] × cos(θ_inc) / r² [m²]
 *   - SpotLight.angle     = θ/2      [rad]  outer cone half-angle
 *   - SpotLight.castShadow = false   (no shadow maps; illuminance only)
 *
 * Catwalk geometry — long-side arcs only:
 *
 *   Real FIFA stadiums never place lights behind the goals (20° exclusion zone).
 *   Lights are distributed only on the two long-side arcs where |sin(t)| >= LONG_SIDE_MIN,
 *   i.e., alongside the 105 m touchlines, not behind the 68 m goal lines.
 *
 *   North arc:  t ∈ [tStart, π − tStart],   z > 0
 *   South arc:  t ∈ [π + tStart, 2π − tStart], z < 0
 *
 *   tStart = arcsin(LONG_SIDE_MIN),  LONG_SIDE_MIN = 0.45
 *   → |lz| >= ovalHalfWidth × 0.45 for every simulated light
 *
 *   N/2 lights are placed on each arc with uniform angular spacing.
 */
export class LightRig {
  /** Add this group to the scene once; its contents are rebuilt on each build(). */
  readonly group = new THREE.Group();

  private _lights: THREE.SpotLight[] = [];

  get lights(): readonly THREE.SpotLight[] { return this._lights; }

  dispose(): void {
    this.group.clear();
    this._lights = [];
  }

  build(params: LightRigParams): void {
    this.dispose();

    const phys      = computeGroupPhysics(params);
    const color     = cctToColor(params.colorTempK);
    // SpotLight.angle = outer cone HALF-angle [rad]
    const halfAngle = THREE.MathUtils.degToRad(params.beamAngleDeg / 2);

    // ── IES cookie texture ────────────────────────────────────────────────────
    // SpotLight.map can approximate the IES beam distribution visually, but
    // requires NUM_SPOT_LIGHT_MAPS texture samplers in the fragment shader.
    // With 40+ lights, this exceeds the WebGL limit of 16 texture image units
    // (MAX_TEXTURE_IMAGE_UNITS), causing a shader compile error at runtime.
    //
    // The IES power-cosine correction is therefore applied ONLY in the CPU
    // illuminance sampler (sampleEh / sampleEv / sampleGlare in
    // IlluminanceSampler.ts), which drives the heatmap and console metrics.
    // The GPU-rendered scene continues to use uniform cones — an acceptable
    // visual approximation since the rendered image is not the final deliverable.
    //
    // If GPU IES rendering is needed in future (e.g., for camera HDR simulation),
    // the approach must either: (a) merge all spots into a single draw call with
    // an IES texture atlas, or (b) render each spot into a separate offscreen
    // accumulation buffer.  The buildIesTexture() function below remains available.

    // ── Long-side arc placement ───────────────────────────────────────────────
    // LONG_SIDE_MIN = 0.45 → |lz| >= ovalHalfWidth × 0.45 for all primary lights.
    // This eliminates goal-end positions (FIFA 20° exclusion zone).
    const LONG_SIDE_MIN = 0.45;
    const tStart  = Math.asin(LONG_SIDE_MIN); // ≈ 26.7°
    const tEnd    = Math.PI - tStart;          // ≈ 153.3°
    const arcSpan = tEnd - tStart;

    const N    = params.simulatedCount;
    const half = Math.ceil(N / 2);

    const addSpot = (lx: number, ly: number, lz: number, aim: THREE.Vector3, idx: number): void => {
      const spot = new THREE.SpotLight(color, phys.intensity, 0, halfAngle, params.penumbra, 2);
      spot.position.set(lx, ly, lz);
      spot.target.position.copy(aim);
      spot.castShadow = false;
      spot.userData['meta'] = {
        index: idx, groupSize: phys.groupSize,
        fluxPerGroup: phys.fluxPerGroup, intensityCd: phys.intensity,
        solidAngle: phys.solidAngle, aimTarget: aim.clone(),
      } satisfies SpotMeta;
      this.group.add(spot);
      this.group.add(spot.target);
      this._lights.push(spot);
    };

    for (let i = 0; i < N; i++) {
      const isNorth = i < half;
      const j       = isNorth ? i : i - half;
      const frac    = (j + 0.5) / half;
      const t       = isNorth
        ? tStart + frac * arcSpan
        : Math.PI + tStart + frac * arcSpan;

      const lx = params.ovalHalfLength * Math.cos(t);
      const lz = params.ovalHalfWidth  * Math.sin(t);

      addSpot(lx, params.rigHeight, lz, computeMainAimTarget(lx, lz, isNorth, params), i);
    }

    // ── Corner fill lights ────────────────────────────────────────────────────
    // Placed at the 4 diagonal roof corners (just outside the long-side arc),
    // each aimed at the lateral midfield zone that primary cross-fire leaves dark.
    // Checked against FIFA 20° exclusion: |azimuth from goal| ≈ 29° > 20° ✓
    if (params.fillCount > 0) {
      const fillPositions = buildFillPositions(params);
      fillPositions.forEach((fp, fi) => {
        addSpot(fp.lx, params.rigHeight, fp.lz, fp.aim, N + fi);
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aiming strategy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Primary aiming — FIFA §3.3 cross-firing.
 *
 * Each long-side light aims at the OPPOSITE QUARTER of the pitch:
 *   North side (lz > 0) → south half, depth = FIELD_H / 4 ≈ 17 m from centre.
 *   South side (lz < 0) → north half, same depth.
 *
 * This is the strategy specified in FIFA Lighting Regulations §3.3 and
 * implemented in every professional stadium: lights on one side illuminate
 * the far half to raise E_v for cameras positioned on that side, while the
 * other side's lights raise E_v for the opposite cameras.
 *
 * X-distribution:
 *   targetX = lx × (FIELD_W/2 / ovalHalfLength) × 0.75
 *   Proportional mapping keeps aim points inside the pitch (0.75 scale factor
 *   prevents extreme corner targets when lx ≈ ovalHalfLength).
 *
 * Known limitation with N_sim << N_real:
 *   312 real fixtures each aim at a unique ~22 m² patch; with 32 simulated
 *   lights every beam covers ~220 m².  The quarter-point zone (z ≈ ±17 m) will
 *   appear brighter than adjacent strips — acceptable for strategy comparison,
 *   not for precise absolute lux.  Use N_sim = fixtureCount for full accuracy.
 */
function computeMainAimTarget(
  lx:      number,
  _lz:     number,
  isNorth: boolean,
  p:       LightRigParams,
): THREE.Vector3 {
  const halfSign = isNorth ? -1 : 1;
  // Quarter-point cross-fire depth [m]
  const targetZ = halfSign * FIELD_H / 4;
  // Longitudinal distribution proportional to light position [m]
  const targetX = lx * (FIELD_W / 2 / p.ovalHalfLength) * 0.75;
  return new THREE.Vector3(
    Math.max(-FIELD_W * 0.47, Math.min(FIELD_W * 0.47, targetX)),
    0,
    targetZ,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Corner fill lights
// ─────────────────────────────────────────────────────────────────────────────

interface FillPosition { lx: number; lz: number; aim: THREE.Vector3; }

/**
 * Generates positions and aim targets for supplemental corner-fill lights.
 *
 * Real FIFA stadiums have a secondary set of fixtures at the corners of the roof
 * structure to cover zones that primary cross-firing leaves dark:
 *   1. The lateral midfield seam (x ≈ ±40–52 m, z ≈ 0).
 *   2. The far field corners (|x| ≈ 45–52 m, |z| ≈ 28–34 m).
 *
 * Placement (per fill light):
 *   t_fill = tStart − FILL_OFFSET_DEG outside each arc endpoint.
 *   At tStart ≈ 26.7°, fill lights land at t ≈ 14.7°:
 *     lx ≈ ±77 m,  lz ≈ ±14 m
 *   FIFA 20° exclusion check: azimuth from goal centre ≈ arctan(14/24.5) ≈ 30° > 20° ✓
 *
 * Aiming — two rings:
 *
 *   Base ring (fi 0–3): cross-fire to the OPPOSITE goal-centre seam.
 *     East fills  (lx > 0): aim at (−FIELD_W × 0.47,  0,  0)  [west goal centre]
 *     West fills  (lx < 0): aim at (+FIELD_W × 0.47,  0,  0)  [east goal centre]
 *   This specifically fixes the 0-lux zone at x = ±52.5, z = 0 that the primary
 *   quarter-point cross-fire cannot cover (all 32 primary beams pass through z = ±17).
 *
 *   Extra ring (fi 4–7): placed one step further outside, aimed at the far diagonal
 *   field corners that remain dark after both primary and base-ring illumination.
 *     NE fill → south-west corner zone (−FIELD_W × 0.42,  0,  −FIELD_H × 0.42)
 *     NW fill → south-east corner zone
 *     SW fill → north-east corner zone
 *     SE fill → north-west corner zone
 *
 * fillCount controls how many positions are instantiated (default 8 = both rings).
 */
function buildFillPositions(p: LightRigParams): FillPosition[] {
  const LONG_SIDE_MIN   = 0.45;
  const tStart          = Math.asin(LONG_SIDE_MIN);         // ≈ 26.7°
  const FILL_OFFSET_RAD = THREE.MathUtils.degToRad(12);     // place 12° outside arc

  // 4 base positions: NE, NW, SW, SE corners of the oval
  const baseAngles = [
    tStart - FILL_OFFSET_RAD,                    // NE  (lx > 0, lz > 0)
    Math.PI - tStart + FILL_OFFSET_RAD,          // NW  (lx < 0, lz > 0)
    Math.PI + tStart - FILL_OFFSET_RAD,          // SW  (lx < 0, lz < 0)
    2 * Math.PI - tStart + FILL_OFFSET_RAD,      // SE  (lx > 0, lz < 0)
  ];

  // 4 extra positions for fillCount > 4: second ring, aimed at midfield seam
  const extraAngles = baseAngles.map(a => {
    const sign = Math.sin(a) >= 0 ? 1 : -1;
    return a - sign * FILL_OFFSET_RAD;            // one step further outside arc
  });

  const allAngles = [...baseAngles, ...extraAngles];

  const positions: FillPosition[] = [];
  for (let fi = 0; fi < Math.min(p.fillCount, allAngles.length); fi++) {
    const t  = allAngles[fi];
    const lx = p.ovalHalfLength * Math.cos(t);
    const lz = p.ovalHalfWidth  * Math.sin(t);
    const isNorthFill = lz > 0;
    const halfSign    = isNorthFill ? -1 : 1;

    let aim: THREE.Vector3;
    if (fi < 4) {
      // Base ring — cross-fire to the OPPOSITE goal-centre seam.
      // East fills aim at west goal centre; west fills aim at east goal centre.
      // This covers the 0-lux zone at (±FIELD_W/2, 0, 0) that primary cross-fire misses.
      aim = new THREE.Vector3(-Math.sign(lx) * FIELD_W * 0.47, 0, 0);
    } else {
      // Extra ring — aim at the far diagonal field corners (cross-fire).
      // Uses negative-X cross-fire (opposite side) and opposite-half Z cross-fire.
      aim = new THREE.Vector3(
        -Math.sign(lx) * FIELD_W * 0.42,
        0,
        halfSign * FIELD_H * 0.42,
      );
    }

    positions.push({ lx, lz, aim });
  }
  return positions;
}
