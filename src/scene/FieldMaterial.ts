import * as THREE from 'three';
import { MAX_SHADER_LIGHTS } from '../config';
import { GrassBRDFParams, GrassBRDFDebug } from './GrassBRDFParams';
import { estimateMeanZenithRad } from '../math/campbellInclination';
import fieldVertGlsl from '../shaders/field.vert.glsl';
import fieldFragGlsl from '../shaders/field.frag.glsl';

/**
 * Custom ShaderMaterial for the pitch surface.
 *
 * Texture layout (width = MAX_LIGHTS, height = 4, RGBA float):
 *   row 0:  pixel i → (pos.x,     pos.y,    pos.z,    0)
 *   row 1:  pixel i → (target.x,  target.y, target.z, 0)
 *   row 2:  pixel i → (intensity, angleH,   penumbra, angleV)
 *   row 3:  pixel i → (visorTan,  0,        0,        0)
 *
 * angleH / angleV: horizontal / vertical beam half-angles [rad] (elliptic TIR lens).
 * visorTan: tan(visorAngle) — barn-door cutoff per fixture, auto-computed from
 *   the far touchline geometry in LightRig.ts.
 *
 * All materials created via createMaterial() share the same uniform objects
 * so a single update() call propagates to every surface (field, stands, etc.).
 */
export class FieldMaterial {
  static readonly MAX_LIGHTS = MAX_SHADER_LIGHTS;

  readonly material: THREE.ShaderMaterial;
  private readonly texData: Float32Array;
  private readonly texture: THREE.DataTexture;
  private readonly uniforms: Record<string, THREE.IUniform>;

  /** Cached mean Campbell zenith [rad]; recomputed when chiLAD changes. */
  private cachedChiLAD = Number.NaN;
  private cachedMeanZenithRad = 0.0;

  constructor() {
    const ML = FieldMaterial.MAX_LIGHTS;

    // width = ML lights, height = 4 data rows, RGBA float.
    this.texData = new Float32Array(ML * 4 * 4);
    this.texture = new THREE.DataTexture(
      this.texData,
      ML,
      4,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.magFilter  = THREE.NearestFilter;
    this.texture.minFilter  = THREE.NearestFilter;
    this.texture.needsUpdate = true;

    const grassLinear = new THREE.Color(0x2d7a2d).convertSRGBToLinear();

    this.uniforms = {
      lightData:    { value: this.texture },
      lightCount:   { value: 0 },
      iesExponent:  { value: 3.0 },
      lightColor:   { value: new THREE.Color(1, 1, 1) },

      // Camera position for view-direction dependent BRDF.
      // Updated each frame by updateGrass().
      cameraPos: { value: new THREE.Vector3() },

      // Grass BRDF control (0 = Lambertian, 1 = physical OBC)
      grassBRDFMode: { value: 0.0 },

      // Canopy structure
      lai:          { value: 3.5 },
      chiLAD:       { value: 0.5 },
      bladeRL:      { value: 0.004 / 0.027 }, // bladeWidthM / bladeHeightM

      // Blade face tilt for mowing stripe specular (toward +X, angle from vertical)
      bladeTiltRad: { value: 70.0 * Math.PI / 180.0 },
      bladeCampbellMeanTiltRad: { value: 0.7 },
      bladeDirectionalWeight: { value: 0.0 },

      // Leaf optical properties (linear sRGB)
      bladeAlbedo: { value: new THREE.Vector3(0.045, 0.115, 0.025) },
      bladeTau:    { value: new THREE.Vector3(0.015, 0.045, 0.010) },
      soilAlbedo:  { value: new THREE.Vector3(0.090, 0.075, 0.050) },

      // Cuticle specular
      bladeCuticleF0: { value: 0.028 },
      alphaT:         { value: 0.15 },
      alphaB:         { value: 0.60 },

      // Mowing stripe width [m].
      mowingStripeWidth: { value: 5.4 },
      mowingStripesEnabled: { value: 1.0 },
      meadowGridScale: { value: 50.0 },

      dbgHotSpot: { value: 1.0 },
      dbgMS:      { value: 1.0 },
    };

    this.material = this.createMaterial(grassLinear);
  }

  /**
   * Returns a new ShaderMaterial sharing all lighting and BRDF uniforms.
   * Per-surface overrides: baseColor, isSurfaceGrass.
   *
   * isSurfaceGrass: 1.0 = apply physical grass BRDF when mode = 1.
   *                 0.0 = always use Lambertian (concrete stands, etc.)
   */
  createMaterial(baseColor: THREE.Color, isSurfaceGrass = 1.0): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   fieldVertGlsl,
      fragmentShader: fieldFragGlsl,
      uniforms: {
        ...this.uniforms,
        baseColor:      { value: baseColor.clone() },
        isSurfaceGrass: { value: isSurfaceGrass },
      },
      polygonOffset:       true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits:  -1,
    });
  }

  /**
   * Uploads SpotLight state to the DataTexture.  Reads angleV and visorTan
   * from SpotLight.userData['meta'] (set by LightRig).  Clears unused slots.
   */
  update(lights: readonly THREE.SpotLight[], iesExp: number): void {
    const ML  = FieldMaterial.MAX_LIGHTS;
    const buf = this.texData;

    // Row base offsets (4 components per texel, width = ML).
    const ROW_POS = 0;          // row 0: positions
    const ROW_TGT = ML;         // row 1: targets
    const ROW_PAR = 2 * ML;     // row 2: intensity, angleH, penumbra, angleV
    const ROW_EXT = 3 * ML;     // row 3: visorTan

    const n = Math.min(lights.length, ML);

    for (let i = 0; i < n; i++) {
      const l    = lights[i];
      const meta = l.userData['meta'] as { angleV?: number; visorTan?: number; visorPenumbra?: number } | undefined;

      buf[(ROW_POS + i) * 4]     = l.position.x;
      buf[(ROW_POS + i) * 4 + 1] = l.position.y;
      buf[(ROW_POS + i) * 4 + 2] = l.position.z;

      buf[(ROW_TGT + i) * 4]     = l.target.position.x;
      buf[(ROW_TGT + i) * 4 + 1] = l.target.position.y;
      buf[(ROW_TGT + i) * 4 + 2] = l.target.position.z;

      // SpotLight.angle = horizontal half-angle (angleH).
      buf[(ROW_PAR + i) * 4]     = l.intensity;
      buf[(ROW_PAR + i) * 4 + 1] = l.angle;                    // angleH [rad]
      buf[(ROW_PAR + i) * 4 + 2] = l.penumbra;
      buf[(ROW_PAR + i) * 4 + 3] = meta?.angleV ?? l.angle;   // angleV [rad]

      // visorTan: large value = effectively no cutoff.
      buf[(ROW_EXT + i) * 4]     = meta?.visorTan     ?? 1e9;
      buf[(ROW_EXT + i) * 4 + 1] = meta?.visorPenumbra ?? 0.0;
    }

    for (let i = n; i < ML; i++) {
      buf[(ROW_PAR + i) * 4] = 0; // clear intensity → shader skips slot
    }

    // CCT colour normalised to luminance Y = 1.0.
    //   Y = 0.2126 R + 0.7152 G + 0.0722 B   (CIE 1931 luminance coefficients)
    if (n > 0) {
      const c   = lights[0].color;
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const s   = lum > 1e-7 ? 1.0 / lum : 1.0;
      (this.uniforms['lightColor'].value as THREE.Color).setRGB(
        c.r * s, c.g * s, c.b * s,
      );
    }

    this.texture.needsUpdate = true;
    this.uniforms['lightCount'].value  = n;
    this.uniforms['iesExponent'].value = iesExp;
  }

  /**
   * Uploads grass BRDF parameters, debug flags, and camera position to the GPU.
   * Call once per frame (or whenever params change) from the render loop.
   */
  updateGrass(p: GrassBRDFParams, dbg: GrassBRDFDebug, cameraWorldPos: THREE.Vector3): void {
    const u = this.uniforms;

    (u['cameraPos'].value as THREE.Vector3).copy(cameraWorldPos);
    u['grassBRDFMode'].value    = p.grassBRDFMode;

    u['lai'].value              = p.lai;
    u['chiLAD'].value           = p.chiLAD;
    u['bladeRL'].value          = p.bladeWidthM / p.bladeHeightM;
    u['bladeTiltRad'].value     = p.bladeTiltDeg * Math.PI / 180.0;

    if (p.chiLAD !== this.cachedChiLAD) {
      this.cachedMeanZenithRad = estimateMeanZenithRad(p.chiLAD);
      this.cachedChiLAD        = p.chiLAD;
    }
    u['bladeCampbellMeanTiltRad'].value = this.cachedMeanZenithRad;
    u['bladeDirectionalWeight'].value   = THREE.MathUtils.clamp(p.bladeDirectionalWeight, 0.0, 1.0);

    const ba = u['bladeAlbedo'].value as THREE.Vector3;
    ba.set(p.bladeAlbedoR, p.bladeAlbedoG, p.bladeAlbedoB);

    const bt = u['bladeTau'].value as THREE.Vector3;
    bt.set(p.bladeTransmittanceR, p.bladeTransmittanceG, p.bladeTransmittanceB);

    const sa = u['soilAlbedo'].value as THREE.Vector3;
    sa.set(p.soilAlbedoR, p.soilAlbedoG, p.soilAlbedoB);

    u['bladeCuticleF0'].value    = p.bladeCuticleF0;
    u['alphaT'].value            = p.alphaT;
    u['alphaB'].value            = p.alphaB;
    u['mowingStripeWidth'].value     = p.mowingStripeWidth;
    u['mowingStripesEnabled'].value  = p.mowingStripesEnabled ? 1.0 : 0.0;

    u['dbgHotSpot'].value = dbg.dbgHotSpot ? 1.0 : 0.0;
    u['dbgMS'].value      = dbg.dbgMS      ? 1.0 : 0.0;
  }
}
