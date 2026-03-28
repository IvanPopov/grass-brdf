// FIFA Class V (UHD Broadcasting) standard field dimensions
export const FIELD_W = 105; // [m] pitch length — long axis (X)
export const FIELD_H = 68;  // [m] pitch width  — short axis (Z)

// Dynamic beam angle limits applied in LightRig and the GUI slider.
// Minimum 10° matches the narrowest long-throw stadium LED fixtures.
// Maximum 45° is the widest practical beam for a high-mount rig.
export const BEAM_ANGLE_MIN_DEG = 10;
export const BEAM_ANGLE_MAX_DEG = 45;

/**
 * Maximum total SpotLights the GPU field shader can process per frame.
 * Constrained by DataTexture capacity in FieldMaterial (width = this value).
 * Total simulatedCount must stay at or below this limit.
 * Increasing it requires changing FieldMaterial.MAX_LIGHTS to the same value.
 */
export const MAX_SHADER_LIGHTS = 128;

/**
 * Default lighting rig parameters for a FIFA Class V stadium.
 * All values are in SI units unless noted otherwise.
 *
 * References:
 *   - FIFA Quality Programme for Football Turf: Lighting requirements
 *   - IES LM-10 / EN 12193 measurement methodology
 */
export const DEFAULT_PARAMS = {
  // ── Fixture specification ──────────────────────────────────────────────
  fixtureCount:      312,     // total LED fixtures on the rig  [qty]  (FIFA: 280–450)
  simulatedCount:    128,      // SpotLights placed in the scene [qty]  (each represents a group)
  fluxPerFixture:    165_000, // luminous flux per fixture       [lm]   (FIFA LED: 150k–180k lm)
  beamAngleDeg:      45,      // full outer beam angle           [deg]  (stadiums mix 10–40 deg)
  // penumbra: Three.js SpotLight soft-edge fraction [0–1].
  // Real stadium fixtures have a sharp beam edge (5–10° soft zone relative to the
  // full field angle). 0.10 → penumbra zone ≈ 10% of the half-angle, which
  // corresponds to IES fixtures where intensity drops from 100% to 0% over ~3° at
  // the beam edge. Default was 0.25, which was too soft.
  // penumbra > 0 makes the beam edge soft (smoothstep from full intensity to zero).
  // Although real IES field-angle cutoffs are sharp, Three.js SpotLight holds intensity
  // constant inside the cone (unlike the cos^n rolloff of a real fixture). Using
  // penumbra ≈ 0.30 compensates: the gradual edge approximates the IES inner falloff
  // and, critically, allows adjacent simulated beams (each representing 10 real fixtures)
  // to overlap smoothly — otherwise hard-edged patches are clearly visible.
  penumbra:          0.30,    // soft-edge fraction of cone      [0–1]  (effective range 0.20–0.40)

  // ── Asymmetric beam optics — physically correct elliptical cone + visor ──────
  // Real stadium fixtures use asymmetric TIR lenses that produce an elliptical
  // beam: wider horizontally (H, along the touchline) to blend with neighbours,
  // narrower vertically (V, in the field-depth plane) to reduce stand spill.
  // Typical measured values from manufacturer IES files:
  //   Philips ArenaVision MVF403: H=35°, V=19°   → hVRatio ≈ 0.54
  //   Musco TLC-LED:              H=40°, V=20°   → hVRatio ≈ 0.50
  //
  // Default hVRatio=1.0 → circular beam (no vertical compression).
  hVRatio:           1.00,    // V/H beam ratio [0.2–1.0]  (1.0 = circular, no asymmetry)

  // Visor / barn-door cutoff margin.
  // Auto-computed per fixture: the visor clips rays aimed past the far touchline.
  // visorMarginDeg is added above that angle to allow some stand illumination.
  //   0°  = hard cutoff at field boundary
  //   5°  = ~3–5 lower rows lit (typical real stadium)
  //   89° = effectively disabled — tan(89°)≈57, never clips on any real geometry
  visorMarginDeg:    5.0,    // extra degrees above touchline for visor [deg]
  visorPenumbra:     0.30,    // soft-edge fraction of visor cutoff [0–1] (0 = hard, 1 = full fade)

  // ── Beam efficiency ───────────────────────────────────────────────────
  // The rated luminous flux (fluxPerFixture) is the TOTAL output of the LED
  // source in all directions.  Only a fraction of that flux is concentrated into
  // the specified beam cone (beamAngleDeg).  The rest goes into the penumbra,
  // backward scatter, and optical losses inside the luminaire housing.
  //
  // Definitions:
  //   η_luminaire — luminaire optical efficiency (internal losses): 0.80–0.90.
  //   η_cone      — fraction of exiting lumens within the beam cone: 0.50–0.70.
  //   beamEfficiency = η_luminaire × η_cone ≈ 0.40–0.63.
  //
  // Effect on E_h:
  //   I_peak [cd] = (groupFlux × beamEfficiency × (iesExp+1)) / solidAngle
  //   Without this factor (beamEfficiency = 1.0) the simulation yields
  //   E_h_avg ≈ 6 000 lux — 2× above the ~3 000 lux of real Class V stadiums.
  //   With beamEfficiency = 0.50, E_h_avg ≈ 3 000 lux, matching real measurements.
  beamEfficiency:    0.50,   // fraction of Φ_fixture within the beam cone [0–1]

  // ── IES-like beam profile ─────────────────────────────────────────────
  // Real stadium fixtures (e.g., Philips MVF403, Musco TLC) concentrate intensity
  // near the beam axis following a roughly cos^n angular distribution:
  //
  //   I(θ) = I_peak × w(θ)^n
  //   w(θ) = (cosθ − cosθ_max) / (1 − cosθ_max)   in [0, 1]
  //   θ_max = SpotLight.angle  (outer cone half-angle)
  //
  // Total flux is conserved by scaling:  I_peak = I_uniform × (n + 1)
  //
  // n = 0 → uniform cone (original SpotLight behaviour)
  // n = 2 → gentle Gaussian-like concentration (wide-throw fixtures)
  // n = 3 → moderate concentration (FIFA stadium floodlights, default)
  // n = 5 → narrow-throw, tight beam (long-throw HID fixtures)
  //
  // Effect on centre-field hotspot:
  //   With n=3, a point at 10.9° off-axis (beam aimed at z=−17 m,
  //   point at z=0) gets w^3 = 0.086 → 8.6% of peak instead of 100%.
  //   Combined with (n+1)=4 scaling, net factor = 0.34 vs uniform.
  //   The symmetric cross-fire accumulation at z=0 drops ~3×.
  iesExponent: 3,             // beam concentration exponent         [0–6]

  // ── Fixture photometric geometry (for GR / source luminance) ─────────
  // Nominal luminous aperture area of a single physical fixture [m²].
  // Used to convert peak intensity [cd] → source luminance [cd/m²] for
  // CIE 112 Glare Rating and for UGR / disability glare assessments.
  //
  // Reference: Philips ArenaVision LED gen3 (MVF403)
  //   Housing aperture: 540 mm × 308 mm ≈ 0.166 m²
  //   This fixture is installed at Allianz Arena, Emirates, Amsterdam ArenA,
  //   and many other UEFA Cat. 4 venues.
  //   Peak luminance on-axis: I_peak / A ≈ 700 000 cd / 0.166 m² ≈ 4.2 × 10⁶ cd/m²
  //   (realistic; typical LED stadium fixture: 1 × 10⁶ – 8 × 10⁶ cd/m²)
  fixtureLuminousArea: 0.166,  // [m²]  Philips ArenaVision LED gen3 aperture

  // Diffuse reflectance of the playing surface [0–1].
  // Used to derive the background (adaptation) luminance L_ve for CIE 112 GR:
  //   L_ve = E_h_avg × ρ / π   [cd/m²]
  // Natural grass (maintained, wet):   ρ ≈ 0.20
  // Natural grass (dry, cut short):    ρ ≈ 0.25
  // Artificial turf (FIFA Quality Pro): ρ ≈ 0.28
  // We use 0.25 — typical grass under broadcast conditions.
  fieldReflectance: 0.25,      // [0–1]  natural grass diffuse reflectance

  // ── Colorimetric / physical ───────────────────────────────────────────
  colorTempK: 5600,           // CCT correlated color temperature [K]   (FIFA: 5600 K = daylight)

  // Parameters reserved for future illuminance sensor simulation:
  //
  // cri: 85
  //   CRI Ra — Color Rendering Index [Ra], FIFA Class V requires ≥ 80.
  //   Will be needed when simulating camera/eye colour accuracy on the sensor
  //   grid; does not affect raw lux values but determines colour fidelity.
  //
  // maintenanceFactor: 0.80
  //   MF — Light Loss Factor [0–1], accounts for LED lumen depreciation and
  //   lens contamination over the lamp lifetime. FIFA specifies MF = 0.8.
  //   Applied as a scalar multiplier to computed E_h / E_v values:
  //     E_maintained = E_initial × MF
  //   Not applied to SpotLight intensity because the rendered scene shows
  //   initial (new-lamp) conditions; the sensor module will apply it.

  // ── Rig geometry ──────────────────────────────────────────────────────
  rigHeight:       50,        // mounting height above pitch     [m]    (FIFA: 45–55 m)
  ovalHalfLength:  80,        // catwalk ellipse semi-major axis [m]    (along X, long side)
  ovalHalfWidth:   55,        // catwalk ellipse semi-minor axis [m]    (along Z, short side)
};

export type LightRigParams = typeof DEFAULT_PARAMS;
