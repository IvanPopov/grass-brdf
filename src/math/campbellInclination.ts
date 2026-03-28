/**
 * Campbell (1990) ellipsoidal leaf angle distribution: shared M(χ), G_beam(θ,χ) for
 * extinction, and correct sampling of leaf-normal zenith for the patch preview.
 *
 * IMPORTANT DISTINCTION (see [Camp90] eq. 11):
 *   G(θ) uses θ = zenith angle of the VIEW / ILLUMINATION ray through the canopy.
 *   It is the mean projected leaf area for that beam direction — not a PDF of leaf
 *   inclination. Using sin(θ)×G(θ) as if θ were a leaf-normal angle is incorrect.
 *
 * For the ellipsoidal distribution, the (un-normalised) PDF of the zenith angle θ
 * of the LEAF NORMAL measured from vertical (0 = normal up, pi/2 = horizontal) is
 * derived from the area element on the oblate/prolate spheroid with horizontal
 * semiaxis chi and vertical semiaxis 1:
 *
 *     p_unnorm(theta) = sin(theta) / ( cos(theta)^2 + (chi*sin(theta))^2 )^(3/2)
 *
 * chi direction (consistent with G_beam and [Camp90]):
 *   chi > 1  — planophile: leaves mostly horizontal, normals near θ=0  (clover, lotus)
 *   chi = 1  — spherical:  reduces to sin(theta), uniform over hemisphere
 *   chi < 1  — erectophile: leaves mostly vertical, normals near θ=pi/2 (grass, cereal)
 *
 * References:
 *   [Camp90] Campbell G.S. (1990) Agric. For. Meteorol. 49, 173–176.
 *   Companion: "Derivation of an angle density function for canopies with
 *   ellipsoidal leaf angle distributions" (same journal / issue).
 */

const PI = Math.PI;
const HALF_PI = PI * 0.5;

/** Simpson rule (n must be even). */
function simpsonIntegral(f: (x: number) => number, a: number, b: number, n: number): number {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) {
    const x = a + i * h;
    s += f(x) * (i % 2 === 0 ? 2 : 4);
  }
  return (s * h) / 3;
}

/** M(χ) from [Camp90] eq. 5 — same as campbellM in field.frag.glsl */
export function campbellM(chi: number): number {
  return chi + 1.702 * Math.pow(chi + 1.12, -0.708);
}

/**
 * G(θ, χ) from [Camp90] eq. 11 — mean projection of leaf area for a BEAM at zenith θ.
 * cosTheta = cos(zenith of ray from vertical upward).
 */
export function campbellG(cosTheta: number, chi: number, M: number): number {
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const chiCos = chi * cosTheta;
  return Math.sqrt(chiCos * chiCos + sinTheta * sinTheta) / M;
}

/**
 * Un-normalised PDF of leaf-normal zenith θ from vertical [0, pi/2] for ellipsoidal LAD.
 * Not the same function as G_beam in the shader.
 *
 * chi > 1 → planophile: peak near θ=0 (normals up, leaves horizontal).
 * chi = 1 → spherical: p = sin(theta).
 * chi < 1 → erectophile: peak near θ=pi/2 (normals sideways, leaves vertical).
 */
export function leafNormalZenithUnnorm(theta: number, chi: number): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const chiS = chi * s;
  const d = c * c + chiS * chiS;
  return s / Math.pow(Math.max(d, 1e-18), 1.5);
}

function integrateLeafNormalZenithNorm(chi: number): number {
  return simpsonIntegral((t) => leafNormalZenithUnnorm(t, chi), 0, HALF_PI, 512);
}

function integrateLeafNormalZenithMeanTimesNorm(chi: number): number {
  return simpsonIntegral((t) => t * leafNormalZenithUnnorm(t, chi), 0, HALF_PI, 512);
}

function maxLeafNormalZenithUnnorm(chi: number): number {
  let m = 0;
  for (let i = 0; i <= 512; i++) {
    const t = (i / 512) * HALF_PI;
    m = Math.max(m, leafNormalZenithUnnorm(t, chi));
  }
  return m;
}

/**
 * Mean zenith angle [rad] of leaf normals (Campbell ellipsoidal), for meadow specular
 * in field.frag.glsl and FieldMaterial. Deterministic quadrature (no Monte Carlo).
 */
export function estimateMeanZenithRad(chi: number): number {
  const Z = integrateLeafNormalZenithNorm(chi);
  if (Z < 1e-18) {
    return HALF_PI * 0.5;
  }
  return integrateLeafNormalZenithMeanTimesNorm(chi) / Z;
}

/**
 * Samples zenith angle θ [rad] of the LEAF FACE NORMAL from vertical (0 = normal up).
 * Isotropic azimuth is applied separately in GrassBRDFPatchView / field.frag meadow mode.
 *
 * @param chi - Campbell ellipsoidal LAD parameter (same as chiLAD in BRDF)
 * @param rnd01 - function returning [0, 1), e.g. seeded from instance index
 */
export function sampleZenithFromCampbell(chi: number, rnd01: () => number): number {
  const pMax = maxLeafNormalZenithUnnorm(chi);
  let attempts = 0;
  const maxAttempts = 96;
  while (attempts < maxAttempts) {
    const theta = rnd01() * HALF_PI;
    const u = rnd01() * pMax;
    if (u < leafNormalZenithUnnorm(theta, chi)) {
      return theta;
    }
    attempts++;
  }
  return estimateMeanZenithRad(chi);
}
