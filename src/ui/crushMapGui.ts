import GUI from 'lil-gui';
import type { GrassBRDFParams } from '../scene/GrassBRDFParams';
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
): CrushMapGuiHandle {
  const host = document.createElement('div');
  host.id = 'crush-map-gui-host';

  const mapStack = document.createElement('div');
  mapStack.style.display = 'flex';
  mapStack.style.flexDirection = 'column';
  mapStack.style.gap = '4px';
  mapStack.style.marginBottom = '6px';

  const mapRowLabel = document.createElement('div');
  mapRowLabel.textContent = 'Crush map';
  mapRowLabel.style.font = '11px sans-serif';
  mapRowLabel.style.color = '#aaa';

  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_W;
  canvas.height = PREVIEW_H;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.maxWidth = '200px';
  canvas.style.height = 'auto';
  canvas.style.imageRendering = 'pixelated';
  canvas.style.border = '1px solid #333';
  canvas.style.background = '#000';

  const mapHint = document.createElement('div');
  mapHint.textContent =
    'Preview: R bend, G coherence, B spread. Trampling stacks when CPU trampling is on.';
  mapHint.style.font = '10px sans-serif';
  mapHint.style.color = '#888';

  mapStack.appendChild(mapRowLabel);
  mapStack.appendChild(canvas);
  mapStack.appendChild(mapHint);
  host.appendChild(mapStack);

  const ctxMaybe = canvas.getContext('2d');
  if (!ctxMaybe) {
    throw new Error('2D canvas context required for crush map preview');
  }
  const ctx = ctxMaybe;

  const imageData = ctx.createImageData(PREVIEW_W, PREVIEW_H);
  const data = imageData.data;

  function updatePreview(): void {
    const u8 = new Uint8Array(PREVIEW_W * PREVIEW_H * 4);
    fillCrushMapRGBA(u8, PREVIEW_W, PREVIEW_H, grassParams, FIELD_W, FIELD_H);
    applyTramplingOverlay(u8, null, PREVIEW_W, PREVIEW_H, grassParams, FIELD_W, FIELD_H);
    for (let i = 0; i < PREVIEW_W * PREVIEW_H; i++) {
      const o = i * 4;
      data[o] = u8[o];
      data[o + 1] = u8[o + 1];
      data[o + 2] = u8[o + 2];
      data[o + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  const gui = new GUI({
    title:      'Crush map',
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
      .add(grassParams, 'mowArtStripeWidthM', 2, 12, 0.1)
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

  refreshMowLayoutControls();
  refreshTrampControls();
  updatePreview();

  return {
    gui,
    host,
    updatePreview,
    dispose(): void {
      gui.destroy();
      host.remove();
    },
  };
}
