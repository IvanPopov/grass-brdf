// FIFA Class V (UHD Broadcasting) standard field dimensions
export const FIELD_W = 105; // [m] pitch length — long axis (X)
export const FIELD_H = 68;  // [m] pitch width  — short axis (Z)

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
