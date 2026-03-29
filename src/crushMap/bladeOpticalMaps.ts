import * as THREE from 'three';
import type { GrassBRDFParams } from '../scene/GrassBRDFParams';
import { CRUSH_MAP_TEX_H, CRUSH_MAP_TEX_W } from './crushMap';
import { FIELD_W, FIELD_H } from '../config';

function sampleMarkings(x: number, y: number, lw: number, fieldW: number, fieldH: number): number {
  const absX = Math.abs(x);
  const absY = Math.abs(y);
  
  // Outer bounds (touchlines and goal lines)
  // Pitch outer dimension is exactly fieldW x fieldH. Lines are drawn inside.
  if (absX <= fieldW / 2 && absX >= fieldW / 2 - lw && absY <= fieldH / 2) return 1;
  if (absY <= fieldH / 2 && absY >= fieldH / 2 - lw && absX <= fieldW / 2) return 1;
  
  // Halfway line (centered on X=0)
  if (absX <= lw / 2 && absY <= fieldH / 2) return 1;
  
  // Center mark (solid circle, 0.12m radius)
  const rCenter = Math.sqrt(x * x + y * y);
  if (rCenter <= 0.12) return 1;
  
  // Center circle (radius 9.15m to the outside of the line)
  if (rCenter <= 9.15 && rCenter >= 9.15 - lw) return 1;
  
  // Penalty area
  // Depth: 16.5m from outside of goal line.
  // Width: 16.5m from inside of each goalpost (goalpost distance 7.32m -> half is 3.66m).
  // Half-width = 3.66 + 16.5 = 20.16m.
  const penDepth = 16.5;
  const penWidth = 20.16;
  if (absX >= fieldW / 2 - penDepth && absX <= fieldW / 2 && absY <= penWidth) {
    if (absY >= penWidth - lw) return 1; // Side lines
    if (absX <= fieldW / 2 - penDepth + lw) return 1; // Front line
  }
  
  // Goal area
  // Depth: 5.5m.
  // Width: 5.5m from inside of goalposts. Half-width = 3.66 + 5.5 = 9.16m.
  const goalDepth = 5.5;
  const goalWidth = 9.16;
  if (absX >= fieldW / 2 - goalDepth && absX <= fieldW / 2 && absY <= goalWidth) {
    if (absY >= goalWidth - lw) return 1; // Side lines
    if (absX <= fieldW / 2 - goalDepth + lw) return 1; // Front line
  }
  
  // Penalty mark (11m from the outside of the goal line)
  const penMarkRadius = 0.12;
  const dxPenMark = absX - (fieldW / 2 - 11.0);
  if (Math.sqrt(dxPenMark * dxPenMark + absY * absY) <= penMarkRadius) return 1;
  
  // Penalty arc (9.15m radius from penalty mark, drawn only outside penalty area)
  if (absX < fieldW / 2 - penDepth) {
    const rArc = Math.sqrt(dxPenMark * dxPenMark + absY * absY);
    if (rArc <= 9.15 && rArc >= 9.15 - lw) return 1;
  }
  
  // Corner arcs (1m radius from the very corners, drawn inside the pitch)
  const dxCorner = absX - fieldW / 2;
  const dyCorner = absY - fieldH / 2;
  const rCorner = Math.sqrt(dxCorner * dxCorner + dyCorner * dyCorner);
  if (rCorner <= 1.0 && rCorner >= 1.0 - lw) return 1;
  
  return 0;
}

export function applyFieldMarkings(
  outAlb: Uint8Array,
  outTau: Uint8Array,
  texW: number,
  texH: number,
  p: GrassBRDFParams,
  fieldW: number,
  fieldH: number,
): void {
  if (!p.markingsEnabled) return;

  const aR = Math.round(Math.min(1, Math.max(0, p.markingsAlbedoR)) * 255);
  const aG = Math.round(Math.min(1, Math.max(0, p.markingsAlbedoG)) * 255);
  const aB = Math.round(Math.min(1, Math.max(0, p.markingsAlbedoB)) * 255);

  const tR = Math.round(Math.min(1, Math.max(0, p.markingsTransmittanceR)) * 255);
  const tG = Math.round(Math.min(1, Math.max(0, p.markingsTransmittanceG)) * 255);
  const tB = Math.round(Math.min(1, Math.max(0, p.markingsTransmittanceB)) * 255);

  const lw = p.markingsLineWidth;
  const dx = fieldW / Math.max(1, texW - 1);
  const dy = fieldH / Math.max(1, texH - 1);

  const subSteps = 3;
  const invSubSteps = 1 / subSteps;
  const invTotal = 1 / (subSteps * subSteps);

  for (let j = 0; j < texH; j++) {
    const vBase = j / Math.max(1, texH - 1);
    const yBase = (vBase - 0.5) * fieldH;

    for (let i = 0; i < texW; i++) {
      const uBase = i / Math.max(1, texW - 1);
      const xBase = (uBase - 0.5) * fieldW;

      let hits = 0;
      for (let sy = 0; sy < subSteps; sy++) {
        for (let sx = 0; sx < subSteps; sx++) {
          const x = xBase + (sx * invSubSteps - 0.5 + invSubSteps / 2) * dx;
          const y = yBase + (sy * invSubSteps - 0.5 + invSubSteps / 2) * dy;
          hits += sampleMarkings(x, y, lw, fieldW, fieldH);
        }
      }

      if (hits > 0) {
        const w = hits * invTotal;
        const invW = 1.0 - w;
        const o = (j * texW + i) * 4;

        outAlb[o]     = Math.round(outAlb[o]     * invW + aR * w);
        outAlb[o + 1] = Math.round(outAlb[o + 1] * invW + aG * w);
        outAlb[o + 2] = Math.round(outAlb[o + 2] * invW + aB * w);

        outTau[o]     = Math.round(outTau[o]     * invW + tR * w);
        outTau[o + 1] = Math.round(outTau[o + 1] * invW + tG * w);
        outTau[o + 2] = Math.round(outTau[o + 2] * invW + tB * w);
      }
    }
  }
}

/**
 * Fills RGBA8 (RGB linear albedo, A=255) per texel from grass params.
 * Spatially uniform unless extended later; matches former per-frame uniforms.
 */
export function fillBladeAlbedoMapData(
  out: Uint8Array,
  texW: number,
  texH: number,
  p: GrassBRDFParams,
): void {
  for (let j = 0; j < texH; j++) {
    for (let i = 0; i < texW; i++) {
      const o = (j * texW + i) * 4;
      out[o]     = Math.round(Math.min(1, Math.max(0, p.bladeAlbedoR)) * 255);
      out[o + 1] = Math.round(Math.min(1, Math.max(0, p.bladeAlbedoG)) * 255);
      out[o + 2] = Math.round(Math.min(1, Math.max(0, p.bladeAlbedoB)) * 255);
      out[o + 3] = 255;
    }
  }
}

export function fillBladeTauMapData(
  out: Uint8Array,
  texW: number,
  texH: number,
  p: GrassBRDFParams,
): void {
  for (let j = 0; j < texH; j++) {
    for (let i = 0; i < texW; i++) {
      const o = (j * texW + i) * 4;
      out[o]     = Math.round(Math.min(1, Math.max(0, p.bladeTransmittanceR)) * 255);
      out[o + 1] = Math.round(Math.min(1, Math.max(0, p.bladeTransmittanceG)) * 255);
      out[o + 2] = Math.round(Math.min(1, Math.max(0, p.bladeTransmittanceB)) * 255);
      out[o + 3] = 255;
    }
  }
}

export function createBladeAlbedoMapTexture(): THREE.DataTexture {
  const data = new Uint8Array(CRUSH_MAP_TEX_W * CRUSH_MAP_TEX_H * 4);
  const tex = new THREE.DataTexture(
    data,
    CRUSH_MAP_TEX_W,
    CRUSH_MAP_TEX_H,
    THREE.RGBAFormat,
  );
  tex.generateMipmaps = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

export function createBladeTauMapTexture(): THREE.DataTexture {
  return createBladeAlbedoMapTexture();
}

export function updateBladeOpticalDataTextures(
  albedoTex: THREE.DataTexture,
  tauTex: THREE.DataTexture,
  p: GrassBRDFParams,
): void {
  const ad = albedoTex.image.data as Uint8Array;
  const td = tauTex.image.data as Uint8Array;
  fillBladeAlbedoMapData(ad, CRUSH_MAP_TEX_W, CRUSH_MAP_TEX_H, p);
  fillBladeTauMapData(td, CRUSH_MAP_TEX_W, CRUSH_MAP_TEX_H, p);
  
  applyFieldMarkings(ad, td, CRUSH_MAP_TEX_W, CRUSH_MAP_TEX_H, p, FIELD_W, FIELD_H);

  albedoTex.needsUpdate = true;
  tauTex.needsUpdate = true;
}
