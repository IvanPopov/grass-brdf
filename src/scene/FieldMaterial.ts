import * as THREE from 'three';
import { MAX_SHADER_LIGHTS } from '../config';
import fieldVertGlsl from '../shaders/field.vert.glsl';
import fieldFragGlsl from '../shaders/field.frag.glsl';

/**
 * Custom ShaderMaterial for the pitch surface.
 *
 * Light data is stored in a float DataTexture instead of uniform arrays.
 *
 * Why DataTexture:
 *   Uniform arrays (vec3/vec4[N]) each consume 1 vec4 from the fragment uniform
 *   budget.  WebGL2 minimum MAX_FRAGMENT_UNIFORM_VECTORS = 224.  With 3 arrays
 *   for positions/targets/params, the break-even is 3 × N vec4s:
 *     N = 64  → 192 vec4s  (just within minimum)
 *     N = 80  → 240 vec4s  (exceeds minimum on some GPUs)
 *   A DataTexture uses only 1 sampler unit regardless of N, with no uniform
 *   budget impact.  MAX_LIGHTS can be set to 128 or higher safely.
 *
 * Texture layout (width = MAX_LIGHTS, height = 3, RGBA float):
 *   row 0:  pixel i → (pos.x,       pos.y,    pos.z,    0)
 *   row 1:  pixel i → (target.x,    target.y, target.z, 0)
 *   row 2:  pixel i → (intensity,   angle,    penumbra, 0)
 *
 * MAX_LIGHTS must match #define MAX_LIGHTS in field.frag.glsl.
 */
export class FieldMaterial {
  static readonly MAX_LIGHTS = MAX_SHADER_LIGHTS;

  readonly material: THREE.ShaderMaterial;
  private readonly texData: Float32Array;
  private readonly texture:  THREE.DataTexture;

  constructor() {
    const ML = FieldMaterial.MAX_LIGHTS;

    // Texture: width=ML, height=3, RGBA float → ML × 3 × 4 floats total.
    this.texData = new Float32Array(ML * 3 * 4);
    this.texture = new THREE.DataTexture(
      this.texData,
      ML,                       // width  = one column per light
      3,                        // height = 3 data rows
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.magFilter  = THREE.NearestFilter;
    this.texture.minFilter  = THREE.NearestFilter;
    this.texture.needsUpdate = true;

    const grassLinear = new THREE.Color(0x2d7a2d).convertSRGBToLinear();

    this.material = new THREE.ShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   fieldVertGlsl,
      fragmentShader: fieldFragGlsl,
      // toneMapped: true (default) — Three.js prefix injects toneMapping() and
      // toneMappingExposure, updated automatically each frame.
      uniforms: {
        lightData:    { value: this.texture },
        lightCount:   { value: 0 },
        iesExponent:  { value: 3.0 },
        baseColor:    { value: grassLinear },
        // Luminance-normalised CCT tint.  Y = dot(color, (0.2126, 0.7152, 0.0722)) = 1.
        // This separates chromaticity (warm/cool hue) from brightness so that the
        // photometric illuminance [lux] computed in the shader is independent of CCT.
        lightColor:   { value: new THREE.Color(1, 1, 1) },
        // 0 = grass colour, 1 = 18 % neutral grey (lighting-only debug view).
        lightingOnly: { value: 0.0 },
      },
      polygonOffset:       true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits:  -1,
    });
  }

  /**
   * Uploads SpotLight state and IES exponent to the DataTexture.
   *
   * Unused slots (i ≥ lights.length) are explicitly cleared (intensity = 0) to
   * prevent stale data from a previous higher-count call producing black patches
   * via the NaN path: 0 × ∞ when intensity is non-zero but positions coincide.
   */
  update(lights: readonly THREE.SpotLight[], iesExp: number): void {
    const ML  = FieldMaterial.MAX_LIGHTS;
    const buf = this.texData;

    // Row base offsets in the flat Float32Array (4 components per texel).
    const ROW_POS = 0;        // row 0: positions
    const ROW_TGT = ML;       // row 1: targets
    const ROW_PAR = 2 * ML;   // row 2: params

    const n = Math.min(lights.length, ML);

    for (let i = 0; i < n; i++) {
      const l = lights[i];

      buf[(ROW_POS + i) * 4]     = l.position.x;
      buf[(ROW_POS + i) * 4 + 1] = l.position.y;
      buf[(ROW_POS + i) * 4 + 2] = l.position.z;

      buf[(ROW_TGT + i) * 4]     = l.target.position.x;
      buf[(ROW_TGT + i) * 4 + 1] = l.target.position.y;
      buf[(ROW_TGT + i) * 4 + 2] = l.target.position.z;

      buf[(ROW_PAR + i) * 4]     = l.intensity;
      buf[(ROW_PAR + i) * 4 + 1] = l.angle;
      buf[(ROW_PAR + i) * 4 + 2] = l.penumbra;
    }

    // Clear intensity of unused slots to prevent stale non-zero values.
    for (let i = n; i < ML; i++) {
      buf[(ROW_PAR + i) * 4] = 0;
    }

    // All fixtures share one CCT colour.  Normalise to luminance Y = 1.0 so that
    // swapping CCT shifts chromaticity only, keeping E_h [lux] unchanged.
    //
    //   Y = 0.2126 R + 0.7152 G + 0.0722 B   (CIE 1931 luminance coefficients)
    //   lightColor_normalised = lightColor / Y
    //
    // Without this, a 2700 K warm-white source (high R, low B) would appear
    // brighter than a 6500 K daylight source even at the same fixture lumen output,
    // because the raw RGB values from cctToColor() are not luminance-normalised.
    if (n > 0) {
      const c   = lights[0].color;
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const s   = lum > 1e-7 ? 1.0 / lum : 1.0;
      (this.material.uniforms['lightColor'].value as THREE.Color).setRGB(
        c.r * s, c.g * s, c.b * s,
      );
    }

    this.texture.needsUpdate = true;
    this.material.uniforms['lightCount'].value  = n;
    this.material.uniforms['iesExponent'].value = iesExp;
  }

  /** Toggle lighting-only (18 % grey) debug view without a full rebuild. */
  setLightingOnly(enabled: boolean): void {
    this.material.uniforms['lightingOnly'].value = enabled ? 1.0 : 0.0;
  }
}
