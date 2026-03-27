import * as THREE from 'three';
import gridVert from '../shaders/grid.vert.glsl';
import gridFrag from '../shaders/grid.frag.glsl';

/**
 * Adds a 1 m × 1 m procedural grid that fades smoothly with distance.
 *
 * Implementation: a single large PlaneGeometry(600, 600) with a ShaderMaterial
 * (GLSL 3.00 es) that computes grid lines analytically using fwidth() for
 * anti-aliased sub-pixel coverage, then multiplies alpha by:
 *
 *   fade = 1 − smoothstep(fadeStart, fadeEnd, dist)
 *
 * where dist = length(worldXZ).  fadeStart = 80 m, fadeEnd = 250 m.
 *
 * Polygon offset: pushes the grid behind the field plane in the depth buffer
 * so both can share Y = 0 without Z-fighting.
 */
export function createGrid(scene: THREE.Scene): void {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor:     { value: new THREE.Color(0x707070) },
      uFadeStart: { value: 80.0  },   // [m]
      uFadeEnd:   { value: 250.0 },   // [m]
    },
    vertexShader:   gridVert,
    fragmentShader: gridFrag,
    transparent:    true,
    depthWrite:     false,
    glslVersion:    THREE.GLSL3,
    polygonOffset:  true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits:  1,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  scene.add(mesh);
}
