import * as THREE from 'three';
import { FIELD_W, FIELD_H } from '../config';

/**
 * Creates the FIFA-standard pitch plane and adds it to the scene.
 *
 *   Size:     105 m × 68 m  (FIELD_W × FIELD_H)
 *   Material: MeshStandardMaterial, roughness = 1, metalness = 0
 *             → purely diffuse (Lambertian) response; physically correct
 *               with SpotLight decay = 2 and Three.js physical light mode.
 *
 *   Polygon offset: pulls plane toward camera in depth buffer to avoid
 *   Z-fighting with the 1 m shader grid at the same Y = 0 plane.
 */
export function createField(scene: THREE.Scene): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color:        0x2d7a2d,
    roughness:    1.0,
    metalness:    0.0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits:  -1,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W, FIELD_H), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = false;
  scene.add(mesh);
  return mesh;
}
