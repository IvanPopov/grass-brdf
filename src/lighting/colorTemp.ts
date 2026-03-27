import * as THREE from 'three';

/**
 * Converts a correlated color temperature (CCT) to a linear-light RGB THREE.Color.
 *
 * Uses Tanner Helland's empirical polynomial fit to the CIE Planckian locus.
 * Valid range: 1 000 K – 40 000 K.
 *
 * The output is in LINEAR light (not gamma-corrected sRGB). Three.js SpotLight
 * color expects linear-light values, which is correct here.
 *
 * Reference: https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html
 *
 * @param kelvin  CCT in Kelvin [K]
 * @returns       THREE.Color with linear-light RGB components in [0, 1]
 */
export function cctToColor(kelvin: number): THREE.Color {
  const t = Math.max(1_000, Math.min(40_000, kelvin)) / 100;

  let r: number, g: number, b: number;

  if (t <= 66) {
    r = 1.0;
    g = (99.4708025861 * Math.log(t) - 161.1195681661) / 255;
    b = t <= 19 ? 0.0 : (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255;
  } else {
    r = (329.698727446  * Math.pow(t - 60, -0.1332047592)) / 255;
    g = (288.1221695283 * Math.pow(t - 60, -0.0755148492)) / 255;
    b = 1.0;
  }

  return new THREE.Color(
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
  );
}
