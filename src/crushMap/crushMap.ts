import * as THREE from 'three';
import type { GrassBRDFParams } from '../scene/GrassBRDFParams';
import { FIELD_H, FIELD_W } from '../config';
import { applyTramplingOverlay } from './tramplingStamp';

/** RGBA crush map: R = blend toward mowed, G = specular coherence, B = spread, A = (leanSign+1)/2 */
export interface CrushMapSample {
  /** Blend weight meadow -> mowed tilt [0, 1] */
  w: number;
  /** Anisotropic specular coherence [0, 1] */
  coherence: number;
  /** Extra orientation variance (Toksvig) [0, 1] */
  spread: number;
  /** Stripe lean along world +Z: -1 or +1 */
  leanSign: number;
}

/**
 * Procedural crush map (same math as crushMapGen.frag.glsl). World origin at field centre;
 * X along pitch length, Z across width.
 */
export function sampleCrushMap(worldX: number, worldZ: number, p: GrassBRDFParams): CrushMapSample {
  if (!p.mowArtMowingEnabled) {
    const w = THREE.MathUtils.clamp(p.mowBend, 0, 1);
    return {
      w,
      coherence: THREE.MathUtils.clamp(p.mowCoherence, 0, 1),
      spread: THREE.MathUtils.clamp(p.mowSpread, 0, 1),
      leanSign: 1,
    };
  }

  // High frequency but low amplitude noise, creating a softer, blurred organic boundary
  const edgeNoise = (Math.sin(worldZ * 18.3 + worldX * 3.0) * 0.5 + 
                     Math.sin(worldZ * 29.1 - worldX * 2.0) * 0.3 + 
                     Math.sin(worldZ * 9.7) * 0.7) * 0.08;
  const noisyX = worldX + edgeNoise;

  const sw = Math.max(0.01, p.mowArtStripeWidthM);
  const stripeIdx = Math.floor(noisyX / sw);
  const alt = stripeIdx % 2 === 0 ? -1 : 1;
  const leanSign = p.mowArtStripesEnabled ? alt : 1;
  const stripePhase = p.mowArtStripesEnabled ? (stripeIdx % 2 === 0 ? 0 : 1) : 0;
  const rMod = p.mowArtStripesEnabled
    ? THREE.MathUtils.lerp(1.0 - 0.08 * p.mowArtStripeBendVariation, 1.0, stripePhase)
    : 1.0;
  
  // Calculate distance to the stripe boundary to add wheel/overlap crush
  let localX = noisyX % sw;
  if (localX < 0) localX += sw;
  const distToEdge = Math.min(localX, sw - localX);
  
  // Smooth wheel track / overlap line on both sides of the stripe (left and right edges)
  const edgeCrushRaw = Math.max(0, 1.0 - distToEdge / 0.4);
  const edgeCrush = edgeCrushRaw * edgeCrushRaw * (3.0 - 2.0 * edgeCrushRaw) * 0.06;

  const w = THREE.MathUtils.clamp(p.mowBend * rMod + edgeCrush, 0, 1);
  return {
    w,
    coherence: THREE.MathUtils.clamp(p.mowCoherence, 0, 1),
    spread:    THREE.MathUtils.clamp(p.mowSpread, 0, 1),
    leanSign,
  };
}

/** Long axis (field length X) at least 2048 texels; height matches pitch aspect ratio. */
export const CRUSH_MAP_TEX_W = 2048;
export const CRUSH_MAP_TEX_H = Math.max(1024, Math.round((CRUSH_MAP_TEX_W * FIELD_H) / FIELD_W));

/**
 * Fills RGBA8 data for a DataTexture covering the field in world XZ (centred mesh).
 */
export function fillCrushMapRGBA(
  out: Uint8Array,
  texW: number,
  texH: number,
  p: GrassBRDFParams,
  fieldW: number,
  fieldH: number,
): void {
  for (let j = 0; j < texH; j++) {
    for (let i = 0; i < texW; i++) {
      const u = (i + 0.5) / texW;
      const v = (j + 0.5) / texH;
      const worldX = (u - 0.5) * fieldW;
      const worldZ = (v - 0.5) * fieldH;
      const s = sampleCrushMap(worldX, worldZ, p);
      const o = (j * texW + i) * 4;
      out[o]     = Math.round(s.w * 255);
      out[o + 1] = Math.round(s.coherence * 255);
      out[o + 2] = Math.round(s.spread * 255);
      out[o + 3] = Math.round((s.leanSign * 0.5 + 0.5) * 255);
    }
  }
}

export function createCrushMapDataTexture(): THREE.DataTexture {
  const data = new Uint8Array(CRUSH_MAP_TEX_W * CRUSH_MAP_TEX_H * 4);
  const tex = new THREE.DataTexture(
    data,
    CRUSH_MAP_TEX_W,
    CRUSH_MAP_TEX_H,
    THREE.RGBAFormat,
  );
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

/** R8 footprint weight only (CPU trampling). Black where no stamp; not used when GPU crush map is on. */
export function createTrampStampDataTexture(): THREE.DataTexture {
  const data = new Uint8Array(CRUSH_MAP_TEX_W * CRUSH_MAP_TEX_H);
  const tex = new THREE.DataTexture(
    data,
    CRUSH_MAP_TEX_W,
    CRUSH_MAP_TEX_H,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

export function updateCrushMapDataTexture(
  tex: THREE.DataTexture,
  stampTex: THREE.DataTexture,
  p: GrassBRDFParams,
): void {
  const data = tex.image.data as Uint8Array;
  const stampData = stampTex.image.data as Uint8Array;
  fillCrushMapRGBA(data, CRUSH_MAP_TEX_W, CRUSH_MAP_TEX_H, p, FIELD_W, FIELD_H);
  stampData.fill(0);
  applyTramplingOverlay(data, stampData, CRUSH_MAP_TEX_W, CRUSH_MAP_TEX_H, p, FIELD_W, FIELD_H);
  tex.needsUpdate = true;
  stampTex.needsUpdate = true;
}
