import GUI from 'lil-gui';
import { LightRigParams, MAX_SHADER_LIGHTS } from '../config';
import { GroupPhysics } from '../lighting/LightRig';

/** Read-only computed display updated after each rebuild. */
interface ComputedDisplay {
  groupSize:        number;  // [fixtures / SpotLight]
  fluxPerGroup_klm: number;  // [klm]
  intensity_kcd:    number;  // [kcd]
  totalFlux_Mlm:    number;  // [Mlm]
}

export interface GuiHandle {
  gui:                  GUI;
  updateComputedDisplay: (phys: GroupPhysics, params: LightRigParams) => void;
}

/**
 * Builds the lil-gui control panel.
 *
 * Folders:
 *   Fixtures        – fixture count, simulation count, flux, beam angle, penumbra
 *   Physical        – CCT (cri / maintenanceFactor reserved for sensor module)
 *   Rig Geometry    – height, oval dimensions
 *   Computed Values – read-only display of values derived from the above
 *
 * All labels include units in square brackets.  The `onChange` callback is
 * called after any parameter changes; the caller is responsible for rebuilding
 * the scene and then calling updateComputedDisplay() with fresh physics values.
 */
export function buildGui(params: LightRigParams, onChange: () => void): GuiHandle {
  const gui = new GUI({ title: 'Stadium Lighting (FIFA Class V)' });

  /** Sets a hover tooltip on every DOM element inside a controller. */
  function tip<T extends { domElement: Element }>(ctrl: T, text: string): T {
    ctrl.domElement.querySelectorAll('*').forEach(el => {
      (el as HTMLElement).title = text;
    });
    return ctrl;
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const fix = gui.addFolder('Fixtures');

  // Hard upper bound for simulatedCount: total lights in scene must not exceed
  // MAX_SHADER_LIGHTS (DataTexture capacity in FieldMaterial).
  function simHardMax(): number {
    return Math.min(params.fixtureCount, MAX_SHADER_LIGHTS);
  }

  // Clamp params.simulatedCount to the current hard max and refresh slider display.
  function clampSim(): void {
    const max = simHardMax();
    if (params.simulatedCount > max) {
      params.simulatedCount = max;
      simController.updateDisplay();
    }
    simController.max(max);
  }

  // simulatedCount must be declared first so the other onChange handlers can reference it.
  const simController = tip(
    fix.add(params, 'simulatedCount', 4, simHardMax(), 1)
      .name(`Simulated SpotLights  [qty]`)
      .onChange(onChange),
    `Number of SpotLights placed in the scene.\n` +
    `Each represents a group of (Total fixtures / Simulated) real fixtures.\n` +
    `Higher = finer aim distribution, closer to real-stadium coverage.\n` +
    `Hard cap: ${MAX_SHADER_LIGHTS} (GPU shader DataTexture limit).`,
  );

  tip(
    fix.add(params, 'fixtureCount', 100, 450, 1)
      .name('Total fixtures  [qty]')
      .onChange(() => { clampSim(); onChange(); }),
    'Total LED floodlight fixtures on the rig.\n' +
    'FIFA Class V: 280–450 units depending on LED model and stadium geometry.',
  );

  tip(
    fix.add(params, 'fluxPerFixture', 80_000, 220_000, 1_000)
      .name('Flux / fixture  [lm]')
      .onChange(onChange),
    'Total luminous flux of one LED fixture (all directions combined).\n' +
    'FIFA Class V: 150 000–180 000 lm per fixture.\n' +
    'Only the fraction defined by Beam efficiency reaches the field.',
  );

  tip(
    fix.add(params, 'beamEfficiency', 0.10, 1.0, 0.05)
      .name('Beam efficiency  [0–1]')
      .onChange(onChange),
    'Fraction of rated fixture lumens that falls within the beam cone.\n' +
    'Rated flux covers the full IES distribution; only ~50% reaches\n' +
    'within the specified beam angle.  Real LED fixtures: 0.40–0.63.\n' +
    'Use 1.0 for a theoretical perfect concentrator.',
  );

  tip(
    fix.add(params, 'beamAngleDeg', 8, 45, 0.5)
      .name('Ref. beam angle  [deg]')
      .onChange(onChange),
    'Reference beam angle for a nominal 70 m throw distance.\n' +
    'The actual angle is scaled inversely with throw distance (fanning) so that\n' +
    'the projected spot size remains roughly constant across the pitch.\n' +
    'Wider reference angles (40-45°) improve uniformity at the cost of peak intensity.',
  );

  tip(
    fix.add(params, 'iesExponent', 0, 6, 0.5)
      .name('IES exponent  [n]')
      .onChange(onChange),
    'Power-cosine beam concentration exponent.\n' +
    '  n = 0 : uniform cone (flat intensity, Three.js default).\n' +
    '  n = 2 : gentle Gaussian-like rolloff (wide-throw fixtures).\n' +
    '  n = 3 : moderate concentration (typical LED stadium floodlight).\n' +
    '  n = 5 : tight narrow-throw beam (long-range HID fixtures).\n' +
    'Flux is conserved: I_peak = I_uniform × (n + 1).',
  );

  tip(
    fix.add(params, 'penumbra', 0, 0.8, 0.01)
      .name('Penumbra  [0–1]')
      .onChange(onChange),
    'Three.js SpotLight soft-edge fraction.\n' +
    '0 = hard cutoff at beam angle.  1 = the entire cone is a soft gradient.\n' +
    'Real stadium fixtures: 0.05–0.15 (sharp edge with a short transition zone).\n' +
    'Higher values help overlap adjacent grouped beams more smoothly.',
  );

  tip(
    fix.add(params, 'hVRatio', 0.2, 1.0, 0.05)
      .name('V/H angle ratio')
      .onChange(onChange),
    'Vertical-to-horizontal beam half-angle ratio (TIR asymmetric lens).\n' +
    '1.0 = circular beam (no asymmetry, default).\n' +
    '0.5 = V half-angle is 50% of H — typical LED stadium fixture.\n' +
    'Philips ArenaVision MVF403: ~0.54.  Musco TLC-LED: ~0.50.',
  );

  tip(
    fix.add(params, 'visorMarginDeg', 0, 89, 0.5)
      .name('Visor margin [deg]')
      .onChange(onChange),
    'Extra degrees above the far touchline the barn-door visor allows through.\n' +
    '89 = disabled (tan(89)>>1, never clips) — default safe value.\n' +
    ' 0 = hard cutoff at field boundary (no stand spill at all).\n' +
    ' 5 = ~3-5 lower rows lit (typical UEFA/FIFA Class V rig).',
  );

  tip(
    fix.add(params, 'visorPenumbra', 0, 1, 0.05)
      .name('Visor penumbra')
      .onChange(onChange),
    'Soft-edge width of the visor cutoff as a fraction of the cutoff angle.\n' +
    '0.0 = hard step (unphysical).\n' +
    '0.3 = fade starts at 70% of cutoff angle — matches real barn-door penumbra.\n' +
    '1.0 = fade spans the full range from beam axis to cutoff.',
  );

  // ── Physical / colorimetric ───────────────────────────────────────────────
  const phys = gui.addFolder('Physical');
  tip(
    phys.add(params, 'colorTempK', 1_500, 12_000, 100)
      .name('CCT  [K]')
      .onChange(onChange),
    'Correlated Colour Temperature of the fixtures.\n' +
    '  1 500 K – candlelight / very warm tungsten\n' +
    '  3 000 K – halogen stadium lamp (older rigs)\n' +
    '  4 000 K – metal-halide\n' +
    '  5 600 K – FIFA Class V daylight target (D55)  ← default\n' +
    '  6 500 K – D65 standard daylight\n' +
    ' 12 000 K – clear blue sky\n' +
    'Luminance-normalised: changing CCT shifts hue, not brightness.',
  );
  // cri and maintenanceFactor are reserved for the illuminance sensor module
  // (see config.ts for full descriptions).

  // ── Rig geometry ──────────────────────────────────────────────────────────
  const geom = gui.addFolder('Rig Geometry');
  tip(
    geom.add(params, 'rigHeight', 25, 70, 0.5)
      .name('Height  [m]')
      .onChange(onChange),
    'Mounting height of the catwalk above the pitch surface.\n' +
    'FIFA Class V: 45–55 m (minimum 30 m).\n' +
    'Higher rigs improve glare angle but reduce illuminance (r² law).',
  );
  tip(
    geom.add(params, 'ovalHalfLength', 60, 130, 1)
      .name('Oval semi-major axis  [m]  (X)')
      .onChange(onChange),
    'Half-length of the elliptical catwalk along the field long axis (X).\n' +
    'Larger value spreads lights further behind the goals.\n' +
    'Field half-length = 52.5 m; keeping this ≤ 80–90 m limits glare angles.',
  );
  tip(
    geom.add(params, 'ovalHalfWidth', 40, 100, 1)
      .name('Oval semi-minor axis  [m]  (Z)')
      .onChange(onChange),
    'Half-width of the elliptical catwalk along the field short axis (Z).\n' +
    'Larger value moves lights further from the touchlines.\n' +
    'Field half-width = 34 m; typical catwalk offset: 15–25 m beyond touchline.',
  );

  // ── Computed values (read-only display) ───────────────────────────────────
  const computed: ComputedDisplay = {
    groupSize:        0,
    fluxPerGroup_klm: 0,
    intensity_kcd:    0,
    totalFlux_Mlm:    0,
  };

  const comp = gui.addFolder('Computed (per SpotLight)');
  const c1 = tip(
    comp.add(computed, 'groupSize').name('Group size  [fix / SpotLight]').disable(),
    'Real fixtures represented by one simulated SpotLight.\n' +
    '= ceil(Total fixtures / Simulated SpotLights)',
  );
  const c2 = tip(
    comp.add(computed, 'fluxPerGroup_klm').name('Flux / group  [klm]').disable(),
    'Total rated flux of one group = Group size × Flux per fixture.\n' +
    'Multiply by Beam efficiency to get lumens actually in the cone.',
  );
  const c3 = tip(
    comp.add(computed, 'intensity_kcd').name('Ref. intensity  [kcd]').disable(),
    'Baseline luminous intensity for the reference beam angle.\n' +
    'Actual intensity varies dynamically per-fixture based on throw distance\n' +
    'so that narrow beams produce more Candela to overcome r² loss.',
  );
  const c4 = tip(
    comp.add(computed, 'totalFlux_Mlm').name('Total rig flux  [Mlm]').disable(),
    'Total rated luminous flux of the entire rig.\n' +
    '= Total fixtures × Flux per fixture  [Mlm]\n' +
    'Does NOT include Beam efficiency or Maintenance Factor.',
  );

  function updateComputedDisplay(phys: GroupPhysics, p: LightRigParams): void {
    computed.groupSize        = phys.groupSize;
    computed.fluxPerGroup_klm = Math.round(phys.fluxPerGroup / 1_000);
    computed.intensity_kcd    = Math.round(phys.intensity    / 1_000);
    computed.totalFlux_Mlm    = parseFloat(
      ((p.fixtureCount * p.fluxPerFixture) / 1_000_000).toFixed(2),
    );
    c1.updateDisplay();
    c2.updateDisplay();
    c3.updateDisplay();
    c4.updateDisplay();
  }

  return { gui, updateComputedDisplay };
}
