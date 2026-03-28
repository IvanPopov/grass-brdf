import * as THREE from 'three';
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
const _tmpQ = new THREE.Quaternion();
const _tmpM = new THREE.Matrix4();
const _faceN = new THREE.Vector3();
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

/**
 * Blade face normal with uniform +X lean (same as shader with mowing stripes off).
 * Patch does not alternate stripes so the preview matches default tilt only.
 */
function setBladeFaceNormal(out: THREE.Vector3, tiltFromHorizontalRad: number): THREE.Vector3 {
  const lean = 1.0;
  return out.set(
    lean * Math.sin(tiltFromHorizontalRad),
    Math.cos(tiltFromHorizontalRad),
    0.0,
  ).normalize();
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
 * GTAO: not wired (would require EffectComposer + GTAOPass on a render target).
 * Contact shading uses directional shadow map on the patch only.
 */
export class GrassBRDFPatchView {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly ground: THREE.Mesh;
  private readonly instancedBlades: THREE.InstancedMesh;
  private readonly dirLight: THREE.DirectionalLight;
  private readonly ambLight: THREE.AmbientLight;
  private readonly hemi: THREE.HemisphereLight;

  private viewportPx = 256;
  private marginPx = 12;
  private lastParamsKey = '';

  /** Cached CCT tint; updated with stadium lights. */
  private readonly lightTint = new THREE.Color();

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5);
    this.camera.position.set(0.35, 0.42, 0.35);
    this.camera.lookAt(0, 0.02, 0);

    const groundGeo = new THREE.BoxGeometry(GRASS_PATCH_SIZE_M, 0.008, GRASS_PATCH_SIZE_M);
    groundGeo.translate(0, -0.004, 0);
    const groundMat = new THREE.MeshStandardMaterial({
      roughness:       0.95,
      metalness:       0.0,
      envMapIntensity: 0.0,
      toneMapped:      true,
      side:            THREE.DoubleSide,
    });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.receiveShadow = true;
    this.ground.castShadow = false;
    this.scene.add(this.ground);

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
    this.viewportPx = Math.max(120, Math.floor(Math.sqrt(area)));
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
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

    const gw = this.ground.material as THREE.MeshStandardMaterial;
    linearAlbedoToColor(grass.soilAlbedoR, grass.soilAlbedoG, grass.soilAlbedoB, gw.color);

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

    const tiltRad = (grass.bladeTiltDeg * Math.PI) / 180;
    const chi = grass.chiLAD;

    let i = 0;
    for (let r = 0; r < rows && i < n; r++) {
      for (let c = 0; c < cols && i < n; c++, i++) {
        const u = (c + 0.5) / cols;
        const v = (r + 0.5) / rows;
        const lx = (u - 0.5) * 2 * half;
        const lz = (v - 0.5) * 2 * half;
        const rnd = mulberry32((i + 1) * 0x9e3779b9);

        const zSample = sampleZenithFromCampbell(chi, rnd);
        const spreadDeg = (7 / Math.max(0.2, chi)) * (rnd() - 0.5) * 2;
        let tiltEffRad =
          tiltRad +
          THREE.MathUtils.degToRad(spreadDeg) * 0.4 +
          (zSample - Math.PI / 4) * 0.1;
        tiltEffRad = THREE.MathUtils.clamp(tiltEffRad, 0.25, 1.48);

        const nBlade = setBladeFaceNormal(_faceN, tiltEffRad);

        _tmpQ.setFromUnitVectors(_tmpV.set(1, 0, 0), nBlade);

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
    const lux = THREE.MathUtils.clamp(ehEff * 0.35, 500, 14000);
    this.dirLight.intensity = lux;

    const msAmb = ambientMultiplierFromMS(grass);
    this.ambLight.intensity = 0.1 + msAmb;
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
   * Re-applies the same toneMapping and toneMappingExposure as the stadium pass so
   * MeshStandardMaterial uses the identical ACES + exposure path as field.frag.glsl
   * (TONE_MAPPING branch).
   */
  render(
    renderer: THREE.WebGLRenderer,
    toneMapping: THREE.ToneMapping,
    toneMappingExposure: number,
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

    renderer.render(this.scene, this.camera);

    renderer.setViewport(prev.x, prev.y, prev.z, prev.w);
    renderer.setScissorTest(prevTest);
    renderer.autoClear = prevAutoClear;
  }
}
