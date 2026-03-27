// FIFA Class V (UHD Broadcasting) standard field dimensions
export const FIELD_W = 105; // [m] pitch length — long axis (X)
export const FIELD_H = 68;  // [m] pitch width  — short axis (Z)

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
  simulatedCount:    32,      // SpotLights placed in the scene [qty]  (each represents a group)
  fluxPerFixture:    165_000, // luminous flux per fixture       [lm]   (FIFA LED: 150k–180k lm)
  beamAngleDeg:      30,      // full outer beam angle           [deg]  (stadiums mix 10–40 deg)
  penumbra:          0.25,    // soft-edge fraction of cone      [0–1]  (Three.js SpotLight param)

  // ── Colorimetric / physical ───────────────────────────────────────────
  colorTempK:        5600,    // CCT correlated color temperature [K]   (FIFA: 5600 K = daylight)
  cri:               85,      // CRI Ra — color rendering index  [Ra]   (FIFA Class V: ≥ 80)
  maintenanceFactor: 0.80,    // MF — light loss over time       [0–1]  (FIFA: 0.8 for new lamps)

  // ── Rig geometry ──────────────────────────────────────────────────────
  rigHeight:       50,        // mounting height above pitch     [m]    (FIFA: 45–55 m)
  ovalHalfLength:  80,        // catwalk ellipse semi-major axis [m]    (along X, long side)
  ovalHalfWidth:   55,        // catwalk ellipse semi-minor axis [m]    (along Z, short side)
};

export type LightRigParams = typeof DEFAULT_PARAMS;
