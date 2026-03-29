import * as THREE from 'three';
import type { GrassBRDFParams } from '../scene/GrassBRDFParams';
import { FIELD_H, FIELD_W } from '../config';

/** Use a lower resolution for wear map since it's low frequency, e.g. 1024x512 */
export const WEAR_MAP_TEX_W = 1024;
export const WEAR_MAP_TEX_H = Math.max(512, Math.round((WEAR_MAP_TEX_W * FIELD_H) / FIELD_W));

export function createWearMapDataTexture(): THREE.DataTexture {
  const data = new Uint8Array(WEAR_MAP_TEX_W * WEAR_MAP_TEX_H);
  const tex = new THREE.DataTexture(
    data,
    WEAR_MAP_TEX_W,
    WEAR_MAP_TEX_H,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  tex.generateMipmaps = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

function xorshift32(state: { seed: number }): number {
  let x = state.seed;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.seed = x;
  return (x >>> 0) / 4294967296.0;
}

export function fillWearMap(
  out: Uint8Array,
  texW: number,
  texH: number,
  p: GrassBRDFParams,
  fieldW: number,
  fieldH: number,
): void {
  const cStrength = p.wearCenterStrength;
  const gStrength = p.wearGoalStrength;

  const f32 = new Float32Array(texW * texH);

  // Seed with trampSeed if it exists, otherwise a fixed number
  const prng = { seed: (p.trampSeed || 123456789) >>> 0 };
  if (prng.seed === 0) prng.seed = 1; // xorshift32 cannot start with 0

  function drawStamp(cx: number, cz: number, radiusX: number, radiusZ: number, strength: number) {
    const minX = Math.floor((cx - radiusX) / fieldW * texW + texW / 2);
    const maxX = Math.ceil((cx + radiusX) / fieldW * texW + texW / 2);
    const minZ = Math.floor((cz - radiusZ) / fieldH * texH + texH / 2);
    const maxZ = Math.ceil((cz + radiusZ) / fieldH * texH + texH / 2);

    const i0 = Math.max(0, minX);
    const i1 = Math.min(texW - 1, maxX);
    const j0 = Math.max(0, minZ);
    const j1 = Math.min(texH - 1, maxZ);

    for (let j = j0; j <= j1; j++) {
      const z = (j / texH - 0.5) * fieldH;
      const dz = (z - cz) / radiusZ;
      const dz2 = dz * dz;

      for (let i = i0; i <= i1; i++) {
        const x = (i / texW - 0.5) * fieldW;
        const dx = (x - cx) / radiusX;
        const d2 = dx * dx + dz2;

        if (d2 < 1.0) {
          // Soft brush falloff
          const falloff = 1.0 - Math.sqrt(d2);
          const w = falloff * falloff * (3.0 - 2.0 * falloff) * strength;
          f32[j * texW + i] += w;
        }
      }
    }
  }

  // Draw Goal Area 1 (X = fieldW / 2)
  if (gStrength > 0) {
    const goalX = fieldW / 2 - 1.0; // slightly inside pitch from goal line
    const numStamps = Math.floor(400 * gStrength);
    for (let i = 0; i < numStamps; i++) {
      // Gaussian distribution around the goal area
      const u1 = xorshift32(prng);
      const u2 = xorshift32(prng);
      const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-6));
      const theta = 2.0 * Math.PI * u2;
      
      const dx = r * Math.cos(theta) * 8.0; // spread along pitch length (further out)
      const dz = r * Math.sin(theta) * 8.0; // spread along goal width

      const sx = goalX - Math.abs(dx); // Force wear to go INTO the pitch, not out of bounds
      const sz = dz;

      // Keep rough bounds, extending further past the penalty box (25m)
      if (Math.abs(sz) > 22.0 || sx < fieldW / 2 - 25.0) continue;

      const sizeX = 0.8 + xorshift32(prng) * 1.8;
      const sizeZ = 0.8 + xorshift32(prng) * 1.8;
      const st = (0.06 + xorshift32(prng) * 0.15) * gStrength;

      drawStamp(sx, sz, sizeX, sizeZ, st);
    }
  }

  // Draw Goal Area 2 (X = -fieldW / 2)
  if (gStrength > 0) {
    const goalX = -fieldW / 2 + 1.0;
    const numStamps = Math.floor(400 * gStrength);
    for (let i = 0; i < numStamps; i++) {
      const u1 = xorshift32(prng);
      const u2 = xorshift32(prng);
      const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-6));
      const theta = 2.0 * Math.PI * u2;
      
      const dx = r * Math.cos(theta) * 8.0;
      const dz = r * Math.sin(theta) * 8.0;

      const sx = goalX + Math.abs(dx); // Force wear INTO the pitch
      const sz = dz;

      if (Math.abs(sz) > 22.0 || sx > -fieldW / 2 + 25.0) continue;

      const sizeX = 0.8 + xorshift32(prng) * 1.8;
      const sizeZ = 0.8 + xorshift32(prng) * 1.8;
      const st = (0.06 + xorshift32(prng) * 0.15) * gStrength;

      drawStamp(sx, sz, sizeX, sizeZ, st);
    }
  }

  // Draw Center Circle Area
  if (cStrength > 0) {
    const numStamps = Math.floor(180 * cStrength);
    for (let i = 0; i < numStamps; i++) {
      const u1 = xorshift32(prng);
      const u2 = xorshift32(prng);
      const r = Math.sqrt(-2.0 * Math.log(u1 + 1e-6)) * 3.5;
      const theta = 2.0 * Math.PI * u2;

      const sx = r * Math.cos(theta);
      const sz = r * Math.sin(theta);

      if (Math.abs(sx) > 10.0 || Math.abs(sz) > 10.0) continue;

      const sizeX = 0.8 + xorshift32(prng) * 2.0;
      const sizeZ = 0.8 + xorshift32(prng) * 2.0;
      const st = (0.05 + xorshift32(prng) * 0.15) * cStrength;

      drawStamp(sx, sz, sizeX, sizeZ, st);
    }
  }

  // Final clamp and encode
  for (let i = 0; i < f32.length; i++) {
    out[i] = Math.round(Math.min(1.0, f32[i]) * 255);
  }
}
