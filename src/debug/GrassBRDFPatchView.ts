import * as THREE from 'three';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  ColorManagement,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
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
import {
  GrassBRDFParams,
  DEFAULT_PATCH_DEBUG,
  type GrassPatchDebug,
} from '../scene/GrassBRDFParams';
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
/** Lamina mid-height offset: projection of world +Y onto blade plane (not field T or B). */
const _bladeUp = new THREE.Vector3();

/** Distance from patch look-at point to camera [m]. */
const PATCH_CAMERA_DISTANCE_M = 0.52;

/** Emulate two rig fixtures on opposite sidelines (across pitch width, +/-Z); Y up, X along length. */
const CORNICE_HEIGHT_M = 1.05;
const CORNICE_OFFSET_ACROSS_M = 1.28;
/** Cone wide enough for the 25 cm tile from ~1.3 m slant range [rad]. */
const CORNICE_SPOT_ANGLE_RAD = 0.55;
const CORNICE_SPOT_PENUMBRA = 0.22;

/** Wireframe cone length only (m); patch tile is 25 cm; keeps debug frustum readable. */
const PATCH_SPOT_CONE_VIS_LEN_M = 0.14;
/** Place cone apex this far from the hit point back toward the light so the glyph stays inside the patch camera frustum (real rig is ~1.3 m away). */
const PATCH_SPOT_VIS_APEX_BACK_M = 0.11;

/** Main patch content; spot cone helpers render on PATCH_LAYER_SPOT_CONE after GTAO to skip tonemapping. */
const PATCH_LAYER_SCENE = 0;
const PATCH_LAYER_SPOT_CONE = 1;

const _patchConeTarget = new THREE.Vector3();
const _patchLightPos = new THREE.Vector3();
const _patchConeDir = new THREE.Vector3();
const _patchConeApex = new THREE.Vector3();
const _patchConeZ = new THREE.Vector3(0, 0, 1);

/** Same line layout as three.js SpotLightHelper; scale uses PATCH_SPOT_CONE_VIS_LEN_M, not light.distance. */
function buildPatchSpotConeWireGeometry(): THREE.BufferGeometry {
  const positions: number[] = [
    0, 0, 0, 0, 0, 1,
    0, 0, 0, 1, 0, 1,
    0, 0, 0, -1, 0, 1,
    0, 0, 0, 0, 1, 1,
    0, 0, 0, 0, -1, 1,
  ];
  for (let i = 0, j = 1, l = 32; i < l; i++, j++) {
    const p1 = (i / l) * Math.PI * 2;
    const p2 = (j / l) * Math.PI * 2;
    positions.push(Math.cos(p1), Math.sin(p1), 1, Math.cos(p2), Math.sin(p2), 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

let _patchSpotConeWireGeometry: THREE.BufferGeometry | null = null;

function getPatchSpotConeWireGeometry(): THREE.BufferGeometry {
  if (!_patchSpotConeWireGeometry) {
    _patchSpotConeWireGeometry = buildPatchSpotConeWireGeometry();
  }
  return _patchSpotConeWireGeometry;
}

/**
 * Compact spot frustum wire near the patch hit point: same direction as the cornice SpotLight
 * toward its target, but not at stadium world positions (those lie outside the patch camera frustum).
 * depthTest off so the overlay pass stays visible after GTAO and tonemap.
 */
class PatchSpotConeWire extends THREE.Object3D {
  readonly cone: THREE.LineSegments;

  constructor(
    private readonly light: THREE.SpotLight,
    colorHex: number,
    private readonly visLengthM: number,
  ) {
    super();
    const material = new THREE.LineBasicMaterial({
      color:       colorHex,
      fog:         false,
      toneMapped:  false,
      depthTest:   false,
      depthWrite:  false,
    });
    this.cone = new THREE.LineSegments(getPatchSpotConeWireGeometry(), material);
    this.add(this.cone);
    this.layers.set(PATCH_LAYER_SPOT_CONE);
    this.cone.layers.set(PATCH_LAYER_SPOT_CONE);
  }

  update(): void {
    this.light.updateWorldMatrix(true, false);
    this.light.target.updateWorldMatrix(true, false);
    this.light.getWorldPosition(_patchLightPos);
    _patchConeTarget.setFromMatrixPosition(this.light.target.matrixWorld);
    _patchConeDir.subVectors(_patchConeTarget, _patchLightPos).normalize();
    _patchConeApex.copy(_patchConeTarget).addScaledVector(_patchConeDir, -PATCH_SPOT_VIS_APEX_BACK_M);
    this.position.copy(_patchConeApex);
    this.quaternion.setFromUnitVectors(_patchConeZ, _patchConeDir);
    this.scale.set(1, 1, 1);
    this.updateMatrixWorld(true);
    const coneLength = this.visLengthM;
    const coneWidth = coneLength * Math.tan(this.light.angle);
    this.cone.scale.set(coneWidth, coneWidth, coneLength);
    this.cone.quaternion.identity();
    this.cone.position.set(0, 0, 0);
  }
}

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
 * Meadow / no directional weight: lamina long axis = projection of world +Y onto the leaf plane,
 * width = cross(N, long). Instance basis columns (N, long, wide) so local +X maps to face normal N.
 * PlaneGeometry must be pre-rotated by rotateY(pi/2) so vertex normals (local +Z after default) align
 * with that +X axis; otherwise blades appear horizontal in the ground plane.
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

/**
 * Lamina quad: local +Z is face normal before rotateY(pi/2); after rotation +X is N for orientationFromFaceNormal.
 */
function makeBladeQuadGeometry(widthM: number, heightM: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(widthM, heightM);
  g.rotateY(Math.PI / 2);
  g.computeTangents();
  return g;
}

/**
 * field.frag.glsl: w=0 uses isotropic a_mean; w>0 uses anisotropic GGX in mow T/B frame.
 * Mesh tangent space follows growth (orientationFromFaceNormal), not mow T/B, so mowed patch specular
 * streak direction is only a rough match to the field until per-instance tangent or custom shader.
 */
function applyPhysicalGrassBladeMaterial(
  bm: THREE.MeshPhysicalMaterial,
  grass: GrassBRDFParams,
  wDir: number,
): void {
  if (wDir <= 1e-5) {
    const aMean = (grass.alphaT + grass.alphaB) * 0.5;
    bm.roughness = Math.sqrt(THREE.MathUtils.clamp(aMean, 0.001, 1.0));
    bm.anisotropy = 0;
  } else {
    const aLo = Math.min(grass.alphaT, grass.alphaB);
    const aHi = Math.max(grass.alphaT, grass.alphaB);
    const r2 = THREE.MathUtils.clamp(aLo, 0.001, 0.999);
    bm.roughness = Math.sqrt(r2);
    bm.anisotropy =
      aHi <= r2 + 1e-7
        ? 0
        : Math.sqrt(THREE.MathUtils.clamp((aHi - r2) / (1.0 - r2), 0, 1));
  }
  bm.anisotropyRotation = 0;
  const sqF0 = Math.sqrt(THREE.MathUtils.clamp(grass.bladeCuticleF0, 0.0, 0.99));
  bm.ior = (1.0 + sqF0) / (1.0 - sqF0);
  bm.metalness = 0.0;
}

/** World +Y projected onto plane perpendicular to blade face normal; lamina mid-height offset direction. */
function bladeUpAlongLeaf(out: THREE.Vector3, nBlade: THREE.Vector3): void {
  out.copy(_worldUp).addScaledVector(nBlade, -_worldUp.dot(nBlade));
  if (out.lengthSq() < 1e-14) {
    out.set(0, 1, 0);
  }
  out.normalize();
}

function mowingLeanSign(
  lx: number,
  stripeWidthM: number,
  patchHalfMow: boolean,
  stripesEnabled: boolean,
): number {
  if (!stripesEnabled) {
    return 1;
  }
  if (patchHalfMow) {
    return lx < 0 ? -1 : 1;
  }
  const stripeIdx = Math.floor(lx / stripeWidthM);
  return (((stripeIdx % 2) + 2) % 2) === 0 ? -1 : 1;
}

function shortestAngleDelta(fromRad: number, toRad: number): number {
  let d = toRad - fromRad;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
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
 * as the stadium). Blades use MeshPhysicalMaterial (anisotropic GGX, IOR from F0).
 * Ground uses soil
 * albedo; blades use leaf albedo. Directional light intensity is scaled from
 * horizontal illuminance at field centre (sampleEh), split evenly between two
 * cornice SpotLights on +/-Z (across pitch width), both casting shadows.
 *
 * Optional GTAO: EffectComposer + RenderPass + GTAOPass in the
 * patch viewport only. Hemisphere sky colour is slightly mixed toward blade
 * albedo when the MS-derived ambient term is large (rough diffuse inter-reflection
 * cue; not a substitute for Sellers two-stream in field.frag.glsl).
 */
export class GrassBRDFPatchView {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly groundLeft: THREE.Mesh;
  private readonly groundRight: THREE.Mesh;
  private readonly instancedBlades: THREE.InstancedMesh;
  private readonly spotCorniceL: THREE.SpotLight;
  private readonly spotCorniceR: THREE.SpotLight;
  private readonly spotConeHelpL: PatchSpotConeWire;
  private readonly spotConeHelpR: PatchSpotConeWire;
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

    const bladeGeo = makeBladeQuadGeometry(0.004, 0.03);
    const bladeMat = new THREE.MeshPhysicalMaterial({
      roughness:       0.55,
      metalness:       0.0,
      ior:             1.4,
      anisotropy:      0.0,
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

    const patchTargetY = 0.01;
    this.spotCorniceL = new THREE.SpotLight(
      0xffffff,
      0.5,
      0,
      CORNICE_SPOT_ANGLE_RAD,
      CORNICE_SPOT_PENUMBRA,
      0,
    );
    this.spotCorniceR = new THREE.SpotLight(
      0xffffff,
      0.5,
      0,
      CORNICE_SPOT_ANGLE_RAD,
      CORNICE_SPOT_PENUMBRA,
      0,
    );
    for (const s of [this.spotCorniceL, this.spotCorniceR]) {
      s.castShadow = true;
      s.shadow.mapSize.set(512, 512);
      s.shadow.camera.near = 0.08;
      s.shadow.camera.far = 5;
      s.shadow.bias = -0.0001;
      s.target.position.set(0, patchTargetY, 0);
      this.scene.add(s);
      this.scene.add(s.target);
    }
    this.spotCorniceL.position.set(0, CORNICE_HEIGHT_M, -CORNICE_OFFSET_ACROSS_M);
    this.spotCorniceR.position.set(0, CORNICE_HEIGHT_M, CORNICE_OFFSET_ACROSS_M);

    this.spotConeHelpL = new PatchSpotConeWire(this.spotCorniceL, 0x8cb4e8, PATCH_SPOT_CONE_VIS_LEN_M);
    this.spotConeHelpR = new PatchSpotConeWire(this.spotCorniceR, 0xe8c48c, PATCH_SPOT_CONE_VIS_LEN_M);
    this.spotConeHelpL.visible = false;
    this.spotConeHelpR.visible = false;
    this.scene.add(this.spotConeHelpL);
    this.scene.add(this.spotConeHelpR);
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
   * Draws spot cone helpers after the GTAO chain so lines are not run through AO or patch tonemapping.
   * Same viewport and scissor as the patch must already be set on the renderer.
   */
  private applyPatchGtaoDebug(patchDebug: GrassPatchDebug): void {
    const gp = this.patchGtaoPass;
    if (!gp) {
      return;
    }
    gp.blendIntensity = 1;
    gp.updateGtaoMaterial({
      radius:            patchDebug.gtaoRadius,
      distanceExponent:  2.0,
      thickness:         1.0,
      distanceFallOff:   0.615,
      scale:             patchDebug.gtaoScale,
      samples:           16,
      screenSpaceRadius: false,
    });
  }

  private renderSpotConeOverlay(
    renderer: THREE.WebGLRenderer,
    toneMapping: THREE.ToneMapping,
    toneMappingExposure: number,
  ): void {
    const prevMask = this.camera.layers.mask;
    const prevOutCs = renderer.outputColorSpace;
    this.camera.layers.disable(PATCH_LAYER_SCENE);
    this.camera.layers.enable(PATCH_LAYER_SPOT_CONE);

    renderer.toneMapping = NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);

    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = toneMappingExposure;
    renderer.outputColorSpace = prevOutCs;
    this.camera.layers.mask = prevMask;
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
    const dd = DEFAULT_PATCH_DEBUG;
    const aoParams = {
      radius:            dd.gtaoRadius,
      distanceExponent:  2.0,
      thickness:         1.0,
      distanceFallOff:   0.615,
      scale:             dd.gtaoScale,
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
    gp.blendIntensity = 1;

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

    const bm = this.instancedBlades.material as THREE.MeshPhysicalMaterial;
    linearAlbedoToColor(grass.bladeAlbedoR, grass.bladeAlbedoG, grass.bladeAlbedoB, bm.color);
    applyPhysicalGrassBladeMaterial(bm, grass, wDir);

    const w = Math.max(1e-4, grass.bladeWidthM);
    const h = Math.max(1e-4, grass.bladeHeightM);
    const newGeo = makeBladeQuadGeometry(w, h);
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

        const leanSign = mowingLeanSign(lx, patchStripeW, patchHalfMow, grass.mowingStripesEnabled);
        const mowedPsi = -leanSign * Math.PI / 2;
        const finalPsi = psi + shortestAngleDelta(psi, mowedPsi) * wDir;
        const finalTheta = THREE.MathUtils.lerp(thetaCamp, tiltMowRad, wDir);

        bladeNormalMeadow(_nBlade, finalTheta, finalPsi);

        bladeUpAlongLeaf(_bladeUp, _nBlade);
        _tmpV.set(lx, 0, lz).addScaledVector(_bladeUp, grass.bladeHeightM * 0.5);

        orientationFromFaceNormal(_tmpQ, _nBlade);

        _tmpM.compose(_tmpV, _tmpQ, _bladeScale);
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
    this.spotCorniceL.color.copy(this.lightTint);
    this.spotCorniceR.color.copy(this.lightTint);
    this.ambLight.color.copy(this.lightTint);
    this.hemi.color.copy(this.lightTint);

    const eh = sampleEh(lights, _ehPoint, iesExponent);
    const ehEff = Math.max(eh, 400);
    const lux = THREE.MathUtils.clamp(ehEff * 0.7, 800, 22000);
    const halfLux = lux * 0.5;
    this.spotCorniceL.intensity = halfLux;
    this.spotCorniceR.intensity = halfLux;

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
    patchDebug: GrassPatchDebug,
  ): void {
    const w = this.viewportPx;
    const patchGtaoEnabled = patchDebug.gtao;

    this.spotConeHelpL.visible = patchDebug.showSpotCones;
    this.spotConeHelpR.visible = patchDebug.showSpotCones;
    if (patchDebug.showSpotCones) {
      this.spotConeHelpL.update();
      this.spotConeHelpR.update();
    }
    const h = this.viewportPx;
    const left = this.marginPx;
    const bottom = this.marginPx;

    const prev = new THREE.Vector4();
    renderer.getViewport(prev);
    const prevTest = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;
    const prevCamMask = this.camera.layers.mask;

    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = toneMappingExposure;

    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(left, bottom, w, h);
    renderer.setScissor(left, bottom, w, h);
    renderer.clearDepth();

    if (patchGtaoEnabled) {
      this.ensurePatchComposer(renderer, w);
      this.applyPatchGtaoDebug(patchDebug);
      this.camera.layers.disable(PATCH_LAYER_SPOT_CONE);
      this.camera.layers.enable(PATCH_LAYER_SCENE);
      if (this.patchComposer) {
        this.patchComposer.renderToScreen = true;
        this.patchComposer.render();
      }
      if (patchDebug.showSpotCones) {
        this.renderSpotConeOverlay(renderer, toneMapping, toneMappingExposure);
      }
    } else {
      this.disposePatchComposer();
      this.camera.layers.enable(PATCH_LAYER_SCENE);
      if (patchDebug.showSpotCones) {
        this.camera.layers.enable(PATCH_LAYER_SPOT_CONE);
      } else {
        this.camera.layers.disable(PATCH_LAYER_SPOT_CONE);
      }
      renderer.render(this.scene, this.camera);
    }

    this.camera.layers.mask = prevCamMask;
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
