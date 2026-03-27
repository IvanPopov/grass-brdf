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
  // Total rated flux of the group (for display — before optical losses).
  const fluxPerGroup = groupSize * p.fluxPerFixture;                    // [lm]

  // Full beam angle → half-angle for solid-angle formula
  const theta      = THREE.MathUtils.degToRad(p.beamAngleDeg);
  const solidAngle = 2 * Math.PI * (1 - Math.cos(theta / 2));          // [sr]

  // Effective flux delivered within the beam cone after luminaire optical losses.
  //
  //   Φ_beam = Φ_total × beamEfficiency
  //
  // The rated luminous flux is measured over the full IES distribution.
  // Only a fraction lands inside the specified beam cone; the rest goes into
  // the penumbra, wide-angle spill, and internal luminaire absorption.
  // For modern LED stadium fixtures: beamEfficiency ≈ 0.40–0.63 (default 0.50).
  //
  // I = Φ_beam / Ω   [cd]
  const intensity  = fluxPerGroup * p.beamEfficiency / solidAngle;

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

    // ── Long-side arc placement (Auto-Grid Aiming) ─────────────────────────
    // LONG_SIDE_MIN = 0.45 → |lz| >= ovalHalfWidth × 0.45 for all primary lights.
    // This eliminates goal-end positions (FIFA 20° exclusion zone).
    const LONG_SIDE_MIN = 0.45;
    const tStart  = Math.asin(LONG_SIDE_MIN); // ≈ 26.7°
    const tEnd    = Math.PI - tStart;          // ≈ 153.3°
    const arcSpan = tEnd - tStart;

    const N    = params.simulatedCount;
    const half = Math.ceil(N / 2);
    const southCount = N - half;

    interface SpotDef { lx: number; lz: number; isNorth: boolean; }
    const northSpots: SpotDef[] = [];
    const southSpots: SpotDef[] = [];

    for (let i = 0; i < N; i++) {
      const isNorth = i < half;
      const j       = isNorth ? i : i - half;
      const count   = isNorth ? half : southCount;
      const frac    = (j + 0.5) / count;
      const t       = isNorth
        ? tStart + frac * arcSpan
        : Math.PI + tStart + frac * arcSpan;

      const lx = params.ovalHalfLength * Math.cos(t);
      const lz = params.ovalHalfWidth  * Math.sin(t);
      
      if (isNorth) northSpots.push({ lx, lz, isNorth });
      else         southSpots.push({ lx, lz, isNorth });
    }

    // Sort positions geographically from West (-X) to East (+X)
    northSpots.sort((a, b) => a.lx - b.lx);
    southSpots.sort((a, b) => a.lx - b.lx);

    // Generate interleaved "zigzag" targets.
    // Instead of a 2D matrix that might not divide evenly (leaving black corners),
    // we strictly space the X coordinates evenly from West to East to match the lights.
    // The Z coordinates cycle through a pattern (Far, Near, Mid) so adjacent lights
    // cover different depths, blending their penumbras perfectly.
    const buildGridTargets = (count: number, targetZSign: number): THREE.Vector3[] => {
      if (count === 0) return [];
      
      // Cycle through the Z pattern.
      // We push the "Far" target deeply (0.90) to cover the far touchline,
      // and the "Near" target (0.15) to cover the midfield seam.
      // let zPattern = [0.5]; // Mid only - Removed to fix lint error
      // if (count >= 12) {
      //   zPattern = [0.90, 0.15, 0.50]; // Far, Near, Mid
      // } else if (count >= 6) {
      //   zPattern = [0.85, 0.25];       // Far, Near
      // }

      const targets: THREE.Vector3[] = [];
      // In order to push more light into the corners (which suffer from severe r^2 dropoff),
      // we use a modified sine curve to non-linearly distribute the targets.
      // This clusters targets densely at the extreme edges (x = ±48.5) and spaces them
      // out in the centre, effectively taking energy away from the "hot ridge" in the
      // middle and moving it to the dark edges.
      for (let i = 0; i < count; i++) {
        const linearFrac = count > 1 ? i / (count - 1) : 0.5; // 0.0 to 1.0
        
        // angle goes from -PI/2 to PI/2
        const angle = (linearFrac - 0.5) * Math.PI;
        // sin(angle) gives -1.0 to 1.0, heavily clustered at the ends
        const sineFrac = (Math.sin(angle) + 1.0) / 2.0; // map back to 0.0 to 1.0
        
        // Blend linear and sine distributions
        // 0.25 weight to sine (was 0.5) shifts even more targets back towards the center of the field,
        // reducing the concentration of light at the penalty areas and boosting the midfield.
        const xFrac = linearFrac * 0.75 + sineFrac * 0.25;
        
        // Target spans 92% of the pitch width (-48.3m to +48.3m)
        // Pulled in slightly from 96% to move energy away from the extreme goal areas towards the center.
        const cx = -FIELD_W * 0.46 + xFrac * (FIELD_W * 0.92);
        
        // We need a stable pattern that ensures the FAR edge (touchline) is hit 
        // consistently along the entire length of the pitch.
        let zPattern = [0.5]; // Mid only
        if (count >= 12) {
          // Push Far target even deeper (0.95) to combat r^2 and steep incidence angle
          // Pull Near slightly deeper (0.20) to smooth the gap.
          zPattern = [0.95, 0.20, 0.95, 0.55]; 
        } else if (count >= 6) {
          zPattern = [0.90, 0.25];
        }

        // Cycle through the Z pattern
        const baseZFrac = zPattern[i % zPattern.length];
        
        // Push the Far and Near targets slightly further outwards to combat Z-axis dropoff
        // 0.25 (was 0.20) pushes the extreme edges a bit further to catch the touchlines.
        let compensatedZFrac = baseZFrac + (baseZFrac - 0.5) * 0.25;
        
        // Apply "barrel distortion" to the Z targets:
        // At the midfield (angle ~ 0, cos(angle) ~ 1), the throw distance across the pitch is much longer
        // than at the corners, creating an "hourglass" shape of illuminance (dark waist at edges).
        // We compensate by pushing the Z targets further outwards (away from center) specifically at the midfield.
        const barrelBoost = Math.cos(angle) * 0.10; // Push up to 10% further outwards at X=0 (was 0.20)
        compensatedZFrac += barrelBoost;
        
        // Clamp to avoid aiming completely into the stands
        compensatedZFrac = Math.min(1.05, Math.max(0.0, compensatedZFrac));
        
        const cz = targetZSign * (FIELD_H / 2) * compensatedZFrac;
        
        targets.push(new THREE.Vector3(cx, 0, cz));
      }
      return targets;
    };

    const northTargets = buildGridTargets(half, -1); // North aims South (z < 0)
    const southTargets = buildGridTargets(southCount, 1); // South aims North (z > 0)

    // The parameter beamAngleDeg is now treated as the "reference" angle for a
    // nominal throw distance (e.g. 70 m).  We adjust each fixture's actual angle
    // inversely with throw distance so that the projected spot size on the field
    // remains roughly constant.
    const REFERENCE_THROW = 70.0; // [m] throw distance where beam = param.beamAngleDeg

    let spotIndex = 0;
    const addSpot = (lx: number, ly: number, lz: number, aim: THREE.Vector3, idx: number): void => {
      const pos = new THREE.Vector3(lx, ly, lz);
      const throwDist = pos.distanceTo(aim);
      
      // Dynamic beam angle: narrow for far throws, wide for near throws.
      // clamped between 15° (very narrow) and 45° (very wide) to stay realistic.
      const dynamicBeamDeg = THREE.MathUtils.clamp(
        params.beamAngleDeg * (REFERENCE_THROW / throwDist),
        15,
        45,
      );
      const dynamicHalfAngle = THREE.MathUtils.degToRad(dynamicBeamDeg / 2);
      
      // Recompute intensity.
      // We don't want a pure 1/solidAngle scale, because it overcompensates and
      // burns out the centre. We blend between constant-intensity and constant-flux.
      const refSolidAngle = 2 * Math.PI * (1 - Math.cos(THREE.MathUtils.degToRad(params.beamAngleDeg / 2)));
      const dynamicSolidAngle = 2 * Math.PI * (1 - Math.cos(dynamicHalfAngle));
      
      // base intensity = Flux / RefSolidAngle
      const baseIntensity = phys.fluxPerGroup * params.beamEfficiency / refSolidAngle;
      // perfect conservation = Flux / DynamicSolidAngle
      const conservedIntensity = phys.fluxPerGroup * params.beamEfficiency / dynamicSolidAngle;
      
      // Interpolate: 0.6 favors constant spot size over constant lux
      const dynamicIntensity = THREE.MathUtils.lerp(baseIntensity, conservedIntensity, 0.6);

      const spot = new THREE.SpotLight(
        color, dynamicIntensity, 0, dynamicHalfAngle, params.penumbra, 2,
      );
      spot.position.copy(pos);
      spot.target.position.copy(aim);
      spot.castShadow = false;
      spot.userData['meta'] = {
        index: idx, groupSize: phys.groupSize,
        fluxPerGroup: phys.fluxPerGroup, intensityCd: dynamicIntensity,
        solidAngle: dynamicSolidAngle, aimTarget: aim.clone(),
      } satisfies SpotMeta;
      this.group.add(spot);
      this.group.add(spot.target);
      this._lights.push(spot);
    };

    const placeSpots = (spots: SpotDef[], targets: THREE.Vector3[]) => {
      for (let i = 0; i < spots.length; i++) {
        const spotDef = spots[i];
        addSpot(spotDef.lx, params.rigHeight, spotDef.lz, targets[i], spotIndex++);
      }
    };

    placeSpots(northSpots, northTargets);
    placeSpots(southSpots, southTargets);

  }
}
