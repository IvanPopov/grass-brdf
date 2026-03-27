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
 * Catwalk geometry (parametric ellipse at height H):
 *   x(t) = a × cos(t)   [m],  a = ovalHalfLength
 *   z(t) = b × sin(t)   [m],  b = ovalHalfWidth
 *   y    = rigHeight     [m]
 *   t    = 0 … 2π,  N_sim equally-spaced samples
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

    for (let i = 0; i < params.simulatedCount; i++) {
      // Equally-spaced positions on the ellipse
      const t  = (i / params.simulatedCount) * Math.PI * 2;
      const lx = params.ovalHalfLength * Math.cos(t);
      const lz = params.ovalHalfWidth  * Math.sin(t);
      const ly = params.rigHeight;

      const aimTarget = computeAimTarget(lx, lz, params);

      // SpotLight(color, intensity [cd], distance, angle [rad], penumbra, decay)
      // distance = 0  → no range cutoff
      // decay    = 2  → physical inverse-square attenuation
      const spot = new THREE.SpotLight(color, phys.intensity, 0, halfAngle, params.penumbra, 2);
      spot.position.set(lx, ly, lz);
      spot.target.position.copy(aimTarget);
      spot.castShadow = false;

      const meta: SpotMeta = {
        index:        i,
        groupSize:    phys.groupSize,
        fluxPerGroup: phys.fluxPerGroup,
        intensityCd:  phys.intensity,
        solidAngle:   phys.solidAngle,
        aimTarget:    aimTarget.clone(),
      };
      spot.userData['meta'] = meta;

      this.group.add(spot);
      this.group.add(spot.target);
      this._lights.push(spot);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aiming strategy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIFA cross-firing aiming strategy (FIFA Lighting Regulations §3.3):
 *
 *   West side (lx < 0): aim at east half of pitch  → targetX = +FIELD_W / 4
 *   East side (lx > 0): aim at west half of pitch  → targetX = −FIELD_W / 4
 *   Corner / short side: aim at pitch center       → targetX = 0
 *
 *   Rationale: cross-firing raises vertical illuminance (E_v) for cameras
 *   positioned on both long sides, avoiding "dark player" silhouettes.
 *
 * Z-coverage distribution:
 *   Each light's z-target scales with its z-position so that lights spaced
 *   along the catwalk cover corresponding strips of the field length:
 *
 *   targetZ = lz × (FIELD_H / 2) / ovalHalfWidth × 0.85
 *
 *   The 0.85 factor prevents extreme off-axis aiming near the ends.
 */
function computeAimTarget(lx: number, lz: number, p: LightRigParams): THREE.Vector3 {
  const threshold = p.ovalHalfLength * 0.4; // separates long-side from corner

  let targetX: number;
  if      (lx < -threshold) targetX =  FIELD_W / 4;   // west → east half
  else if (lx >  threshold) targetX = -FIELD_W / 4;   // east → west half
  else                      targetX = 0;               // corner / short side → center

  const targetZ = lz * (FIELD_H / 2 / p.ovalHalfWidth) * 0.85;

  return new THREE.Vector3(targetX, 0, targetZ);
}
