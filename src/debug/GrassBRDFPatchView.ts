import * as THREE from 'three';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  ColorManagement,
  LinearToneMapping,
  NeutralToneMapping,
  RawShaderMaterial,
  ReinhardToneMapping,
  SRGBTransfer,
  UniformsUtils,
  type IUniform,
  type ToneMapping,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GrassBRDFParams } from '../scene/GrassBRDFParams';
import { cctToColor } from '../lighting/colorTemp';
import { sampleEh } from './IlluminanceSampler';
import { campbellG, campbellM, sampleZenithFromCampbell } from '../math/campbellInclination';

/** Ground tile: 25 cm square (FIFA pitch patch scale for desk debugging). */
export const GRASS_PATCH_SIZE_M = 0.25;

/** Target fraction of the window area for the debug viewport (0.2 = 20%). */
const VIEWPORT_AREA_FRACTION = 0.2;

const MAX_BLADES = 6000;

const _tmpV = new THREE.Vector3();
const _bladeScale = new THREE.Vector3(1, 1, 1);
const _nBlade = new THREE.Vector3();
const _faceN = new THREE.Vector3();
const _bladeLong = new THREE.Vector3();
const _bladeWide = new THREE.Vector3();
const _matBasis = new THREE.Matrix4();
const _tmpQ = new THREE.Quaternion();
const _tmpM = new THREE.Matrix4();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _ehPoint = new THREE.Vector3(0, 0, 0);
const _patchFwd = new THREE.Vector3();
const _patchLookAt = new THREE.Vector3(0, 0.01, 0);

/** Distance from patch look-at point to camera [m]. */
const PATCH_CAMERA_DISTANCE_M = 0.52;

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blade face normal: isotropic azimuth psi, zenith theta from vertical (meadow). */
function bladeNormalMeadow(out: THREE.Vector3, thetaRad: number, psiRad: number): THREE.Vector3 {
  const sx = Math.sin(thetaRad);
  const cy = Math.cos(thetaRad);
  return out.set(sx * Math.cos(psiRad), cy, -sx * Math.sin(psiRad));
}

/**
 * Mowing/stadium normal: field.frag.glsl uses world X stripes; on the small patch we use
 * two halves along X when patchHalfMow is true so both lean directions are visible.
 */
function bladeNormalMowed(
  out: THREE.Vector3,
  lx: number,
  tiltRad: number,
  stripeWidthM: number,
  stripesEnabled: boolean,
  patchHalfMow: boolean,
): THREE.Vector3 {
  if (!stripesEnabled) {
    return out.set(Math.sin(tiltRad), Math.cos(tiltRad), 0);
  }
  let leanSign: number;
  if (patchHalfMow) {
    leanSign = lx < 0 ? -1 : 1;
  } else {
    const stripeIdx = Math.floor(lx / stripeWidthM);
    const stripeParity = ((stripeIdx % 2) + 2) % 2;
    leanSign = stripeParity === 0 ? -1 : 1;
  }
  return out.set(leanSign * Math.sin(tiltRad), Math.cos(tiltRad), 0);
}

/**
 * Box local +X = face outward normal, +Y = lamina height (root to tip). Build an
 * orthonormal basis so blade long axis is the projection of world +Y onto the leaf
 * plane (blade grows upward, not into the soil). setFromUnitVectors(+X, n) alone
 * leaves arbitrary twist and often flips +Y below the ground.
 */
function orientationFromFaceNormal(q: THREE.Quaternion, nRaw: THREE.Vector3): void {
  _faceN.copy(nRaw).normalize();
  if (_faceN.y < 0) {
    _faceN.negate();
  }
  _bladeLong.copy(_worldUp).addScaledVector(_faceN, -_worldUp.dot(_faceN));
  if (_bladeLong.lengthSq() < 1e-14) {
    _bladeLong.set(1, 0, 0).addScaledVector(_faceN, -_faceN.x);
  }
  if (_bladeLong.lengthSq() < 1e-14) {
    _bladeLong.set(0, 0, 1).addScaledVector(_faceN, -_faceN.z);
  }
  _bladeLong.normalize();
  _bladeWide.crossVectors(_faceN, _bladeLong).normalize();
  _bladeLong.crossVectors(_bladeWide, _faceN).normalize();
  _bladeWide.crossVectors(_faceN, _bladeLong).normalize();
  _matBasis.makeBasis(_faceN, _bladeLong, _bladeWide);
  q.setFromRotationMatrix(_matBasis);
}

function linearAlbedoToColor(
  r: number,
  g: number,
  b: number,
  target: THREE.Color,
): THREE.Color {
  return target.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

/**
 * Isotropic multiple-scattering fraction rho_ms (same structure as field.frag.glsl ms_term),
 * mapped to a small ambient multiplier so MeshStandardMaterial approximates diffuse MS fill.
 */
function ambientMultiplierFromMS(grass: GrassBRDFParams): number {
  const omega = Math.min(
    0.999,
    grass.bladeAlbedoG + grass.bladeTransmittanceG,
  );
  const chi = grass.chiLAD;
  const M = campbellM(chi);
  const G = campbellG(1.0, chi, M);
  const lai = grass.lai;
  const Pgap = Math.exp(-(G * lai) / 1.0);
  const PgapAvg = Pgap;
  const G_eff = G;
  const denom = 1.0 - omega * (1.0 - G_eff);
  const rhoMs =
    (omega * omega) / (4.0 * Math.max(denom, 0.001)) * (1.0 - PgapAvg);
  return THREE.MathUtils.clamp(rhoMs * 0.5, 0.0, 0.2);
}

/**
 * Independent Three.js scene: 25 cm turf patch with instanced blades driven by
 * GrassBRDFParams. Rendered in the lower-left corner via scissor (same renderer
 * as the stadium). Uses MeshStandardMaterial (GGX + diffuse). Ground uses soil
 * albedo; blades use leaf albedo. Directional light intensity is scaled from
 * horizontal illuminance at field centre (sampleEh).
 *
 * Optional GTAO: EffectComposer + RenderPass + GTAOPass in the
 * patch viewport only. Hemisphere sky colour is slightly mixed toward blade
 * albedo when the MS-derived ambient term is large (rough diffuse inter-reflection
 * cue; not a substitute for Sellers two-stream in field.frag.glsl).
 * Contact shading uses directional shadow map on the patch only.
 */
export class GrassBRDFPatchView {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly groundLeft: THREE.Mesh;
  private readonly groundRight: THREE.Mesh;
  private readonly instancedBlades: THREE.InstancedMesh;
  private readonly dirLight: THREE.DirectionalLight;
  private readonly ambLight: THREE.AmbientLight;
  private readonly hemi: THREE.HemisphereLight;

  private viewportPx = 256;
  private marginPx = 12;
  private lastParamsKey = '';

  /** Cached CCT tint; updated with stadium lights. */
  private readonly lightTint = new THREE.Color();

  /** Blade albedo target for MS-like hemisphere fill (reused, no per-frame alloc). */
  private readonly msBladeFill = new THREE.Color();

  private patchComposer: EffectComposer | null = null;
  private patchGtaoPass: GTAOPass | null = null;
  private patchTonemapPass: PatchTonemapPass | null = null;
  private patchComposerVp = 0;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5);
    this.camera.position.set(0.35, 0.42, 0.35);
    this.camera.lookAt(0, 0.02, 0);

    const gw = GRASS_PATCH_SIZE_M * 0.5;
    const gd = 0.008;
    const gh = -0.004;
    const groundGeoL = new THREE.BoxGeometry(gw, gd, GRASS_PATCH_SIZE_M);
    groundGeoL.translate(-gw * 0.5, gh, 0);
    const groundGeoR = new THREE.BoxGeometry(gw, gd, GRASS_PATCH_SIZE_M);
    groundGeoR.translate(gw * 0.5, gh, 0);
    const groundMatL = new THREE.MeshStandardMaterial({
      roughness:       0.95,
      metalness:       0.0,
      envMapIntensity: 0.0,
      toneMapped:      true,
      side:            THREE.DoubleSide,
    });
    const groundMatR = groundMatL.clone();
    this.groundLeft = new THREE.Mesh(groundGeoL, groundMatL);
    this.groundRight = new THREE.Mesh(groundGeoR, groundMatR);
    this.groundLeft.receiveShadow = true;
    this.groundRight.receiveShadow = true;
    this.groundLeft.castShadow = false;
    this.groundRight.castShadow = false;
    this.scene.add(this.groundLeft);
    this.scene.add(this.groundRight);

    const bladeGeo = new THREE.BoxGeometry(0.0008, 0.03, 0.004);
    bladeGeo.translate(0, 0.015, 0);
    const bladeMat = new THREE.MeshStandardMaterial({
      roughness:       0.55,
      metalness:       0.0,
      envMapIntensity: 0.0,
      toneMapped:      true,
      side:            THREE.DoubleSide,
    });
    this.instancedBlades = new THREE.InstancedMesh(bladeGeo, bladeMat, MAX_BLADES);
    this.instancedBlades.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedBlades.castShadow = true;
    this.instancedBlades.receiveShadow = false;
    this.instancedBlades.frustumCulled = false;
    this.instancedBlades.count = 0;
    this.scene.add(this.instancedBlades);

    this.ambLight = new THREE.AmbientLight(0xffffff, 0.08);
    this.scene.add(this.ambLight);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 0.15);
    this.hemi.groundColor.setRGB(0.22, 0.2, 0.17, THREE.LinearSRGBColorSpace);
    this.scene.add(this.hemi);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.dirLight.position.set(-0.6, 1.2, 0.45);
    this.dirLight.target.position.set(0, 0, 0);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(512, 512);
    this.dirLight.shadow.camera.near = 0.05;
    this.dirLight.shadow.camera.far = 4;
    this.dirLight.shadow.camera.left = -0.5;
    this.dirLight.shadow.camera.right = 0.5;
    this.dirLight.shadow.camera.top = 0.5;
    this.dirLight.shadow.camera.bottom = -0.5;
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);
  }

  setScreenSize(widthPx: number, heightPx: number): void {
    const area = widthPx * heightPx * VIEWPORT_AREA_FRACTION;
    const next = Math.max(120, Math.floor(Math.sqrt(area)));
    if (next !== this.viewportPx) {
      this.disposePatchComposer();
    }
    this.viewportPx = next;
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
  }

  private disposePatchComposer(): void {
    this.patchTonemapPass?.dispose();
    this.patchTonemapPass = null;
    this.patchGtaoPass?.dispose();
    this.patchComposer?.dispose();
    this.patchComposer = null;
    this.patchGtaoPass = null;
    this.patchComposerVp = 0;
  }

  /**
   * Builds or rebuilds the patch EffectComposer when viewport size changes.
   * GTAOPass internal buffers match the scissored patch resolution (not full window).
   */
  private ensurePatchComposer(renderer: THREE.WebGLRenderer, vp: number): void {
    if (this.patchComposer && this.patchComposerVp === vp) {
      return;
    }
    this.disposePatchComposer();
    this.patchComposerVp = vp;

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(vp, vp);

    const ms = Math.min(4, renderer.capabilities.maxSamples);
    if (ms > 0) {
      const rw = composer.renderTarget1.width;
      const rh = composer.renderTarget1.height;
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
      const rtOpts = {
        type:    THREE.HalfFloatType,
        samples: ms,
      } as const;
      composer.renderTarget1 = new THREE.WebGLRenderTarget(rw, rh, rtOpts);
      composer.renderTarget2 = new THREE.WebGLRenderTarget(rw, rh, rtOpts);
      composer.writeBuffer = composer.renderTarget1;
      composer.readBuffer = composer.renderTarget2;
    }

    const rp = new RenderPass(this.scene, this.camera, null, new THREE.Color(0x000000), 0);

    // Jimenez et al., "Practical Real-Time Strategies for Accurate Indirect Occlusion"
    // (Activision ATVI-TR-16-01). Numeric defaults below follow Intel XeGTAO reference
    // (github.com/GameTechDev/XeGTAO, XeGTAO.h) which implements that report.
    // three.js GTAOPass maps: radius (world/view), distanceExponent (sample distribution),
    // distanceFallOff (falloff range), scale (final occlusion pow), thickness (view-space Z test).
    const JIMENEZ_EFFECT_RADIUS = 0.5;
    const JIMENEZ_RADIUS_MULTIPLIER = 1.457;
    const aoParams = {
      radius:            JIMENEZ_EFFECT_RADIUS * JIMENEZ_RADIUS_MULTIPLIER,
      distanceExponent:  2.0,
      thickness:         1.0,
      distanceFallOff:   0.615,
      scale:             2.2,
      samples:           16,
      screenSpaceRadius: false,
    };
    const pdParams = {
      lumaPhi:   10,
      depthPhi:  2,
      normalPhi: 3,
      radius:    8,
      rings:     2,
      samples:   16,
    };

    const gp = new GTAOPass(this.scene, this.camera, vp, vp);
    gp.updateGtaoMaterial(aoParams);
    gp.updatePdMaterial(pdParams);
    gp.output = GTAOPass.OUTPUT.Default;
    gp.blendIntensity = 0.55;

    const outPass = new PatchTonemapPass();

    composer.addPass(rp);
    composer.addPass(gp);
    composer.addPass(outPass);

    this.patchComposer = composer;
    this.patchGtaoPass = gp;
    this.patchTonemapPass = outPass;
  }

  sync(
    grass: GrassBRDFParams,
    lights: readonly THREE.SpotLight[],
    iesExponent: number,
    colorTempK: number,
  ): void {
    const key = JSON.stringify({
      lai: grass.lai,
      chi: grass.chiLAD,
      bh:  grass.bladeHeightM,
      bw:  grass.bladeWidthM,
      sw:  grass.mowingStripeWidth,
      ms:  grass.mowingStripesEnabled,
      bt:  grass.bladeTiltDeg,
      bdw: grass.bladeDirectionalWeight,
      ar:  grass.bladeAlbedoR,
      ag:  grass.bladeAlbedoG,
      ab:  grass.bladeAlbedoB,
      sr:  grass.soilAlbedoR,
      sg:  grass.soilAlbedoG,
      sb:  grass.soilAlbedoB,
      f0:  grass.bladeCuticleF0,
      aT:  grass.alphaT,
      aB:  grass.alphaB,
      cct: colorTempK,
    });
    if (key === this.lastParamsKey && this.instancedBlades.count > 0) {
      this.updateLightFromStadium(lights, iesExponent, grass, colorTempK);
      return;
    }
    this.lastParamsKey = key;

    const patchArea = GRASS_PATCH_SIZE_M * GRASS_PATCH_SIZE_M;
    const bladeOneSidedArea = Math.max(1e-6, grass.bladeHeightM * grass.bladeWidthM);
    let n = Math.round((grass.lai * patchArea) / bladeOneSidedArea);
    n = Math.max(12, Math.min(MAX_BLADES, n));

    const wDir = THREE.MathUtils.clamp(grass.bladeDirectionalWeight, 0, 1);
    const showMowHalves = grass.mowingStripesEnabled && wDir > 1e-5;

    const matL = this.groundLeft.material as THREE.MeshStandardMaterial;
    const matR = this.groundRight.material as THREE.MeshStandardMaterial;
    linearAlbedoToColor(grass.soilAlbedoR, grass.soilAlbedoG, grass.soilAlbedoB, matL.color);
    linearAlbedoToColor(grass.soilAlbedoR, grass.soilAlbedoG, grass.soilAlbedoB, matR.color);
    if (showMowHalves) {
      matL.color.multiplyScalar(0.94);
      matR.color.multiplyScalar(1.06);
      matL.roughness = 0.96;
      matR.roughness = 0.92;
    } else {
      matL.roughness = 0.95;
      matR.roughness = 0.95;
    }

    const bm = this.instancedBlades.material as THREE.MeshStandardMaterial;
    linearAlbedoToColor(grass.bladeAlbedoR, grass.bladeAlbedoG, grass.bladeAlbedoB, bm.color);
    bm.roughness = THREE.MathUtils.clamp((grass.alphaT + grass.alphaB) * 0.5, 0.04, 1.0);
    bm.metalness = grass.bladeCuticleF0 * 0.15;

    const thick = Math.max(0.0002, grass.bladeWidthM * 0.12);
    // Large faces must have normals +/- X so setFromUnitVectors(+X, N_blade) shows the leaf face.
    // Order: (thin X, height Y, width Z) = (thickness, bladeHeight, bladeWidth).
    const newGeo = new THREE.BoxGeometry(thick, grass.bladeHeightM, grass.bladeWidthM);
    newGeo.translate(0, grass.bladeHeightM * 0.5, 0);
    this.instancedBlades.geometry.dispose();
    this.instancedBlades.geometry = newGeo;

    const half = GRASS_PATCH_SIZE_M * 0.5 - 1e-4;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);

    const tiltMowRad = THREE.MathUtils.degToRad(grass.bladeTiltDeg);
    const patchStripeW = Math.max(0.04, Math.min(grass.mowingStripeWidth, GRASS_PATCH_SIZE_M * 0.45));
    const patchHalfMow = showMowHalves;
    const chi = grass.chiLAD;

    let i = 0;
    for (let r = 0; r < rows && i < n; r++) {
      for (let c = 0; c < cols && i < n; c++, i++) {
        const u = (c + 0.5) / cols;
        const v = (r + 0.5) / rows;
        const lx = (u - 0.5) * 2 * half;
        const lz = (v - 0.5) * 2 * half;
        const rnd = mulberry32((i + 1) * 0x9e3779b9);

        const thetaCamp = sampleZenithFromCampbell(chi, rnd);
        const psi = rnd() * Math.PI * 2;
        bladeNormalMeadow(_tmpV, thetaCamp, psi);
        bladeNormalMowed(_faceN, lx, tiltMowRad, patchStripeW, grass.mowingStripesEnabled, patchHalfMow);
        _nBlade.copy(_tmpV).lerp(_faceN, wDir).normalize();

        orientationFromFaceNormal(_tmpQ, _nBlade);

        _tmpM.compose(_tmpV.set(lx, 0, lz), _tmpQ, _bladeScale);
        this.instancedBlades.setMatrixAt(i, _tmpM);
      }
    }
    this.instancedBlades.count = n;
    this.instancedBlades.instanceMatrix.needsUpdate = true;

    this.updateLightFromStadium(lights, iesExponent, grass, colorTempK);
  }

  private updateLightFromStadium(
    lights: readonly THREE.SpotLight[],
    iesExponent: number,
    grass: GrassBRDFParams,
    colorTempK: number,
  ): void {
    this.lightTint.copy(cctToColor(colorTempK));
    this.dirLight.color.copy(this.lightTint);
    this.ambLight.color.copy(this.lightTint);
    this.hemi.color.copy(this.lightTint);

    const eh = sampleEh(lights, _ehPoint, iesExponent);
    const ehEff = Math.max(eh, 400);
    const lux = THREE.MathUtils.clamp(ehEff * 0.7, 800, 22000);
    this.dirLight.intensity = lux;

    const msAmb = ambientMultiplierFromMS(grass);
    this.ambLight.intensity = 0.14 + msAmb;
    this.hemi.intensity = 0.22;
    linearAlbedoToColor(grass.bladeAlbedoR, grass.bladeAlbedoG, grass.bladeAlbedoB, this.msBladeFill);
    const msMix = THREE.MathUtils.clamp(msAmb * 1.75, 0, 0.38);
    this.hemi.color.copy(this.lightTint).lerp(this.msBladeFill, msMix);
  }

  /**
   * Updates directional intensity from field-centre E_h only (no geometry rebuild).
   * Call each frame or after rig rebuild so the patch tracks stadium illuminance.
   */
  updateStadiumLighting(
    lights: readonly THREE.SpotLight[],
    iesExponent: number,
    grass: GrassBRDFParams,
    colorTempK: number,
  ): void {
    this.updateLightFromStadium(lights, iesExponent, grass, colorTempK);
  }

  /**
   * Aligns the patch camera with the stadium camera: same view axis and up vector,
   * distance fixed so the 25 cm tile fills the corner viewport. World axes match
   * the pitch (X along length, Y up, Z across width) so blade tilt matches the field.
   */
  syncCameraToMain(mainCamera: THREE.Camera): void {
    mainCamera.getWorldDirection(_patchFwd);
    this.camera.position.copy(_patchLookAt).addScaledVector(_patchFwd, -PATCH_CAMERA_DISTANCE_M);
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(_patchLookAt);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Renders the patch into the lower-left corner. Call after the main scene render.
   * With GTAO, the final pass matches three.js OutputPass: same toneMapping,
   * toneMappingExposure, and outputColorSpace as the WebGLRenderer (set on `renderer` before this call).
   */
  render(
    renderer: THREE.WebGLRenderer,
    toneMapping: THREE.ToneMapping,
    toneMappingExposure: number,
    patchGtaoEnabled: boolean,
  ): void {
    const w = this.viewportPx;
    const h = this.viewportPx;
    const left = this.marginPx;
    const bottom = this.marginPx;

    const prev = new THREE.Vector4();
    renderer.getViewport(prev);
    const prevTest = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;

    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = toneMappingExposure;

    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(left, bottom, w, h);
    renderer.setScissor(left, bottom, w, h);
    renderer.clearDepth();

    if (patchGtaoEnabled) {
      this.ensurePatchComposer(renderer, w);
      if (this.patchComposer) {
        this.patchComposer.renderToScreen = true;
        this.patchComposer.render();
      }
    } else {
      this.disposePatchComposer();
      renderer.render(this.scene, this.camera);
    }

    renderer.setViewport(prev.x, prev.y, prev.z, prev.w);
    renderer.setScissorTest(prevTest);
    renderer.autoClear = prevAutoClear;
  }
}

/** Same ACES + sRGB path as three.js OutputPass; `discard` keeps the stadium visible where RT alpha is zero. */
const PATCH_TONEMAP = {
  uniforms: {
    tDiffuse:            { value: null },
    toneMappingExposure: { value: 1 },
  },
  vertexShader: /* glsl */ `
    precision highp float;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    attribute vec3 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D( tDiffuse, vUv );
      if ( tex.a < 0.001 ) discard;
      gl_FragColor = tex;
      #ifdef LINEAR_TONE_MAPPING
        gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );
      #elif defined( REINHARD_TONE_MAPPING )
        gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );
      #elif defined( CINEON_TONE_MAPPING )
        gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );
      #elif defined( ACES_FILMIC_TONE_MAPPING )
        gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
      #elif defined( AGX_TONE_MAPPING )
        gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
      #elif defined( NEUTRAL_TONE_MAPPING )
        gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
      #endif
      #ifdef SRGB_TRANSFER
        gl_FragColor = sRGBTransferOETF( gl_FragColor );
      #endif
    }
  `,
};

class PatchTonemapPass extends Pass {
  private readonly uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    toneMappingExposure: { value: number };
  };
  private readonly material: RawShaderMaterial;
  private readonly fsQuad: FullScreenQuad;
  private outCs: string | null = null;
  private outTm: ToneMapping | null = null;

  constructor() {
    super();
    this.uniforms = UniformsUtils.clone(PATCH_TONEMAP.uniforms) as PatchTonemapPass['uniforms'];
    this.material = new RawShaderMaterial({
      name:         'PatchTonemapPass',
      uniforms:     this.uniforms as unknown as { [k: string]: IUniform },
      vertexShader: PATCH_TONEMAP.vertexShader,
      fragmentShader: PATCH_TONEMAP.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    if (this.outCs !== renderer.outputColorSpace || this.outTm !== renderer.toneMapping) {
      this.outCs = renderer.outputColorSpace;
      this.outTm = renderer.toneMapping;
      this.material.defines = {};
      if (ColorManagement.getTransfer(renderer.outputColorSpace) === SRGBTransfer) {
        this.material.defines.SRGB_TRANSFER = '';
      }
      if (this.outTm === LinearToneMapping) this.material.defines.LINEAR_TONE_MAPPING = '';
      else if (this.outTm === ReinhardToneMapping) this.material.defines.REINHARD_TONE_MAPPING = '';
      else if (this.outTm === CineonToneMapping) this.material.defines.CINEON_TONE_MAPPING = '';
      else if (this.outTm === ACESFilmicToneMapping) this.material.defines.ACES_FILMIC_TONE_MAPPING = '';
      else if (this.outTm === AgXToneMapping) this.material.defines.AGX_TONE_MAPPING = '';
      else if (this.outTm === NeutralToneMapping) this.material.defines.NEUTRAL_TONE_MAPPING = '';
      this.material.needsUpdate = true;
    }
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) {
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
      }
      this.fsQuad.render(renderer);
    }
  }

  override dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
