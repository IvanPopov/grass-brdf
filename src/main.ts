import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { DEFAULT_PARAMS, LightRigParams } from './config';
import { LightRig, computeGroupPhysics } from './lighting/LightRig';
import { LightRigVisual } from './lighting/LightRigVisual';
import { createField } from './scene/Field';
import { FieldMaterial } from './scene/FieldMaterial';
import { createGrid } from './scene/Grid';
import { createFieldAnnotations, createStandAnnotations, HeightAnnotation } from './scene/Annotations';
import { Stands } from './scene/Stands';
import { buildGui } from './ui/Gui';
import { IlluminanceDebug } from './debug/IlluminanceDebug';
import {
  DEFAULT_GRASS_BRDF,
  DEFAULT_GRASS_DEBUG,
  DEFAULT_PATCH_DEBUG,
  GrassBRDFDebug,
  GrassBRDFParams,
  GrassPatchDebug,
} from './scene/GrassBRDFParams';
import { GrassBRDFPatchView } from './debug/GrassBRDFPatchView';
import { CrushMapGpu } from './crushMap/CrushMapGpu';
import {
  createBladeAlbedoMapTexture,
  createBladeTauMapTexture,
  updateBladeOpticalDataTextures,
} from './crushMap/bladeOpticalMaps';
import {
  createCrushMapDataTexture,
  createTrampStampDataTexture,
  updateCrushMapDataTexture,
} from './crushMap/crushMap';
import { buildCrushMapGui } from './ui/crushMapGui';

// ── Parameters ────────────────────────────────────────────────────────────────
// Shallow copy so GUI mutations do not modify the original defaults.
const params: LightRigParams = { ...DEFAULT_PARAMS };

// Grass BRDF parameters — mutable object shared with GUI.
const grassParams: GrassBRDFParams = { ...DEFAULT_GRASS_BRDF };

// Per-component debug toggles — mutable object shared with GUI.
const grassDebug: GrassBRDFDebug = { ...DEFAULT_GRASS_DEBUG };
const patchDebug: GrassPatchDebug = { ...DEFAULT_PATCH_DEBUG };

const grassPatchView = new GrassBRDFPatchView();
grassPatchView.setScreenSize(window.innerWidth, window.innerHeight);

const crushMapGpu = new CrushMapGpu();
const crushMapCpuTex = createCrushMapDataTexture();
const trampStampCpuTex = createTrampStampDataTexture();
const bladeAlbedoMapTex = createBladeAlbedoMapTexture();
const bladeTauMapTex = createBladeTauMapTexture();

let userBladeDetailGpu: THREE.Texture | null = null;
function onBladeDetailMapChange(tex: THREE.Texture | null): void {
  if (userBladeDetailGpu) {
    userBladeDetailGpu.dispose();
    userBladeDetailGpu = null;
  }
  if (tex) {
    userBladeDetailGpu = tex;
  }
  fieldMat.setBladeUserDetailMapTexture(tex);
}

// ── WebGL renderer ────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ACES Filmic tonemapping compresses the high-luminance scene values
// (hundreds of linear units from physical candela SpotLights) into the
// display range [0, 1] with a film-like shoulder, preserving colour in
// highlights instead of hard-clipping to white.
renderer.toneMapping = THREE.ACESFilmicToneMapping;

// Starting exposure:
//   Estimated E_h at field centre ≈ 3 000 lux (see LightRig.ts formulas)
//   For Lambertian albedo ≈ 0.3:  L_out = albedo × E / π ≈ 286 (linear)
//   exposure × 286 ≈ 0.86  →  ACES(0.86) ≈ 0.77 display  → well-lit green
renderer.toneMappingExposure = 0.003;

document.body.appendChild(renderer.domElement);

// ── CSS2D renderer (HTML labels overlay) ─────────────────────────────────────
// Positioned absolute on top of the canvas; pointer-events disabled so
// OrbitControls receives all mouse/touch events normally.
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
Object.assign(labelRenderer.domElement.style, {
  position:      'absolute',
  top:           '0',
  left:          '0',
  pointerEvents: 'none',
});
document.body.appendChild(labelRenderer.domElement);

// ── Scene ─────────────────────────────────────────────────────────────────────
const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 120, 180);

// ── Static scene objects ──────────────────────────────────────────────────────
createGrid(scene);
const { fieldMat } = createField(scene);
createFieldAnnotations(scene);
createStandAnnotations(scene);

const stands = new Stands();
stands.build(fieldMat);
scene.add(stands.group);

// ── Dynamic objects ───────────────────────────────────────────────────────────
const lightRig       = new LightRig();
const lightRigVisual = new LightRigVisual();
scene.add(lightRig.group);
scene.add(lightRigVisual.group);

const heightAnnotation = new HeightAnnotation(scene);

const debug = new IlluminanceDebug();
debug.init(scene);

// ── GUI ───────────────────────────────────────────────────────────────────────
let crushMapGuiHandle: ReturnType<typeof buildCrushMapGui>;

function onGrassChange(): void {
  crushMapGuiHandle?.updatePreview();
  updateBladeOpticalDataTextures(bladeAlbedoMapTex, bladeTauMapTex, grassParams);
  fieldMat.setBladeAlbedoMapTexture(bladeAlbedoMapTex);
  fieldMat.setBladeTauMapTexture(bladeTauMapTex);
  if (grassParams.trampEnabled) {
    updateCrushMapDataTexture(crushMapCpuTex, trampStampCpuTex, grassParams);
    fieldMat.setCrushMapTexture(crushMapCpuTex);
    fieldMat.setTrampStampTexture(trampStampCpuTex);
  } else {
    crushMapGpu.syncUniforms(grassParams);
    crushMapGpu.render(renderer);
    fieldMat.setCrushMapTexture(crushMapGpu.texture);
    fieldMat.setTrampStampTexture(FieldMaterial.getBlackTrampStampTexture());
  }
  fieldMat.updateGrass(grassParams, grassDebug, camera.position);
  grassPatchView.sync(grassParams, lightRig.lights, params.iesExponent, params.colorTempK);
}

const { gui, updateComputedDisplay } = buildGui(
  params,
  rebuild,
  grassParams,
  grassDebug,
  patchDebug,
  onGrassChange,
);

crushMapGuiHandle = buildCrushMapGui(grassParams, onGrassChange, {
  onBladeDetailMapChange: onBladeDetailMapChange,
});
document.body.appendChild(crushMapGuiHandle.host);
Object.assign(crushMapGuiHandle.host.style, {
  position:   'fixed',
  left:       '8px',
  top:        '8px',
  zIndex:     '100',
  maxHeight:  '92vh',
  overflowY:  'auto',
  pointerEvents: 'auto',
});

// Debug controls
const debugFolder = gui.addFolder('Debug');
debugFolder.add(lightRigVisual, 'showCones').name('Cone wireframes')
  .onChange(() => lightRigVisual.build(lightRig.lights, params));
debugFolder.add(lightRigVisual, 'showLabels').name('Fixture labels')
  .onChange(() => lightRigVisual.build(lightRig.lights, params));
debugFolder.add(debug, 'showAimTargets').name('Aim targets (orange)')
  .onChange(() => debug.rebuild(lightRig.lights));
debugFolder.add(debug, 'showHeatmap').name('E_h heatmap (discs)')
  .onChange(() => debug.rebuild(lightRig.lights));
const grProbesCtrl = debugFolder.add(debug, 'showGrProbes').name('GR probes')
  .onChange(() => debug.rebuild(lightRig.lights));
(grProbesCtrl.domElement as HTMLElement).title =
  'CIE 112 Glare Rating (EN 12193). green <30 / yellow 30-40 / orange 40-50 / red >50 (FIFA limit GR=50). Bar height = GR/5 m.';
debugFolder.add({ log: () => debug.logReport(lightRig.lights) }, 'log')
  .name('Log report to console');
debugFolder.open();

// Render settings — kept in main.ts because the renderer lives here.
// Exposure is passed into toneMapping() internally (each ACES/Reinhard/etc.
// implementation in Three.js multiplies the input by toneMappingExposure).
const renderParams = { exposure: renderer.toneMappingExposure };
const renderFolder = gui.addFolder('Render');
renderFolder.add(renderParams, 'exposure', 0.0001, 0.02, 0.0001)
  .name('Exposure')
  .onChange((v: number) => { renderer.toneMappingExposure = v; });
renderFolder.open();

// ── Presets ───────────────────────────────────────────────────────────────────
interface PresetData {
  params: LightRigParams;
  grassParams: GrassBRDFParams;
  grassDebug: GrassBRDFDebug;
  patchDebug: GrassPatchDebug;
  exposure: number;
  maskData: { name: string; url: string } | null;
}

const STORAGE_KEY = 'grass_brdf_presets';
let savedPresets: Record<string, PresetData> = {};
try {
  const data = localStorage.getItem(STORAGE_KEY);
  if (data) savedPresets = JSON.parse(data);
} catch (e) {
  console.warn('Failed to load presets', e);
}

const presetState = {
  currentPreset: Object.keys(savedPresets)[0] || '',
  presetName: 'My Preset',
  save: () => {
    if (!presetState.presetName.trim()) return;
    const name = presetState.presetName.trim();
    const data: PresetData = {
      params: JSON.parse(JSON.stringify(params)),
      grassParams: JSON.parse(JSON.stringify(grassParams)),
      grassDebug: JSON.parse(JSON.stringify(grassDebug)),
      patchDebug: JSON.parse(JSON.stringify(patchDebug)),
      exposure: renderParams.exposure,
      maskData: crushMapGuiHandle.getMaskDataUrl(),
    };
    try {
      savedPresets[name] = data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedPresets));
      updatePresetDropdown();
      presetState.currentPreset = name;
      presetController.updateDisplay();
    } catch (e) {
      alert('Failed to save preset. Texture might be too large for localStorage.');
    }
  },
  load: () => {
    const data = savedPresets[presetState.currentPreset];
    if (!data) return;
    
    Object.assign(params, data.params);
    Object.assign(grassParams, data.grassParams);
    Object.assign(grassDebug, data.grassDebug);
    Object.assign(patchDebug, data.patchDebug);
    
    renderParams.exposure = data.exposure;
    renderer.toneMappingExposure = data.exposure;
    
    crushMapGuiHandle.loadMaskDataUrl(data.maskData);
    
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    crushMapGuiHandle.gui.controllersRecursive().forEach(c => c.updateDisplay());
    
    rebuild();
  },
  delete: () => {
    if (!savedPresets[presetState.currentPreset]) return;
    delete savedPresets[presetState.currentPreset];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedPresets));
      updatePresetDropdown();
      presetState.currentPreset = Object.keys(savedPresets)[0] || '';
      presetController.updateDisplay();
    } catch (e) {
      console.warn(e);
    }
  }
};

const presetsFolder = gui.addFolder('Presets');
let presetController = presetsFolder.add(presetState, 'currentPreset', Object.keys(savedPresets)).name('Select Preset');

function updatePresetDropdown() {
  const options = Object.keys(savedPresets);
  // Recreate the controller to update the options dropdown properly in lil-gui
  const parent = presetController.parent;
  if (parent) {
    presetController.destroy();
    presetController = parent.add(presetState, 'currentPreset', options.length ? options : ['']).name('Select Preset');
  }
}

presetsFolder.add(presetState, 'load').name('Load Preset');
presetsFolder.add(presetState, 'delete').name('Delete Preset');
presetsFolder.add(presetState, 'presetName').name('New Name');
presetsFolder.add(presetState, 'save').name('Save Preset');
presetsFolder.open();

// ── Camera controls ───────────────────────────────────────────────────────────
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 25, 0); // orbit around mid-height to frame field + rig

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  grassPatchView.setScreenSize(window.innerWidth, window.innerHeight);
});

// ── Rebuild ───────────────────────────────────────────────────────────────────
// Called on initial load and whenever any GUI parameter changes.
function rebuild(): void {
  lightRig.build(params);
  lightRigVisual.build(lightRig.lights, params);
  heightAnnotation.build(params.rigHeight, params.ovalHalfLength + 10);
  fieldMat.update(lightRig.lights, params.iesExponent);

  onGrassChange();

  debug.iesExponent        = params.iesExponent;
  debug.fixtureLuminousArea = params.fixtureLuminousArea;
  debug.fieldReflectance    = params.fieldReflectance;
  debug.rebuild(lightRig.lights);
  debug.logReport(lightRig.lights);

  const phys = computeGroupPhysics(params);
  updateComputedDisplay(phys, params);
}

rebuild();

// ── Animation loop ────────────────────────────────────────────────────────────
function animate(): void {
  requestAnimationFrame(animate);
  orbit.update();

  // Update camera position in the BRDF shader every frame so the view-direction
  // dependent shading (specular, hot-spot) responds to camera movement.
  fieldMat.updateGrass(grassParams, grassDebug, camera.position);
  grassPatchView.updateStadiumLighting(lightRig.lights, params.iesExponent, grassParams, params.colorTempK);
  grassPatchView.syncCameraToMain(camera);

  const toneMapping = renderer.toneMapping;
  const toneMappingExposure = renderer.toneMappingExposure;

  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.setScissorTest(false);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);

  grassPatchView.render(renderer, toneMapping, toneMappingExposure, patchDebug);
}

animate();
