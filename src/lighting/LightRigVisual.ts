import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { LightRigParams } from '../config';
import { SpotMeta } from './LightRig';

/**
 * LightRigVisual builds all debug/preview geometry for the lighting rig:
 *   1. Oval catwalk ring at rig height
 *   2. Sphere marker at each SpotLight position
 *   3. Beam cone wireframe for each SpotLight
 *   4. CSS2D HTML label showing computed photometric values
 *
 * All objects live in `this.group`; calling build() disposes the previous
 * set and recreates everything from scratch.
 */
export class LightRigVisual {
  readonly group = new THREE.Group();

  /** When false, beam cone wireframes are omitted from the next build(). */
  showCones = false;

  dispose(): void {
    this.group.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        const m = obj.material;
        Array.isArray(m) ? m.forEach(x => x.dispose()) : (m as THREE.Material).dispose();
      }
    });
    this.group.clear();
  }

  build(lights: readonly THREE.SpotLight[], params: LightRigParams): void {
    this.dispose();

    this.group.add(buildOvalRing(params));

    lights.forEach(spot => {
      const meta = spot.userData['meta'] as SpotMeta;

      // ── Sphere marker at light position ──────────────────────────────────
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffee88, toneMapped: false }),
      );
      sphere.position.copy(spot.position);
      this.group.add(sphere);

      // ── Beam cone wireframe ───────────────────────────────────────────────
      if (this.showCones) {
        //   Direction: from SpotLight position toward aim target
        //   Cone half-angle α = spot.angle                          [rad]
        //   Cone length L = distance from light to aim target        [m]
        //   Base radius r = L × tan(α)                              [m]
        const aimDir  = new THREE.Vector3().subVectors(meta.aimTarget, spot.position).normalize();
        const coneLen = spot.position.distanceTo(meta.aimTarget);
        const coneGeo = buildConeGeometry(spot.position, aimDir, spot.angle, coneLen, 8);
        const coneObj = new THREE.LineSegments(
          coneGeo,
          new THREE.LineBasicMaterial({ color: 0x336688, transparent: true, opacity: 0.35, toneMapped: false }),
        );
        this.group.add(coneObj);
      }

      // ── CSS2D label ───────────────────────────────────────────────────────
      const label = buildLabel(spot);
      // Position 2 m above the sphere so the label clears the marker
      label.position.copy(spot.position).add(new THREE.Vector3(0, 2, 0));
      this.group.add(label);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a closed elliptic ring at rig height representing the catwalk.
 *
 *   x(t) = ovalHalfLength × cos(t)   [m]
 *   z(t) = ovalHalfWidth  × sin(t)   [m]
 *   y    = rigHeight                  [m]
 */
function buildOvalRing(params: LightRigParams): THREE.Line {
  const N   = 128;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push(new THREE.Vector3(
      params.ovalHalfLength * Math.cos(t),
      params.rigHeight,
      params.ovalHalfWidth  * Math.sin(t),
    ));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x445566, toneMapped: false }),
  );
}

/**
 * Builds a wireframe cone as a LineSegments geometry.
 *
 * Cone parameters:
 *   tip       – apex position (SpotLight position)         [m]
 *   dir       – normalised beam axis direction
 *   alpha     – outer cone half-angle                      [rad]
 *   length    – cone height along beam axis                [m]
 *   nRays     – number of radial line segments
 *
 * Base radius:  r = length × tan(alpha)                    [m]
 *
 * Orthonormal basis (right, up) perpendicular to dir is found by
 * rejecting the world-up vector (or world-right if dir ≈ vertical).
 */
function buildConeGeometry(
  tip:    THREE.Vector3,
  dir:    THREE.Vector3,
  alpha:  number,
  length: number,
  nRays:  number,
): THREE.BufferGeometry {
  const axis = dir.clone().normalize();

  const worldUp = new THREE.Vector3(0, 1, 0);
  const ref     = Math.abs(axis.dot(worldUp)) < 0.99 ? worldUp : new THREE.Vector3(1, 0, 0);
  const right   = new THREE.Vector3().crossVectors(axis, ref).normalize();
  const up      = new THREE.Vector3().crossVectors(right, axis).normalize();

  // r = L × tan(α)  [m]
  const r    = length * Math.tan(alpha);
  const base = new THREE.Vector3().copy(tip).addScaledVector(axis, length);

  const verts: number[] = [];

  // Rays from tip to base ring
  for (let i = 0; i < nRays; i++) {
    const a    = (i / nRays) * Math.PI * 2;
    const edge = base.clone()
      .addScaledVector(right, r * Math.cos(a))
      .addScaledVector(up,    r * Math.sin(a));
    verts.push(tip.x, tip.y, tip.z, edge.x, edge.y, edge.z);
  }

  // Base ring
  for (let i = 0; i < nRays; i++) {
    const a1 = (i       / nRays) * Math.PI * 2;
    const a2 = ((i + 1) / nRays) * Math.PI * 2;
    const e1 = base.clone().addScaledVector(right, r * Math.cos(a1)).addScaledVector(up, r * Math.sin(a1));
    const e2 = base.clone().addScaledVector(right, r * Math.cos(a2)).addScaledVector(up, r * Math.sin(a2));
    verts.push(e1.x, e1.y, e1.z, e2.x, e2.y, e2.z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return geo;
}

/**
 * Creates a CSS2DObject (HTML label) showing computed photometric values
 * for the given SpotLight.
 *
 * Displayed values:
 *   #NN        – fixture index
 *   Φ = … klm  – group luminous flux    [kilolumens]
 *   I = … kcd  – group intensity        [kilocandela]
 *   G = …      – group size             [fixtures/SpotLight]
 *   θ = …°     – dynamic beam angle     [degrees]
 */
function buildLabel(spot: THREE.SpotLight): CSS2DObject {
  const meta = spot.userData['meta'] as SpotMeta;
  const klm  = (meta.fluxPerGroup / 1_000).toFixed(0);
  const kcd  = (meta.intensityCd  / 1_000).toFixed(0);
  const deg  = Math.round(THREE.MathUtils.radToDeg(spot.angle * 2));

  const div = document.createElement('div');
  div.className = 'light-label';
  div.innerHTML =
    `<b>#${String(meta.index + 1).padStart(2, '0')}</b>` +
    `<br>Φ = ${klm} klm` +
    `<br>I = ${kcd} kcd` +
    `<br>G = ${meta.groupSize} &middot; θ = ${deg}°`;

  return new CSS2DObject(div);
}
