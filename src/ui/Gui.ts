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

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const fix = gui.addFolder('Fixtures');

  // Hard upper bound for simulatedCount: total lights in scene must not exceed
  // MAX_SHADER_LIGHTS (DataTexture capacity in FieldMaterial), leaving room for fillCount.
  function simHardMax(): number {
    return Math.min(params.fixtureCount, MAX_SHADER_LIGHTS - params.fillCount);
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
  const simController = fix.add(params, 'simulatedCount', 4, simHardMax(), 1)
    .name(`Simulated SpotLights  [qty, <=${MAX_SHADER_LIGHTS}]`)
    .onChange(onChange);

  fix.add(params, 'fixtureCount', 100, 450, 1)
    .name('Total fixtures  [qty]  (FIFA: 280–450)')
    .onChange(() => { clampSim(); onChange(); });

  fix.add(params, 'fillCount', 0, 8, 1)
    .name('Corner fill SpotLights  [qty]  (0–8)')
    .onChange(() => { clampSim(); onChange(); });
  fix.add(params, 'fluxPerFixture', 80_000, 220_000, 1_000)
    .name('Flux / fixture  [lm]  (FIFA: 150k–180k)')
    .onChange(onChange);
  fix.add(params, 'beamAngleDeg', 8, 45, 0.5)
    .name('Beam angle  [deg]  (stadiums: 10–40)')
    .onChange(onChange);
  fix.add(params, 'iesExponent', 0, 6, 0.5)
    .name('IES exponent  [0=uniform, 3=stadium]')
    .onChange(onChange);
  fix.add(params, 'penumbra', 0, 0.8, 0.01)
    .name('Penumbra  [0–1]')
    .onChange(onChange);

  // ── Physical / colorimetric ───────────────────────────────────────────────
  const phys = gui.addFolder('Physical');
  phys.add(params, 'colorTempK', 3_000, 7_000, 100)
    .name('CCT  [K]  (FIFA: 5600 = daylight)')
    .onChange(onChange);
  // cri and maintenanceFactor are reserved for the illuminance sensor module
  // (see config.ts for full descriptions).

  // ── Rig geometry ──────────────────────────────────────────────────────────
  const geom = gui.addFolder('Rig Geometry');
  geom.add(params, 'rigHeight', 25, 70, 0.5)
    .name('Height  [m]  (FIFA: 45–55)')
    .onChange(onChange);
  geom.add(params, 'ovalHalfLength', 60, 130, 1)
    .name('Oval semi-major axis  [m]  (X)')
    .onChange(onChange);
  geom.add(params, 'ovalHalfWidth', 40, 100, 1)
    .name('Oval semi-minor axis  [m]  (Z)')
    .onChange(onChange);

  // ── Computed values (read-only display) ───────────────────────────────────
  const computed: ComputedDisplay = {
    groupSize:        0,
    fluxPerGroup_klm: 0,
    intensity_kcd:    0,
    totalFlux_Mlm:    0,
  };

  const comp = gui.addFolder('Computed (per SpotLight)');
  const c1 = comp.add(computed, 'groupSize')
    .name('Group size  [fixtures / SpotLight]')
    .disable();
  const c2 = comp.add(computed, 'fluxPerGroup_klm')
    .name('Flux / group  [klm]')
    .disable();
  const c3 = comp.add(computed, 'intensity_kcd')
    .name('Intensity  [kcd]')
    .disable();
  const c4 = comp.add(computed, 'totalFlux_Mlm')
    .name('Total rig flux  [Mlm]')
    .disable();

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
