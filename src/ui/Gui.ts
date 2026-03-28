import GUI from 'lil-gui';
import { LightRigParams, MAX_SHADER_LIGHTS, BEAM_ANGLE_MIN_DEG, BEAM_ANGLE_MAX_DEG } from '../config';
import { GroupPhysics } from '../lighting/LightRig';
import { GrassBRDFDebug, GrassBRDFParams, GrassPatchDebug } from '../scene/GrassBRDFParams';

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
export function buildGui(
  params: LightRigParams,
  onChange: () => void,
  grassParams: GrassBRDFParams,
  grassDebug: GrassBRDFDebug,
  patchDebug: GrassPatchDebug,
  onGrassChange: () => void,
): GuiHandle {
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
  fix.close();

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
    fix.add(params, 'beamAngleDeg', BEAM_ANGLE_MIN_DEG, BEAM_ANGLE_MAX_DEG, 0.5)
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
  phys.close();
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
  geom.close();
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
  comp.close();
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

  // ── Grass BRDF ────────────────────────────────────────────────────────────
  const grass = gui.addFolder('Grass BRDF');
  grass.close();

  tip(
    grass.add(grassParams, 'grassBRDFMode', { 'Lambertian (debug)': 0, 'Physical OBC': 1 })
      .name('BRDF mode')
      .onChange(onGrassChange),
    'Grass material model.\n' +
    '  Lambertian: simple diffuse — preserves previous look, fast.\n' +
    '  Physical OBC: Oriented-Blade Canopy BRDF with:\n' +
    '    - Turbid medium single-scattering (Ross 1981)\n' +
    '    - Campbell (1990) ellipsoidal leaf angle distribution\n' +
    '    - Hot-spot retroreflection enhancement (Chen & Cihlar 1997)\n' +
    '    - Soil visible through canopy gaps (gap fraction model)\n' +
    '    - Multiple scattering (two-stream approx., Sellers 1985)\n' +
    '    - Anisotropic GGX specular on blade face (Burley 2012)\n' +
    '    - Mowing stripe pattern from alternating blade tilt',
  );

  const canopy = grass.addFolder('Canopy structure');
  canopy.close();

  tip(
    canopy.add(grassParams, 'lai', 0.5, 8.0, 0.1)
      .name('LAI  [m²/m²]')
      .onChange(onGrassChange),
    'Leaf Area Index: one-sided leaf area per unit ground area.\n' +
    'Professional Lolium perenne pitch: 2.5–4.0  [Tegg & Lane 2004].\n' +
    'Higher LAI → darker soil, stronger hot-spot, denser striping.',
  );

  tip(
    canopy.add(grassParams, 'chiLAD', 0.1, 5.0, 0.05)
      .name('LAD χ  [—]')
      .onChange(onGrassChange),
    'Campbell (1990) ellipsoidal LAD parameter χ:\n' +
    '  χ < 1: erectophile (more vertical blades) — turf grasses, cereals\n' +
    '  χ = 1: spherical inclination distribution\n' +
    '  χ > 1: planophile (more horizontal laminae) — e.g. many broadleaf crops\n' +
    'Stadium BRDF: χ drives G(θ) for diffuse canopy. Patch blades: χ changes\n' +
    'Campbell zenith sampling only when Mowing direction is near 0.',
  );

  tip(
    canopy.add(grassParams, 'bladeHeightM', 0.010, 0.080, 0.001)
      .name('Blade height  [m]')
      .onChange(onGrassChange),
    'Grass cutting height (= canopy depth).\n' +
    'FIFA match-day standard: 25–30 mm.\n' +
    'Used with blade width to compute hot-spot rL = width / height.',
  );

  tip(
    canopy.add(grassParams, 'bladeWidthM', 0.001, 0.010, 0.0005)
      .name('Blade width  [m]')
      .onChange(onGrassChange),
    'Mean blade width for Lolium perenne: 3–6 mm.\n' +
    'Hot-spot rL = bladeWidth / bladeHeight.\n' +
    'Narrower blades → broader, softer hot-spot lobe.',
  );

  tip(
    canopy.add(grassParams, 'mowingStripeWidth', 2.0, 12.0, 0.1)
      .name('Stripe width  [m]')
      .onChange(onGrassChange),
    'Mowing stripe width in metres.\n' +
    'Adjacent stripes have blades tilted in opposite directions.\n' +
    'FIFA broadcast standard: 5.0–5.5 m.',
  );

  tip(
    canopy.add(grassParams, 'mowingStripesEnabled')
      .name('Mowing stripes')
      .onChange(onGrassChange),
    'Alternating blade lean along the pitch length (broadcast stripe pattern).\n' +
    'When off: uniform blade direction — no light/dark stripe contrast.\n' +
    'Blade-face anisotropic specular (GGX) stays active in both cases.',
  );

  tip(
    canopy.add(grassParams, 'bladeDirectionalWeight', 0.0, 1.0, 0.05)
      .name('Mowing direction  [0–1]')
      .onChange(onGrassChange),
    'Blade-face specular normal: 0 = meadow (isotropic azimuth, Campbell mean tilt from chi).\n' +
    '1 = stadium mowing (bladeTiltDeg and stripes). Intermediate values blend.\n' +
    'Diffuse canopy (Ross, gaps, MS) always uses chiLAD only.',
  );

  tip(
    canopy.add(grassParams, 'bladeTiltDeg', 30, 89, 1)
      .name('Blade tilt  [deg]')
      .onChange(onGrassChange),
    'Mowing lean: blade face tilt from vertical toward +X [degrees].\n' +
    'Used when Mowing direction > 0. At 0: meadow specular uses Campbell mean tilt from chi.\n' +
    'Typical post-cut: 60–80°.  Flattened (rain, play): 40–55°.',
  );

  const leafOpt = grass.addFolder('Leaf optics (linear sRGB)');
  leafOpt.close();

  tip(
    leafOpt.add(grassParams, 'bladeAlbedoR', 0.0, 0.3, 0.005)
      .name('Blade ρ  R')
      .onChange(onGrassChange),
    'Blade reflectance ρ_leaf, red channel (linear, not gamma).\n' +
    'LOPEX93 database for Lolium perenne: ≈ 0.045.\n' +
    'Natural grass is dark in red — chlorophyll absorption.',
  );
  tip(
    leafOpt.add(grassParams, 'bladeAlbedoG', 0.0, 0.4, 0.005)
      .name('Blade ρ  G')
      .onChange(onGrassChange),
    'Blade reflectance ρ_leaf, green channel (linear).\n' +
    'LOPEX93: ≈ 0.115.  This is the primary green appearance driver.',
  );
  tip(
    leafOpt.add(grassParams, 'bladeAlbedoB', 0.0, 0.2, 0.005)
      .name('Blade ρ  B')
      .onChange(onGrassChange),
    'Blade reflectance ρ_leaf, blue channel (linear).\n' +
    'LOPEX93: ≈ 0.025.  Low due to chlorophyll a absorption.',
  );

  tip(
    leafOpt.add(grassParams, 'bladeTransmittanceR', 0.0, 0.2, 0.005)
      .name('Blade τ  R')
      .onChange(onGrassChange),
    'Blade transmittance τ_leaf, red channel.\n' +
    'PROSPECT calibration: ≈ 0.015.  Thin blades transmit some red.',
  );
  tip(
    leafOpt.add(grassParams, 'bladeTransmittanceG', 0.0, 0.3, 0.005)
      .name('Blade τ  G')
      .onChange(onGrassChange),
    'Blade transmittance τ_leaf, green channel.\n' +
    'PROSPECT: ≈ 0.045.  Highest channel — green glow of backlit grass.\n' +
    'ω = ρ + τ is the single-scattering albedo used in canopy scattering.',
  );
  tip(
    leafOpt.add(grassParams, 'bladeTransmittanceB', 0.0, 0.15, 0.005)
      .name('Blade τ  B')
      .onChange(onGrassChange),
    'Blade transmittance τ_leaf, blue channel.\n' +
    'PROSPECT: ≈ 0.010.',
  );

  tip(
    leafOpt.add(grassParams, 'soilAlbedoR', 0.0, 0.4, 0.005)
      .name('Soil ρ  R')
      .onChange(onGrassChange),
    'Soil / infill diffuse reflectance, red channel (linear).\n' +
    'Moist sandy loam (Lobell & Asner 2002): ≈ 0.090.\n' +
    'Rubber crumb infill (artificial): 0.03–0.06.',
  );
  tip(
    leafOpt.add(grassParams, 'soilAlbedoG', 0.0, 0.4, 0.005)
      .name('Soil ρ  G')
      .onChange(onGrassChange),
    'Soil diffuse reflectance, green channel (linear).\n' +
    'Moist sandy loam: ≈ 0.075.',
  );
  tip(
    leafOpt.add(grassParams, 'soilAlbedoB', 0.0, 0.3, 0.005)
      .name('Soil ρ  B')
      .onChange(onGrassChange),
    'Soil diffuse reflectance, blue channel (linear).\n' +
    'Moist sandy loam: ≈ 0.050.',
  );

  // ── Component toggles ───────────────────────────────────────────────────────
  const dbgFolder = grass.addFolder('Components (debug toggles)');
  dbgFolder.close();

  tip(
    dbgFolder.add(grassDebug, 'dbgCanopySS')
      .name('Canopy single-scatter')
      .onChange(onGrassChange),
    'Turbid-medium single scattering from canopy blades.\n' +
    '[Ross 1981, eq. 3.43]\n' +
    'Dominant diffuse term — primary driver of canopy colour.',
  );

  tip(
    dbgFolder.add(grassDebug, 'dbgHotSpot')
      .name('Hot-spot (retroreflect.)')
      .onChange(onGrassChange),
    'Retroreflection enhancement: when light ≈ view direction,\n' +
    'illuminated and viewed gaps are correlated → no visible shadows.\n' +
    '[Chen & Cihlar 1997]\n' +
    'When off: Chs = 1.0 (base turbid-medium level, no peak).',
  );

  tip(
    dbgFolder.add(grassDebug, 'dbgSoil')
      .name('Soil background')
      .onChange(onGrassChange),
    'Lambertian soil/infill visible through canopy gaps.\n' +
    'Attenuated by gap fraction from both illumination and view paths.\n' +
    'At LAI=3.5: soil contributes ≈5–15% of total reflectance.',
  );

  tip(
    dbgFolder.add(grassDebug, 'dbgMS')
      .name('Multiple scattering')
      .onChange(onGrassChange),
    'Isotropic multiple-scattering correction (two-stream, Sellers 1985).\n' +
    'Accounts for energy missing from single-scattering approximation.\n' +
    'Typical contribution: 15–25% of total reflectance in the visible range.',
  );

  tip(
    dbgFolder.add(grassDebug, 'dbgSpecular')
      .name('Blade face specular')
      .onChange(onGrassChange),
    'Anisotropic GGX specular from the waxy blade cuticle.\n' +
    'Evaluated on the blade face normal → produces mowing stripe brightness.\n' +
    '[Burley 2012 NDF + Heitz 2014 G2 + Schlick Fresnel]\n' +
    'Disabling shows pure diffuse response.',
  );

  const specFolder = grass.addFolder('Blade specular (GGX)');
  specFolder.close();

  tip(
    specFolder.add(grassParams, 'bladeCuticleF0', 0.01, 0.08, 0.001)
      .name('Cuticle F0  [—]')
      .onChange(onGrassChange),
    'Fresnel reflectance at normal incidence.\n' +
    'Derived from cuticle wax refractive index n = 1.40 (Woolley 1971):\n' +
    '  F0 = ((1.40-1)/(1.40+1))² = 0.02778 ≈ 0.028.\n' +
    'Higher values simulate wet or artificially coated blades.',
  );

  tip(
    specFolder.add(grassParams, 'alphaT', 0.01, 0.5, 0.01)
      .name('αT  along blade axis')
      .onChange(onGrassChange),
    'Anisotropic GGX roughness along blade long axis (tangent direction).\n' +
    'Blade surface has longitudinal ridges → lower roughness along length.\n' +
    'AFM data (Koch et al. 2009): effective αT ≈ 0.10–0.20.\n' +
    'Lower value = sharper specular streak parallel to blade long axis.',
  );

  tip(
    specFolder.add(grassParams, 'alphaB', 0.1, 1.0, 0.01)
      .name('αB  across blade')
      .onChange(onGrassChange),
    'Anisotropic GGX roughness across blade width (bitangent direction).\n' +
    'Serrated margins and cell boundaries create higher roughness across blade.\n' +
    'Koch et al. 2009: effective αB ≈ 0.50–0.70.\n' +
    'Higher value = broader, more diffuse specular in the perpendicular direction.',
  );

  const patchDbg = gui.addFolder('Grass patch (debug)');
  patchDbg.close();
  tip(
    patchDbg.add(patchDebug, 'gtao').name('GTAO'),
    'Screen-space GTAO on the lower-left MeshStandard turf patch only.\n' +
    'Does not affect field.frag.glsl. Uses the same ACES + sRGB path as the main view.\n' +
    'Turn off to save GPU when the patch is not needed.',
  );

  return { gui, updateComputedDisplay };
}
