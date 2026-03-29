import * as THREE from 'three';
import GUI from 'lil-gui';
import type { GrassBRDFParams } from '../scene/GrassBRDFParams';
import { fillBladeAlbedoMapData, fillBladeTauMapData } from '../crushMap/bladeOpticalMaps';
import { fillCrushMapRGBA } from '../crushMap/crushMap';
import { applyTramplingOverlay } from '../crushMap/tramplingStamp';
import { FIELD_H, FIELD_W } from '../config';

/** CPU preview resolution (aspect matches FIELD_W : FIELD_H). */
const PREVIEW_W = 512;
const PREVIEW_H = Math.max(256, Math.round((PREVIEW_W * FIELD_H) / FIELD_W));

export interface CrushMapGuiHandle {
  readonly gui: GUI;
  readonly host: HTMLDivElement;
  updatePreview(): void;
  dispose(): void;
  getMaskDataUrl(): { name: string; url: string } | null;
  loadMaskDataUrl(data: { name: string; url: string } | null): void;
}

export interface CrushMapGuiOptions {
  /** Called when a disk detail map is loaded or cleared (null). Caller may dispose previous GPU texture. */
  onBladeDetailMapChange?: (texture: THREE.Texture | null) => void;
}

function tip<T extends { domElement: Element }>(ctrl: T, text: string): T {
  ctrl.domElement.querySelectorAll('*').forEach(el => {
    (el as HTMLElement).title = text;
  });
  return ctrl;
}

interface EnableDisable {
  enable(): void;
  disable(): void;
}

function setEnabled(c: EnableDisable, on: boolean): void {
  if (on) {
    c.enable();
  } else {
    c.disable();
  }
}

/**
 * Crush map panel: two flat folders with the same leading parameter order
 * (Bend, Coherence, Spread), then folder-specific controls. No nested folders.
 */
export function buildCrushMapGui(
  grassParams: GrassBRDFParams,
  onChange: () => void,
  options?: CrushMapGuiOptions,
): CrushMapGuiHandle {
  const host = document.createElement('div');
  host.id = 'crush-map-gui-host';

  const mapRow = document.createElement('div');
  mapRow.style.display = 'flex';
  mapRow.style.flexDirection = 'row';
  mapRow.style.flexWrap = 'wrap';
  mapRow.style.gap = '8px';
  mapRow.style.marginBottom = '6px';
  mapRow.style.alignItems = 'flex-start';

  function appendPreviewColumn(
    title: string,
    hint: string,
  ): { canvas: HTMLCanvasElement; put: (u8: Uint8Array) => void } {
    const col = document.createElement('div');
    col.style.display = 'flex';
    col.style.flexDirection = 'column';
    col.style.gap = '4px';
    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.font = '11px sans-serif';
    titleEl.style.color = '#aaa';
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    canvas.style.display = 'block';
    canvas.style.maxWidth = '128px';
    canvas.style.height = 'auto';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.border = '1px solid #333';
    canvas.style.background = '#000';
    const hintEl = document.createElement('div');
    hintEl.textContent = hint;
    hintEl.style.font = '10px sans-serif';
    hintEl.style.color = '#888';
    hintEl.style.maxWidth = '128px';
    col.appendChild(titleEl);
    col.appendChild(canvas);
    col.appendChild(hintEl);
    mapRow.appendChild(col);
    const ctxMaybe = canvas.getContext('2d');
    if (!ctxMaybe) {
      throw new Error('2D canvas context required for map preview');
    }
    const ctx = ctxMaybe;
    const imageData = ctx.createImageData(PREVIEW_W, PREVIEW_H);
    const data = imageData.data;
    return {
      canvas,
      put(u8: Uint8Array): void {
        for (let i = 0; i < PREVIEW_W * PREVIEW_H; i++) {
          const o = i * 4;
          const u = i * 4;
          data[o] = u8[u];
          data[o + 1] = u8[u + 1];
          data[o + 2] = u8[u + 2];
          data[o + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
      },
    };
  }

  const crushPrev = appendPreviewColumn(
    'Crush map',
    'Preview: R bend, G coherence, B spread.',
  );
  const albPrev = appendPreviewColumn(
    'Blade albedo map',
    'Per-leaf rho (linear sRGB), field.frag sampling.',
  );
  const tauPrev = appendPreviewColumn(
    'Blade tau map',
    'Per-leaf tau (linear sRGB), field.frag sampling.',
  );

  host.appendChild(mapRow);

  const u8Crush = new Uint8Array(PREVIEW_W * PREVIEW_H * 4);
  const u8Alb = new Uint8Array(PREVIEW_W * PREVIEW_H * 4);
  const u8Tau = new Uint8Array(PREVIEW_W * PREVIEW_H * 4);

  function updatePreview(): void {
    fillCrushMapRGBA(u8Crush, PREVIEW_W, PREVIEW_H, grassParams, FIELD_W, FIELD_H);
    applyTramplingOverlay(u8Crush, null, PREVIEW_W, PREVIEW_H, grassParams, FIELD_W, FIELD_H);
    crushPrev.put(u8Crush);
    fillBladeAlbedoMapData(u8Alb, PREVIEW_W, PREVIEW_H, grassParams);
    fillBladeTauMapData(u8Tau, PREVIEW_W, PREVIEW_H, grassParams);
    albPrev.put(u8Alb);
    tauPrev.put(u8Tau);
  }

  const gui = new GUI({
    title:      'Pitch maps',
    width:      300,
    container:  host,
    autoPlace:  false,
  });

  const mowing = gui.addFolder('Mowing');
  tip(
    mowing.add(grassParams, 'mowBend', 0, 1, 0.02).name('Bend').onChange(onChange),
    'Map R: blend toward fully mowed blade tilt.',
  );
  tip(
    mowing.add(grassParams, 'mowCoherence', 0, 1, 0.02).name('Coherence').onChange(onChange),
    'Map G: anisotropic specular streak vs isotropic (w_dir in evaluateGrassBRDF).',
  );
  tip(
    mowing.add(grassParams, 'mowSpread', 0, 1, 0.02).name('Spread').onChange(onChange),
    'Map B: orientation variance (Toksvig-style spread in the shader).',
  );
  tip(
    mowing.add(grassParams, 'mowMaxTiltDeg', 30, 89, 1).name('Max tilt [deg]').onChange(onChange),
    'Maximum blade-face zenith tilt when map R is one.',
  );
  tip(
    mowing.add(grassParams, 'mowArtMowingEnabled').name('Enable mowing layout').onChange(() => {
      refreshMowLayoutControls();
      onChange();
    }),
    'Bands and alternating lean along world +X. Off: uniform R,G,B from sliders only.',
  );
  const cStripeW = tip(
    mowing
      .add(grassParams, 'mowArtStripeWidthM', 2, 16, 0.1)
      .name('Stripe width [m]')
      .onChange(onChange),
    'Band width along world +X [m]. FIFA broadcast stripes often use about 5 to 5.5 m.',
  );
  const cStripes = tip(
    mowing.add(grassParams, 'mowArtStripesEnabled').name('Alternating stripes').onChange(onChange),
    'Odd/even bands opposite lean for TV light-dark stripes.',
  );
  const cBendVar = tip(
    mowing
      .add(grassParams, 'mowArtStripeBendVariation', 0, 1, 0.05)
      .name('Stripe crush variation')
      .onChange(onChange),
    'Per-stripe R modulation when layout is on (about 8% of R at full).',
  );

  function refreshMowLayoutControls(): void {
    const on = grassParams.mowArtMowingEnabled;
    setEnabled(cStripeW, on);
    setEnabled(cStripes, on);
    setEnabled(cBendVar, on);
  }

  const tramp = gui.addFolder('Trampling');
  tip(
    tramp.add(grassParams, 'trampBend', 0, 0.35, 0.01).name('Bend').onChange(onChange),
    'Additive on map R at full footprint weight. outR = min(1, baseR + bend * t).',
  );
  tip(
    tramp.add(grassParams, 'trampCoherence', 0, 0.25, 0.01).name('Coherence').onChange(onChange),
    'Additive on map G (same channel meaning as mowing Coherence).',
  );
  tip(
    tramp.add(grassParams, 'trampSpread', 0, 0.25, 0.01).name('Spread').onChange(onChange),
    'Additive on map B (same channel meaning as mowing Spread).',
  );
  tip(
    tramp.add(grassParams, 'trampEnabled').name('Enable trampling').onChange(() => {
      refreshTrampControls();
      onChange();
    }),
    'When on, the field uses a CPU-generated crush map (mowing fill plus stamped paths). GPU procedural RTT is not used.',
  );

  const cPaths = tip(
    tramp.add(grassParams, 'trampPathCount', 4, 120, 1).name('Path count').onChange(onChange),
    'Independent random polylines across the pitch.',
  );
  const cSteps = tip(
    tramp.add(grassParams, 'trampStepsPerPath', 8, 200, 1).name('Steps per path').onChange(onChange),
    'Foot placements per path.',
  );
  const cWalk = tip(
    tramp.add(grassParams, 'trampWalkStrideM', 0.4, 1.1, 0.02).name('Walk stride [m]').onChange(onChange),
    'Stride when a step is classified as walking.',
  );
  const cRun = tip(
    tramp.add(grassParams, 'trampRunStrideM', 0.9, 2.2, 0.02).name('Run stride [m]').onChange(onChange),
    'Stride when a step is classified as running.',
  );
  const cWalkFrac = tip(
    tramp.add(grassParams, 'trampWalkFraction', 0, 1, 0.02).name('Walk probability').onChange(onChange),
    'Per step: probability of walk stride vs run stride.',
  );
  const cShoeSmL = tip(
    tramp.add(grassParams, 'trampShoeSmallLengthM', 0.14, 0.32, 0.01).name('Small shoe length [m]').onChange(onChange),
    'Contact length along travel for the smaller ellipse.',
  );
  const cShoeSmW = tip(
    tramp.add(grassParams, 'trampShoeSmallWidthM', 0.05, 0.16, 0.005).name('Small shoe width [m]').onChange(onChange),
    'Contact width across travel for the smaller ellipse.',
  );
  const cShoeLgL = tip(
    tramp.add(grassParams, 'trampShoeLargeLengthM', 0.2, 0.42, 0.01).name('Large shoe length [m]').onChange(onChange),
    'Contact length for the larger ellipse.',
  );
  const cShoeLgW = tip(
    tramp.add(grassParams, 'trampShoeLargeWidthM', 0.08, 0.2, 0.005).name('Large shoe width [m]').onChange(onChange),
    'Contact width for the larger ellipse.',
  );
  const cShoeProb = tip(
    tramp.add(grassParams, 'trampShoeSmallProbability', 0, 1, 0.02).name('P(small shoe)').onChange(onChange),
    'Per step: probability to stamp the small ellipse vs the large one.',
  );
  const cJitter = tip(
    tramp.add(grassParams, 'trampHeadingJitterRad', 0.1, 1.2, 0.02).name('Heading jitter [rad]').onChange(onChange),
    'Random turn per step (half-range).',
  );
  const cFall = tip(
    tramp.add(grassParams, 'trampFalloffPower', 0.35, 4, 0.05).name('Edge falloff power').onChange(onChange),
    'Radial falloff inside the ellipse; higher = sharper shoe boundary.',
  );
  const cSeed = tip(
    tramp.add(grassParams, 'trampSeed', 0, 0xffffffff, 1).name('Seed').onChange(onChange),
    'Deterministic RNG seed for paths and shoes.',
  );

  const leafMaps = gui.addFolder('Leaf maps');
  tip(
    leafMaps.add(grassParams, 'bladeAlbedoR', 0.0, 0.3, 0.005).name('Blade rho R').onChange(onChange),
    'Blade reflectance rho_leaf, red channel (linear, not gamma).\n' +
      'LOPEX93 database for Lolium perenne: about 0.045.\n' +
      'Natural grass is dark in red: chlorophyll absorption.',
  );
  tip(
    leafMaps.add(grassParams, 'bladeAlbedoG', 0.0, 0.4, 0.005).name('Blade rho G').onChange(onChange),
    'Blade reflectance rho_leaf, green channel (linear).\n' +
      'LOPEX93: about 0.115. Primary green appearance driver.',
  );
  tip(
    leafMaps.add(grassParams, 'bladeAlbedoB', 0.0, 0.2, 0.005).name('Blade rho B').onChange(onChange),
    'Blade reflectance rho_leaf, blue channel (linear).\n' +
      'LOPEX93: about 0.025. Low due to chlorophyll a absorption.',
  );
  tip(
    leafMaps.add(grassParams, 'bladeTransmittanceR', 0.0, 0.2, 0.005).name('Blade tau R').onChange(onChange),
    'Blade transmittance tau_leaf, red channel.\n' +
      'PROSPECT calibration: about 0.015. Thin blades transmit some red.',
  );
  tip(
    leafMaps.add(grassParams, 'bladeTransmittanceG', 0.0, 0.3, 0.005).name('Blade tau G').onChange(onChange),
    'Blade transmittance tau_leaf, green channel.\n' +
      'PROSPECT: about 0.045. Highest channel: backlit green glow.\n' +
      'omega = rho + tau is single-scattering albedo in canopy.',
  );
  tip(
    leafMaps.add(grassParams, 'bladeTransmittanceB', 0.0, 0.15, 0.005).name('Blade tau B').onChange(onChange),
    'Blade transmittance tau_leaf, blue channel.\n' + 'PROSPECT: about 0.010.',
  );

  const maskBlock = document.createElement('div');
  maskBlock.style.padding = '4px 0 2px 0';
  maskBlock.style.boxSizing = 'border-box';
  const maskLabel = document.createElement('label');
  maskLabel.style.display = 'block';
  maskLabel.style.width = '100%';
  maskLabel.style.padding = '6px 8px';
  maskLabel.style.boxSizing = 'border-box';
  maskLabel.style.border = '1px solid var(--focus-color, #595959)';
  maskLabel.style.borderRadius = 'var(--widget-border-radius, 2px)';
  maskLabel.style.cursor = 'pointer';
  maskLabel.style.textAlign = 'center';
  maskLabel.style.font = '11px var(--font-family, sans-serif)';
  maskLabel.style.color = 'var(--text-color, #ebebeb)';
  maskLabel.style.background = 'var(--widget-color, #424242)';
  maskLabel.textContent = 'Choose grayscale mask';
  const maskFileInput = document.createElement('input');
  maskFileInput.type = 'file';
  maskFileInput.accept = 'image/*';
  maskFileInput.style.display = 'none';
  maskLabel.appendChild(maskFileInput);
  const maskHint = document.createElement('div');
  maskHint.style.font = '10px var(--font-family, sans-serif)';
  maskHint.style.color = '#888';
  maskHint.style.marginTop = '6px';
  maskHint.textContent =
    'R channel scales blade albedo and tau (two masks, same UV as crush). White 1.0 = unchanged.';
  const maskLine = document.createElement('div');
  maskLine.style.display = 'flex';
  maskLine.style.alignItems = 'center';
  maskLine.style.justifyContent = 'space-between';
  maskLine.style.gap = '8px';
  maskLine.style.marginTop = '4px';
  const maskFileName = document.createElement('span');
  maskFileName.style.font = '10px var(--font-family, sans-serif)';
  maskFileName.style.color = 'var(--text-color, #aaa)';
  maskFileName.style.flex = '1';
  maskFileName.style.overflow = 'hidden';
  maskFileName.style.textOverflow = 'ellipsis';
  maskFileName.style.whiteSpace = 'nowrap';
  maskFileName.textContent = '';
  const maskClear = document.createElement('button');
  maskClear.type = 'button';
  maskClear.textContent = 'Clear';
  maskClear.style.font = '10px var(--font-family, sans-serif)';
  maskClear.style.color = 'var(--text-color, #ebebeb)';
  maskClear.style.background = 'var(--widget-color, #424242)';
  maskClear.style.border = '1px solid var(--focus-color, #595959)';
  maskClear.style.borderRadius = 'var(--widget-border-radius, 2px)';
  maskClear.style.padding = '2px 8px';
  maskClear.style.cursor = 'pointer';
  maskClear.style.flexShrink = '0';
  maskBlock.appendChild(maskLabel);
  maskBlock.appendChild(maskHint);
  maskLine.appendChild(maskFileName);
  maskLine.appendChild(maskClear);
  maskBlock.appendChild(maskLine);
  leafMaps.$children.appendChild(maskBlock);

  let currentMaskData: { name: string; url: string } | null = null;
  const maskTexLoader = new THREE.TextureLoader();

  function triggerMaskLoad(url: string, name: string): void {
    maskTexLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = false;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        options?.onBladeDetailMapChange?.(tex);
        maskFileName.textContent = name;
        onChange();
      },
      undefined,
      () => {
        maskFileName.textContent = 'Load failed';
      },
    );
  }

  maskFileInput.addEventListener('change', () => {
    const f = maskFileInput.files?.[0];
    if (!f) {
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      currentMaskData = { name: f.name, url: dataUrl };
      triggerMaskLoad(dataUrl, f.name);
    };
    reader.readAsDataURL(f);
  });
  maskClear.addEventListener('click', () => {
    maskFileInput.value = '';
    maskFileName.textContent = '';
    currentMaskData = null;
    options?.onBladeDetailMapChange?.(null);
    onChange();
  });

  function refreshTrampControls(): void {
    const on = grassParams.trampEnabled;
    setEnabled(cPaths, on);
    setEnabled(cSteps, on);
    setEnabled(cWalk, on);
    setEnabled(cRun, on);
    setEnabled(cWalkFrac, on);
    setEnabled(cShoeSmL, on);
    setEnabled(cShoeSmW, on);
    setEnabled(cShoeLgL, on);
    setEnabled(cShoeLgW, on);
    setEnabled(cShoeProb, on);
    setEnabled(cJitter, on);
    setEnabled(cFall, on);
    setEnabled(cSeed, on);
  }

  mowing.close();
  tramp.close();
  leafMaps.close();

  const markings = gui.addFolder('Field markings');
  tip(
    markings.add(grassParams, 'markingsEnabled').name('Show lines').onChange(() => {
      refreshMarkingsControls();
      onChange();
    }),
    'Draw PBR-correct football pitch lines directly onto the leaf maps.',
  );
  const cMarkLw = tip(
    markings.add(grassParams, 'markingsLineWidth', 0.05, 0.3, 0.01).name('Line width [m]').onChange(onChange),
    'Standard FIFA line width is 0.12 m.',
  );
  const cMarkAr = tip(
    markings.add(grassParams, 'markingsAlbedoR', 0.0, 1.0, 0.01).name('Paint rho R').onChange(onChange),
    'Paint reflectance (linear sRGB red).',
  );
  const cMarkAg = tip(
    markings.add(grassParams, 'markingsAlbedoG', 0.0, 1.0, 0.01).name('Paint rho G').onChange(onChange),
    'Paint reflectance (linear sRGB green).',
  );
  const cMarkAb = tip(
    markings.add(grassParams, 'markingsAlbedoB', 0.0, 1.0, 0.01).name('Paint rho B').onChange(onChange),
    'Paint reflectance (linear sRGB blue).',
  );
  const cMarkTr = tip(
    markings.add(grassParams, 'markingsTransmittanceR', 0.0, 1.0, 0.01).name('Paint tau R').onChange(onChange),
    'Paint transmittance (usually 0 for opaque paint).',
  );
  const cMarkTg = tip(
    markings.add(grassParams, 'markingsTransmittanceG', 0.0, 1.0, 0.01).name('Paint tau G').onChange(onChange),
    'Paint transmittance (usually 0 for opaque paint).',
  );
  const cMarkTb = tip(
    markings.add(grassParams, 'markingsTransmittanceB', 0.0, 1.0, 0.01).name('Paint tau B').onChange(onChange),
    'Paint transmittance (usually 0 for opaque paint).',
  );

  function refreshMarkingsControls(): void {
    const on = grassParams.markingsEnabled;
    setEnabled(cMarkLw, on);
    setEnabled(cMarkAr, on);
    setEnabled(cMarkAg, on);
    setEnabled(cMarkAb, on);
    setEnabled(cMarkTr, on);
    setEnabled(cMarkTg, on);
    setEnabled(cMarkTb, on);
  }

  markings.close();

  refreshMowLayoutControls();
  refreshTrampControls();
  refreshMarkingsControls();
  updatePreview();

  return {
    gui,
    host,
    updatePreview,
    dispose(): void {
      options?.onBladeDetailMapChange?.(null);
      gui.destroy();
      host.remove();
    },
    getMaskDataUrl() {
      return currentMaskData;
    },
    loadMaskDataUrl(data: { name: string; url: string } | null): void {
      currentMaskData = data;
      if (data) {
        triggerMaskLoad(data.url, data.name);
      } else {
        maskFileInput.value = '';
        maskFileName.textContent = '';
        options?.onBladeDetailMapChange?.(null);
      }
    }
  };
}
