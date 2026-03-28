import * as THREE from 'three';
import { FIELD_W, FIELD_H } from '../config';
import { FieldMaterial } from './FieldMaterial';

/**
 * Schematic single-tier spectator stand placed along the North touchline.
 *
 * Dimensions are based on UEFA/FIFA stadium design guidelines and typical
 * lower-tier stand geometry of modern professional stadiums:
 *
 *   Safety/run-off zone (touchline to front barrier):
 *     Standard: 3–7 m behind touchline. We use 4 m (FIFA min. is 3 m for
 *     Class V broadcast stadiums with a permanent barrier).
 *
 *   First row floor height above pitch level:
 *     Typical: 0.8–1.2 m.  We use 0.9 m so the first row has a clear view
 *     over the safety barrier (~0.7 m) at pitch level.
 *
 *   Row depth (front-to-back, "tread"):
 *     Minimum UEFA: 0.80 m.  Comfortable: 0.90 m.  We use 0.85 m.
 *
 *   Row rise (height increment per row, "riser"):
 *     Minimum visibility: 0.12 m.  Standard: 0.20 m (c-value sight-line).
 *     We use 0.20 m — gives adequate viewing angle over adjacent spectator.
 *
 *   Slab thickness (structural floor plate):
 *     Typically 0.20–0.30 m reinforced concrete.  We use 0.22 m as it
 *     gives a clear visual separation between steps in the schematic view.
 *
 *   Stand width:
 *     Follows the pitch length (105 m) plus a small structural overhang.
 *     We use FIELD_W + 10 m (5 m each end) for a realistic fascia.
 *
 *   Number of rows: 22 (typical lower tier, ~10 m vertical rise).
 *
 * Material: concrete grey, IES-corrected illuminance via the shared
 * FieldMaterial shader (same DataTexture, shared uniform objects).
 * The shader computes E_h = I × beamFactor × cosθ / r² per fragment,
 * where cosθ = dot(lightDir, surfaceNormal).  For horizontal step surfaces
 * (top faces of each row slab, normal = +Y) this gives correct photometric
 * horizontal illuminance.
 */

export const SAFETY_GAP  = 9.0;   // [m] touchline → stand front barrier (UEFA Cat.4 typical 7–10 m)
export const FIRST_ROW_H = 1.0;   // [m] first row floor above pitch
export const ROW_DEPTH   = 0.85;  // [m] tread depth per row (UEFA minimum 0.80 m)
export const ROW_RISE    = 0.32;  // [m] riser height per row — governs the rake angle.
export const NUM_ROWS    = 34;    // rows in lower tier.
                            // Calculated from c-value sightline formula:
                            //   c = (N_rise × (D_focal + d_prev)) / (H_prev × D_focal) - N_rise
                            // Modern UEFA/FIFA stadiums target c ≥ 90 mm; 0.32 m rise
                            // at 0.85 m depth gives tan(rake) ≈ 0.38 → ~21° initial rake,
                            // steepening progressively as the focal distance grows.
                            // Allianz Arena: ~0.30 m.  Emirates: ~0.30 m.  Wembley: ~0.33 m.
const SLAB_H = 0.22;  // [m] structural slab / step thickness (reinforced concrete)
export const STAND_W = FIELD_W + 10; // [m] stand width (5 m structural overhang each end)

// Concrete grey in sRGB → linear for physical shader.
const CONCRETE_COLOR = new THREE.Color(0x888888).convertSRGBToLinear();

/**
 * Manages the stand geometry. Call build() once to create the meshes.
 * Light data propagates automatically through the shared FieldMaterial uniforms
 * so no per-frame update is required here.
 */
export class Stands {
  readonly group = new THREE.Group();

  build(fieldMat: FieldMaterial): void {
    // Remove any existing geometry.
    this.group.clear();

    // isSurfaceGrass = 0.0 → always Lambertian regardless of grass BRDF mode.
    const mat = fieldMat.createMaterial(CONCRETE_COLOR, 0.0);

    for (let i = 0; i < NUM_ROWS; i++) {
      // Floor height of this row (underside of slab sits here).
      const rowFloorY = FIRST_ROW_H + i * ROW_RISE;
      // Centre of slab in Y.
      const slabCenterY = rowFloorY + SLAB_H / 2;
      // Centre of slab in Z: each row is one step back from the previous.
      // North stand → positive Z (behind the north touchline).
      const slabCenterZ = FIELD_H / 2 + SAFETY_GAP + (i + 0.5) * ROW_DEPTH;

      const geo  = new THREE.BoxGeometry(STAND_W, SLAB_H, ROW_DEPTH);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, slabCenterY, slabCenterZ);
      this.group.add(mesh);
    }
  }
}
