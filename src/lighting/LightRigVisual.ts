import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { LightRigParams } from '../config';
import { SpotMeta } from './LightRig';

/**
 * LightRigVisual builds all debug/preview geometry for the lighting rig:
 *   1. Oval catwalk ring at rig height
 *   2. Sphere marker at each SpotLight position
 *   3. Beam cone wireframe (when showCones = true)
 *   4. Visor plate (when visorTan is in meaningful range, i.e. visorMarginDeg < ~79 deg)
 *   5. CSS2D HTML label showing computed photometric values
 *
 * Visor geometry matches the shader cutoff exactly.
 * The shader blocks fragments where  dyLocal > visorTan * dzLocal.
 * In world space this is the plane: dot(fragDir, upLocal - visorTan * axis) = 0.
 * The visor plate is a rectangle lying IN this plane, extending from the fixture
 * aperture outward along  plateDir = axis + visorTan * upLocal.
 *
 * All objects live in `this.group`; calling build() disposes the previous set.
 */
export class LightRigVisual {
  readonly group = new THREE.Group();

  /** When true, beam cone wireframes are included in build(). */
  showCones = false;

  /** When true, CSS2D photometric labels are included in build(). */
  showLabels = false;

  dispose(): void {
    this.group.traverse(obj => {
      if (
        obj instanceof THREE.Mesh ||
        obj instanceof THREE.LineSegments ||
        obj instanceof THREE.Line
      ) {
        obj.geometry.dispose();
        const m = obj.material;
        Array.isArray(m)
          ? m.forEach(x => x.dispose())
          : (m as THREE.Material).dispose();
      }
    });
    this.group.clear();
  }

  build(lights: readonly THREE.SpotLight[], params: LightRigParams): void {
    this.dispose();
    this.group.add(buildOvalRing(params));

    lights.forEach(spot => {
      const meta = spot.userData['meta'] as SpotMeta;

      // ── Sphere marker ─────────────────────────────────────────────────────
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffee88, toneMapped: false }),
      );
      sphere.position.copy(spot.position);
      this.group.add(sphere);

      // ── Fixture-local orthonormal frame ───────────────────────────────────
      // Must match the frame built in field.frag.glsl and computeVisorTan().
      const aimDir = new THREE.Vector3()
        .subVectors(meta.aimTarget, spot.position)
        .normalize();
      const worldUp    = Math.abs(aimDir.y) < 0.999
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
      const rightLocal = new THREE.Vector3().crossVectors(aimDir, worldUp).normalize();
      const upLocal    = new THREE.Vector3().crossVectors(rightLocal, aimDir).normalize();

      // ── Beam cone wireframe ───────────────────────────────────────────────
      if (this.showCones) {
        const coneLen = spot.position.distanceTo(meta.aimTarget);
        const coneGeo = buildConeGeometry(spot.position, aimDir, spot.angle, coneLen, 8);
        this.group.add(new THREE.LineSegments(
          coneGeo,
          new THREE.LineBasicMaterial({
            color: 0x336688, transparent: true, opacity: 0.35, toneMapped: false,
          }),
        ));
      }

      // ── Visor plate ───────────────────────────────────────────────────────
      // Drawn only when the visor actually cuts inside the beam cone, i.e.
      // visorTan < tan(angleH).  computeVisorTan() already returns 1e9 when
      // the far touchline is outside the cone, so this check is the natural
      // gate: if the plate would be outside or at the cone edge, skip it.
      if (meta.visorTan < Math.tan(spot.angle)) {
        const { mesh, outline } = buildVisorGeometry(
          spot.position, aimDir, rightLocal, upLocal,
          meta.visorTan, spot.angle,
        );
        this.group.add(mesh);
        this.group.add(outline);
      }

      // ── CSS2D label ───────────────────────────────────────────────────────
      if (this.showLabels) {
        const label = buildLabel(spot);
        label.position.copy(spot.position).add(new THREE.Vector3(0, 7, 0));
        this.group.add(label);
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visor geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a visor (barn-door) plate geometry that exactly matches the
 * shader's cutoff plane  dyLocal = visorTan * dzLocal.
 *
 * Coordinate derivation:
 *   The plane passes through lightPos and has normal:
 *     n = normalize(upLocal - visorTan * axis)
 *   A direction that lies IN the plane (perpendicular to n and to rightLocal):
 *     plateDir = axis + visorTan * upLocal     (verify: dot(plateDir, n) = 0)
 *
 *   At axial depth D (D meters along axis from the fixture) the visor surface
 *   point is:
 *     lightPos + D * axis + D * visorTan * upLocal
 *   = lightPos + D * plateDir  (after cancelling the scale factor).
 *
 *   The horizontal width of the plate matches the beam width at that depth
 *   (2 * D * tan(angleH)) with a 20% margin so the plate visibly protrudes
 *   beyond the cone edge.
 *
 * Returns a semi-transparent solid mesh and a line-segment outline.
 */
function buildVisorGeometry(
  lightPos:   THREE.Vector3,
  axis:       THREE.Vector3,  // beam axis unit vector
  rightLocal: THREE.Vector3,  // horizontal local direction
  upLocal:    THREE.Vector3,  // vertical local direction (toward stands when > 0)
  visorTan:   number,         // tan(cutoff angle above axis)
  angleH:     number,         // horizontal half-angle [rad]
): { mesh: THREE.Mesh; outline: THREE.LineSegments } {
  // Plate extends DEPTH metres along the beam axis from the fixture aperture.
  const DEPTH = 8.0;
  const halfW = DEPTH * Math.tan(angleH) * 1.25; // 25% wider than beam at DEPTH

  // The "forward-and-up" direction along the visor surface.
  // At t=1 this reaches  lightPos + DEPTH*axis + DEPTH*visorTan*upLocal.
  const plateVec = new THREE.Vector3()
    .copy(axis).multiplyScalar(DEPTH)
    .addScaledVector(upLocal, DEPTH * visorTan);

  // Four corners of the rectangular plate.
  const p0 = lightPos.clone().addScaledVector(rightLocal, -halfW);
  const p1 = lightPos.clone().addScaledVector(rightLocal,  halfW);
  const p2 = p1.clone().add(plateVec);
  const p3 = p0.clone().add(plateVec);

  const pos = new Float32Array([
    p0.x, p0.y, p0.z,
    p1.x, p1.y, p1.z,
    p2.x, p2.y, p2.z,
    p3.x, p3.y, p3.z,
  ]);

  // Solid semi-transparent plate.
  const meshGeo = new THREE.BufferGeometry();
  meshGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  meshGeo.setIndex([0, 1, 2,  0, 2, 3]);
  meshGeo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    meshGeo,
    new THREE.MeshBasicMaterial({
      color:       0x223344,
      transparent: true,
      opacity:     0.40,
      side:        THREE.DoubleSide,
      toneMapped:  false,
      depthWrite:  false,
    }),
  );

  // Crisp outline around the plate perimeter.
  const outlineGeo = new THREE.BufferGeometry();
  outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  outlineGeo.setIndex([0, 1,  1, 2,  2, 3,  3, 0]);  // four edges

  const outline = new THREE.LineSegments(
    outlineGeo,
    new THREE.LineBasicMaterial({ color: 0x5599cc, toneMapped: false }),
  );

  return { mesh, outline };
}

// ─────────────────────────────────────────────────────────────────────────────
// Oval catwalk ring
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Beam cone wireframe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wireframe cone: tip at `tip`, beam axis `dir`, half-angle `alpha`,
 * length `length`, with `nRays` radial lines and a closed base ring.
 */
function buildConeGeometry(
  tip:    THREE.Vector3,
  dir:    THREE.Vector3,
  alpha:  number,
  length: number,
  nRays:  number,
): THREE.BufferGeometry {
  const axis = dir.clone().normalize();
  const ref  = Math.abs(axis.dot(new THREE.Vector3(0, 1, 0))) < 0.99
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(axis, ref).normalize();
  const up    = new THREE.Vector3().crossVectors(right, axis).normalize();

  const r    = length * Math.tan(alpha);
  const base = new THREE.Vector3().copy(tip).addScaledVector(axis, length);
  const verts: number[] = [];

  for (let i = 0; i < nRays; i++) {
    const a    = (i / nRays) * Math.PI * 2;
    const edge = base.clone()
      .addScaledVector(right, r * Math.cos(a))
      .addScaledVector(up,    r * Math.sin(a));
    verts.push(tip.x, tip.y, tip.z, edge.x, edge.y, edge.z);
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// CSS2D label
// ─────────────────────────────────────────────────────────────────────────────

function buildLabel(spot: THREE.SpotLight): CSS2DObject {
  const meta = spot.userData['meta'] as SpotMeta;
  const klm  = (meta.fluxPerGroup / 1_000).toFixed(0);
  const kcd  = (meta.intensityCd  / 1_000).toFixed(0);
  const deg  = Math.round(THREE.MathUtils.radToDeg(spot.angle * 2));

  const div = document.createElement('div');
  div.className = 'light-label';
  div.innerHTML =
    `<b>#${String(meta.index + 1).padStart(2, '0')}</b>` +
    `<br>F=${klm}klm I=${kcd}kcd` +
    `<br>G=${meta.groupSize} th=${deg}`;

  return new CSS2DObject(div);
}
