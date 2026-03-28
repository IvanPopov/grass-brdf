import * as THREE from 'three';
import { FIELD_W, FIELD_H } from '../config';
import { FieldMaterial } from './FieldMaterial';

/**
 * Creates the FIFA-standard pitch plane and adds it to the scene.
 *
 *   Size:     105 m × 68 m  (FIELD_W × FIELD_H)
 *   Material: custom ShaderMaterial (FieldMaterial) — computes E_h per fragment
 *             using the IES power-cosine formula, identical to IlluminanceSampler.ts.
 *             This makes the rendered field visually match the heatmap at all times.
 *
 *   Physical output:
 *     L_surface = (albedo / π) × E_h  [cd/m²]
 *     albedo ≈ 0.15 for natural grass.
 *     Three.js renderer applies ACES tonemapping and exposure as usual.
 *
 *   Polygon offset: pulls plane toward camera in depth buffer to avoid
 *   Z-fighting with the 1 m shader grid at the same Y = 0 plane.
 */
export function createField(scene: THREE.Scene): { mesh: THREE.Mesh; fieldMat: FieldMaterial } {
  const fieldMat = new FieldMaterial();

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, FIELD_H), fieldMat.material);
  mesh.rotation.x = -Math.PI / 2;
  // Raise field 5 mm above Y=0 to eliminate Z-fighting with the grid plane.
  // polygonOffset alone is insufficient at top-down view (slope ≈ 0 → Factor
  // contribution vanishes; only Units applies, and 2 units is below precision).
  mesh.position.y = 0.005;
  mesh.receiveShadow = false;
  scene.add(mesh);

  return { mesh, fieldMat };
}
