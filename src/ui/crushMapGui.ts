import GUI from 'lil-gui';
import type { GrassBRDFParams } from '../scene/GrassBRDFParams';
import { fillCrushMapRGBA } from '../crushMap/crushMap';
import { FIELD_H, FIELD_W } from '../config';

/** CPU preview resolution (independent of GPU texture size). */
const PREVIEW_W = 128;
const PREVIEW_H = 64;

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

function setArtMowEnabled(c: EnableDisable, on: boolean): void {
  if (on) {
    c.enable();
  } else {
    c.disable();
  }
}

/**
 * Top-left panel: crush map preview (CPU raster matching GPU procedural gen) and parameters.
 * Map stack is a placeholder row for additional procedural maps later.
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
    'Preview: RGB = crush (R), coherence (G), spread (B).';
  mapHint.style.font = '10px sans-serif';
  mapHint.style.color = '#888';

  mapStack.appendChild(mapRowLabel);
  mapStack.appendChild(canvas);
  mapStack.appendChild(mapHint);
  host.appendChild(mapStack);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context required for crush map preview');
  }

  const imageData = ctx.createImageData(PREVIEW_W, PREVIEW_H);
  const data = imageData.data;

  function updatePreview(): void {
    const u8 = new Uint8Array(PREVIEW_W * PREVIEW_H * 4);
    fillCrushMapRGBA(u8, PREVIEW_W, PREVIEW_H, grassParams, FIELD_W, FIELD_H);
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
    width:      280,
    container:  host,
    autoPlace:  false,
  });

  const model = gui.addFolder('Model (BRDF)');
  tip(
    model.add(grassParams, 'mowBend', 0, 1, 0.02).name('Bend strength').onChange(onChange),
    'Scales the red channel of the crush map. How strongly each blade blends toward the fully mowed tilt when map R is one. Must be greater than zero for stripe modulation (R) to affect the pitch; at zero, R is zero everywhere.',
  );
  tip(
    model.add(grassParams, 'mowCoherence', 0, 1, 0.02).name('Coherence').onChange(onChange),
    'Map G (green): anisotropic specular coherence in field.frag evaluateGrassBRDF only; it does not move the macroscopic blade normal. Use Bend (R) for crush geometry on the field and patch.',
  );
  tip(
    model.add(grassParams, 'mowSpread', 0, 1, 0.02).name('Spread').onChange(onChange),
    'Encoded in map B (blue in preview). Extra blade-to-blade orientation variance and rougher highlights (Toksvig-style spread) in field.frag.glsl.',
  );
  tip(
    model.add(grassParams, 'mowMaxTiltDeg', 30, 89, 1).name('Max tilt [deg]').onChange(onChange),
    'Maximum zenith tilt of the blade face toward the mowing travel direction when map R is one.',
  );

  const artMow = gui.addFolder('Art: mowing on map');

  tip(
    artMow.add(grassParams, 'mowArtMowingEnabled').name('Enable mowing layout').onChange(() => {
      refreshArtMowControls();
      onChange();
    }),
    'When off, the crush map is uniform over the pitch; only the Model sliders change R, G, and B. When on, optional broadcast bands and alternating lean are applied on top of the generic map.',
  );

  const cStripeW = tip(
    artMow
      .add(grassParams, 'mowArtStripeWidthM', 2, 12, 0.1)
      .name('Stripe width [m]')
      .onChange(onChange),
    'Distance along world +X between stripe boundaries [m]. FIFA quality programmes often use about 5 to 5.5 m for broadcast stripes.',
  );

  const cStripes = tip(
    artMow.add(grassParams, 'mowArtStripesEnabled').name('Alternating stripes').onChange(onChange),
    'When on, odd and even bands get opposite lean direction for classic light and dark TV stripes. Only applies if mowing layout is enabled.',
  );

  const cBendVar = tip(
    artMow
      .add(grassParams, 'mowArtStripeBendVariation', 0, 1, 0.05)
      .name('Stripe crush variation')
      .onChange(onChange),
    'How much crush strength (map R) differs between adjacent stripes. Requires Bend strength greater than zero on the pitch: R equals Bend times a per-stripe factor, so at Bend zero the field stays uniform. One means the strongest relative difference (about eight percent of R) for visibility on camera.',
  );

  function refreshArtMowControls(): void {
    const on = grassParams.mowArtMowingEnabled;
    setArtMowEnabled(cStripeW, on);
    setArtMowEnabled(cStripes, on);
    setArtMowEnabled(cBendVar, on);
  }

  refreshArtMowControls();
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
