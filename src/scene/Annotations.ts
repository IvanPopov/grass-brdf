import * as THREE from 'three';
import { FIELD_W, FIELD_H } from '../config';
import {
  SAFETY_GAP, FIRST_ROW_H, ROW_RISE, NUM_ROWS, STAND_W,
} from './Stands';

// ─────────────────────────────────────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────────────────────────────────────

const DIM_COLOR   = 0x00d4ff;
const DIM_ORDER   = 2;        // render after grid (order 1) to avoid overlap
const DIM_Y       = 0.15;     // [m] height above field surface
const HALF_W      = FIELD_W / 2;
const HALF_H      = FIELD_H / 2;
const SIDE_OFFSET = 7;        // [m] gap between field edge and dimension line
const CONE_H      = 1.8;      // [m] arrowhead cone height

// ─────────────────────────────────────────────────────────────────────────────
// Primitive helpers
// ─────────────────────────────────────────────────────────────────────────────

function lineMat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: DIM_COLOR, depthTest: false, transparent: true, toneMapped: false });
}

function meshMat(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: DIM_COLOR, depthTest: false, transparent: true, toneMapped: false });
}

function addLine(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  const obj = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat());
  obj.renderOrder = DIM_ORDER;
  parent.add(obj);
}

/**
 * Places an arrowhead so that its TIP is at `tip` pointing in direction `dir`.
 *
 * ConeGeometry default: tip at (0, +H/2, 0) along +Y axis.
 * After setFromUnitVectors(+Y, dir), the tip lands at center + dir × (H/2).
 * To move tip to the desired position:
 *   center = tip − dir_norm × (CONE_H / 2)
 */
function addArrow(parent: THREE.Object3D, tip: THREE.Vector3, dir: THREE.Vector3): void {
  const d    = dir.clone().normalize();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, CONE_H, 8), meshMat());
  cone.position.copy(tip).addScaledVector(d, -(CONE_H / 2));
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  cone.renderOrder = DIM_ORDER;
  parent.add(cone);
}

function addLabel(
  parent:   THREE.Object3D,
  text:     string,
  pos:      THREE.Vector3,
  scale:    [number, number] = [12, 3],
): void {
  const canvas = document.createElement('canvas');
  canvas.width  = 320;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle    = '#00d4ff';
  ctx.font         = 'bold 44px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 160, 40);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, toneMapped: false }),
  );
  sprite.position.copy(pos);
  sprite.scale.set(scale[0], scale[1], 1);
  sprite.renderOrder = DIM_ORDER;
  parent.add(sprite);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the static field dimension annotations (does not change at runtime).
 *
 *   Length 105 m: horizontal dimension line offset −Z from the field.
 *   Width  68 m:  horizontal dimension line offset −X from the field.
 *
 *   Extension (witness) lines connect field corners to the dimension line.
 *   Arrowheads point INWARD (toward each other), tips flush with the
 *   extension lines (cone center offset by CONE_H/2 away from tip).
 */
export function createFieldAnnotations(scene: THREE.Scene): void {
  const g = new THREE.Group();

  // Length: 105 m along X, below the field (−Z side)
  const lenZ = -HALF_H - SIDE_OFFSET;
  addLine(g, new THREE.Vector3(-HALF_W, DIM_Y, -HALF_H), new THREE.Vector3(-HALF_W, DIM_Y, lenZ - 1));
  addLine(g, new THREE.Vector3( HALF_W, DIM_Y, -HALF_H), new THREE.Vector3( HALF_W, DIM_Y, lenZ - 1));
  addLine(g, new THREE.Vector3(-HALF_W, DIM_Y, lenZ),    new THREE.Vector3( HALF_W, DIM_Y, lenZ));
  addArrow(g, new THREE.Vector3(-HALF_W, DIM_Y, lenZ), new THREE.Vector3( 1, 0, 0));
  addArrow(g, new THREE.Vector3( HALF_W, DIM_Y, lenZ), new THREE.Vector3(-1, 0, 0));
  addLabel(g, '105 m', new THREE.Vector3(0, DIM_Y, lenZ - 3.5));

  // Width: 68 m along Z, left of the field (−X side)
  const widX = -HALF_W - SIDE_OFFSET;
  addLine(g, new THREE.Vector3(-HALF_W, DIM_Y, -HALF_H), new THREE.Vector3(widX - 1, DIM_Y, -HALF_H));
  addLine(g, new THREE.Vector3(-HALF_W, DIM_Y,  HALF_H), new THREE.Vector3(widX - 1, DIM_Y,  HALF_H));
  addLine(g, new THREE.Vector3(widX, DIM_Y, -HALF_H),    new THREE.Vector3(widX, DIM_Y,  HALF_H));
  addArrow(g, new THREE.Vector3(widX, DIM_Y, -HALF_H), new THREE.Vector3(0, 0,  1));
  addArrow(g, new THREE.Vector3(widX, DIM_Y,  HALF_H), new THREE.Vector3(0, 0, -1));
  addLabel(g, '68 m', new THREE.Vector3(widX - 4.5, DIM_Y, 0));

  scene.add(g);
}

/**
 * HeightAnnotation shows the rig mounting height as a vertical dimension line.
 *
 *   Position: right side of the oval, at x = ovalHalfLength + 8 m, z = 0.
 *   The annotation is rebuilt whenever rigHeight or ovalHalfLength changes.
 *
 *   Tick marks span ±4 m horizontally at bottom (y=0) and top (y=H).
 *   Arrowhead tips are flush with the tick marks.
 *   Label: "H = N m" centred on the dimension line.
 */
export class HeightAnnotation {
  private group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  build(rigHeight: number, xPos: number): void {
    this.group.clear();

    const x       = xPos;
    const bottom  = new THREE.Vector3(x, 0,         0);
    const top     = new THREE.Vector3(x, rigHeight, 0);
    const tickLen = 4; // [m] half-length of horizontal tick marks

    // Vertical dimension line
    addLine(this.group, bottom, top);

    // Horizontal tick marks at y = 0 and y = rigHeight
    addLine(this.group,
      new THREE.Vector3(x - tickLen, 0,         0),
      new THREE.Vector3(x + tickLen, 0,         0));
    addLine(this.group,
      new THREE.Vector3(x - tickLen, rigHeight, 0),
      new THREE.Vector3(x + tickLen, rigHeight, 0));

    // Arrowheads: tip at bottom pointing UP, tip at top pointing DOWN
    addArrow(this.group, bottom, new THREE.Vector3(0,  1, 0));
    addArrow(this.group, top,    new THREE.Vector3(0, -1, 0));

    // Label centred on the line, offset right for readability
    addLabel(
      this.group,
      `H = ${rigHeight} m`,
      new THREE.Vector3(x + 7, rigHeight / 2, 0),
      [14, 3.5],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stand dimension annotations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates three blue dimension arrows describing the north stand geometry:
 *
 *   1. Safety gap (5 m): horizontal Z-arrow at field level, between the
 *      north touchline and the first row front barrier.
 *
 *   2. Stand height (~12 m): vertical Y-arrow at the stand front edge,
 *      from pitch level (Y=0) to the top row floor.
 *      Reference: Allianz Arena lower tier ~12 m, Emirates ~14 m.
 *
 *   3. Stand width (115 m): horizontal X-arrow above the top row,
 *      spanning the full structural width of the stand.
 *
 * All annotations are placed on the east side (positive X) at
 * X = STAND_W/2 + SIDE_OFFSET to keep them clear of other geometry.
 *
 * Verified against UEFA Category 4 / FIFA Class V design guidelines:
 *   Safety gap: FIFA min 3 m, elite stadia 5-8 m.  Our value: 5 m ✓
 *   Stand height: lower tier 10-16 m.                Our value: 11.9 m ✓
 *   Stand width: follows pitch length + overhang.     Our value: 115 m ✓
 */
export function createStandAnnotations(scene: THREE.Scene): void {
  const g = new THREE.Group();

  // Derived stand geometry.
  const standFrontZ  = FIELD_H / 2 + SAFETY_GAP;                // Z of first row front edge
  const standTopY    = FIRST_ROW_H + NUM_ROWS * ROW_RISE;        // Y of last row top surface
  const standMidY    = standTopY / 2;
  const eastX        = STAND_W / 2 + SIDE_OFFSET + 2;            // X of annotation lines
  const tickLen      = 3;                                         // [m] tick mark half-length

  // ── 1. Safety gap (Z direction, at field level) ──────────────────────────
  const gapY  = DIM_Y;
  const gapZ0 = FIELD_H / 2;     // north touchline
  const gapZ1 = standFrontZ;     // stand front

  // Witness lines from touchline and stand front up to the annotation X.
  addLine(g, new THREE.Vector3(STAND_W / 2, gapY, gapZ0), new THREE.Vector3(eastX + 1, gapY, gapZ0));
  addLine(g, new THREE.Vector3(STAND_W / 2, gapY, gapZ1), new THREE.Vector3(eastX + 1, gapY, gapZ1));
  // Dimension line along Z.
  addLine(g, new THREE.Vector3(eastX, gapY, gapZ0), new THREE.Vector3(eastX, gapY, gapZ1));
  // Inward arrows.
  addArrow(g, new THREE.Vector3(eastX, gapY, gapZ0), new THREE.Vector3(0, 0,  1));
  addArrow(g, new THREE.Vector3(eastX, gapY, gapZ1), new THREE.Vector3(0, 0, -1));
  // Label centred between the arrows.
  addLabel(g, `${SAFETY_GAP} m`, new THREE.Vector3(eastX + 6, gapY, (gapZ0 + gapZ1) / 2), [10, 2.5]);

  // ── 2. Stand height (Y direction, at stand front edge) ───────────────────
  const htZ = standFrontZ;

  // Witness ticks at Y=0 (pitch) and Y=standTopY (top row) along X.
  addLine(g, new THREE.Vector3(eastX - tickLen, 0,         htZ), new THREE.Vector3(eastX + tickLen, 0,         htZ));
  addLine(g, new THREE.Vector3(eastX - tickLen, standTopY, htZ), new THREE.Vector3(eastX + tickLen, standTopY, htZ));
  // Dimension line along Y.
  addLine(g, new THREE.Vector3(eastX, 0, htZ), new THREE.Vector3(eastX, standTopY, htZ));
  // Inward arrows.
  addArrow(g, new THREE.Vector3(eastX, 0,         htZ), new THREE.Vector3(0,  1, 0));
  addArrow(g, new THREE.Vector3(eastX, standTopY, htZ), new THREE.Vector3(0, -1, 0));
  // Label.
  addLabel(
    g,
    `${standTopY.toFixed(1)} m`,
    new THREE.Vector3(eastX + 7, standMidY, htZ),
    [12, 3],
  );

  // ── 3. Stand width (X direction, above top row) ───────────────────────────
  const wY   = standTopY + 3;          // a few metres above the top row
  const wZ   = standFrontZ + 3;        // slightly behind the front edge for readability
  const wX0  = -STAND_W / 2;
  const wX1  =  STAND_W / 2;

  // Witness lines dropping from stand corners down to annotation height.
  addLine(g, new THREE.Vector3(wX0, standTopY, wZ), new THREE.Vector3(wX0, wY + 1, wZ));
  addLine(g, new THREE.Vector3(wX1, standTopY, wZ), new THREE.Vector3(wX1, wY + 1, wZ));
  // Dimension line along X.
  addLine(g, new THREE.Vector3(wX0, wY, wZ), new THREE.Vector3(wX1, wY, wZ));
  // Inward arrows.
  addArrow(g, new THREE.Vector3(wX0, wY, wZ), new THREE.Vector3( 1, 0, 0));
  addArrow(g, new THREE.Vector3(wX1, wY, wZ), new THREE.Vector3(-1, 0, 0));
  // Label.
  addLabel(g, `${STAND_W} m`, new THREE.Vector3(0, wY + 2, wZ), [12, 3]);

  scene.add(g);
}
