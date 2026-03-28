/**
 * Sampling leaf inclination for discrete blade placement to match Campbell (1990)
 * ellipsoidal leaf angle distribution (same χ as gap fraction in the BRDF).
 *
 * The azimuth φ is uniform [0, 2π). The zenith angle θ (from vertical, 0 = erect)
 * is sampled with density proportional to sin(θ) × g(θ), where g follows the
 * ellipsoidal LAD (see [Camp90] eq. 11 for G(θ)).
 *
 * Inverse-CDF is not closed form; we use rejection sampling with a bounded number
 * of attempts for deterministic upper cost.
 */

const PI = Math.PI;

/** M(χ) from [Camp90] eq. 5 — same as campbellM in field.frag.glsl */
export function campbellM(chi: number): number {
  return chi + 1.702 * Math.pow(chi + 1.12, -0.708);
}

/** G(θ, χ) from [Camp90] eq. 11 — cosTheta = cos(zenith from vertical upward ray). */
export function campbellG(cosTheta: number, chi: number, M: number): number {
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const chiCos = chi * cosTheta;
  return Math.sqrt(chiCos * chiCos + sinTheta * sinTheta) / M;
}

/**
 * Samples zenith angle θ [rad] of the blade axis from vertical (0 = vertical blade).
 * Mean blade tilt from horizontal is applied separately in the patch (see GrassBRDFPatchView).
 *
 * @param chi - Campbell ellipsoidal LAD parameter (same as chiLAD in BRDF)
 * @param rnd01 - function returning [0, 1), e.g. seeded from instance index
 */
export function sampleZenithFromCampbell(chi: number, rnd01: () => number): number {
  const M = campbellM(chi);
  let attempts = 0;
  const maxAttempts = 48;
  while (attempts < maxAttempts) {
    const u = rnd01();
    const v = rnd01();
    const theta = u * (PI / 2);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const g = campbellG(cosT, chi, M);
    const p = sinT * g;
    const pMax = 2.0;
    if (v * pMax < p) {
      return theta;
    }
    attempts++;
  }
  return Math.acos(Math.max(0, Math.min(1, 0.5 + (rnd01() - 0.5) * 0.4)));
}
