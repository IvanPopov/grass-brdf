import type { GrassBRDFParams } from '../scene/GrassBRDFParams';

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Integrate one step with specular reflection at the pitch rectangle.
 * Clamping positions to the boundary concentrates random-walk mass on the rim;
 * reflection keeps long paths ergodic in the interior.
 */
function stepWithReflect(
  x: number,
  z: number,
  heading: number,
  stride: number,
  halfW: number,
  halfH: number,
): { x: number; z: number; heading: number } {
  let vx = Math.cos(heading) * stride;
  let vz = Math.sin(heading) * stride;
  let nx = x + vx;
  let nz = z + vz;
  for (let iter = 0; iter < 16; iter++) {
    let hit = false;
    if (nx > halfW) {
      nx = 2 * halfW - nx;
      vx = -vx;
      hit = true;
    } else if (nx < -halfW) {
      nx = -2 * halfW - nx;
      vx = -vx;
      hit = true;
    }
    if (nz > halfH) {
      nz = 2 * halfH - nz;
      vz = -vz;
      hit = true;
    } else if (nz < -halfH) {
      nz = -2 * halfH - nz;
      vz = -vz;
      hit = true;
    }
    if (!hit) {
      break;
    }
  }
  return { x: nx, z: nz, heading: Math.atan2(vz, vx) };
}

/**
 * After procedural crush fill, stamps elliptical footprints along random walk/run polylines.
 *
 * Footprint shape: axis-aligned ellipse in a local frame with semi-axis a along travel
 * direction (shoe length) and b across (shoe width); weight t = (1 - ell)^falloff with
 * ell = (lx/a)^2 + (lz/b)^2 in ellipse coordinates (standard oval, not a streak unless a >> b).
 *
 * Mixing with the mowed base: for each channel c in {R,G,B},
 *   out = min(1, base + trampChannel * t).
 * The additive increment is independent of the base until channels saturate at 1; high base
 * reaches 1 with smaller apparent "gain" from the same delta.
 *
 * stampOut: optional single-channel buffer [0,255] per texel, max footprint weight t only (not
 * mow bend). Used for micro-occlusion on cuticle specular so global R does not darken the pitch.
 */
export function applyTramplingOverlay(
  out: Uint8Array,
  stampOut: Uint8Array | null,
  texW: number,
  texH: number,
  p: GrassBRDFParams,
  fieldW: number,
  fieldH: number,
): void {
  if (!p.trampEnabled) {
    return;
  }
  const rnd = mulberry32(Math.floor(p.trampSeed) | 0);
  const halfW = fieldW * 0.5;
  const halfH = fieldH * 0.5;
  const jitter = Math.max(0.05, p.trampHeadingJitterRad);

  for (let pathIdx = 0; pathIdx < p.trampPathCount; pathIdx++) {
    let x = (rnd() - 0.5) * fieldW * 0.92;
    let z = (rnd() - 0.5) * fieldH * 0.92;
    let heading = rnd() * Math.PI * 2;

    for (let s = 0; s < p.trampStepsPerPath; s++) {
      const stride = rnd() < p.trampWalkFraction ? p.trampWalkStrideM : p.trampRunStrideM;
      const stepped = stepWithReflect(x, z, heading, stride, halfW, halfH);
      x = stepped.x;
      z = stepped.z;
      heading = stepped.heading;
      heading += (rnd() - 0.5) * 2.0 * jitter;

      const useSmall = rnd() < p.trampShoeSmallProbability;
      const shoeL = useSmall ? p.trampShoeSmallLengthM : p.trampShoeLargeLengthM;
      const shoeW = useSmall ? p.trampShoeSmallWidthM : p.trampShoeLargeWidthM;
      const a = Math.max(0.04, shoeL * 0.5);
      const b = Math.max(0.02, shoeW * 0.5);

      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);
      const margin = Math.max(a, b) * 1.35;
      const i0 = Math.max(0, Math.floor(((x - margin) / fieldW + 0.5) * texW));
      const i1 = Math.min(texW - 1, Math.ceil(((x + margin) / fieldW + 0.5) * texW));
      const j0 = Math.max(0, Math.floor(((z - margin) / fieldH + 0.5) * texH));
      const j1 = Math.min(texH - 1, Math.ceil(((z + margin) / fieldH + 0.5) * texH));

      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const u = (i + 0.5) / texW;
          const v = (j + 0.5) / texH;
          const wx = (u - 0.5) * fieldW;
          const wz = (v - 0.5) * fieldH;
          const dx = wx - x;
          const dz = wz - z;
          const lx = dx * cosH + dz * sinH;
          const lz = -dx * sinH + dz * cosH;
          const ell = (lx * lx) / (a * a) + (lz * lz) / (b * b);
          if (ell > 1.0) {
            continue;
          }
          const t = Math.pow(1.0 - ell, Math.max(0.35, p.trampFalloffPower));
          const o = (j * texW + i) * 4;
          const r0 = out[o] / 255;
          const g0 = out[o + 1] / 255;
          const b0 = out[o + 2] / 255;
          const r1 = Math.min(1, r0 + p.trampBend * t);
          const g1 = Math.min(1, g0 + p.trampCoherence * t);
          const b1 = Math.min(1, b0 + p.trampSpread * t);
          out[o] = Math.round(r1 * 255);
          out[o + 1] = Math.round(g1 * 255);
          out[o + 2] = Math.round(b1 * 255);
          if (stampOut !== null) {
            const si = j * texW + i;
            const sv = Math.round(Math.min(1.0, t) * 255);
            if (sv > stampOut[si]) {
              stampOut[si] = sv;
            }
          }
        }
      }
    }
  }
}
