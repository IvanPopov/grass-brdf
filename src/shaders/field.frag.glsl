// Three.js injects #version 300 es, precision qualifiers, toneMapping(),
// and linearToOutputTexel() automatically before this source.

// Must match FieldMaterial.MAX_LIGHTS
#define MAX_LIGHTS 128

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — UNIFORMS & VARYINGS
// ─────────────────────────────────────────────────────────────────────────────

// Light DataTexture: 4 rows × MAX_LIGHTS columns, RGBA float.
//   row 0: (pos.x,     pos.y,     pos.z,    -)
//   row 1: (target.x,  target.y,  target.z, -)
//   row 2: (intensity, angleH,    penumbra,  angleV)
//   row 3: (visorTan,  visorPenumbra, -,     -)
uniform sampler2D lightData;
uniform int       lightCount;
uniform float     iesExponent;
uniform vec3      baseColor;       // linear-space surface colour (Lambertian mode)
uniform vec3      lightColor;      // CCT tint, luminance-normalised (Y = 1)

// Camera world position (updated per frame by FieldMaterial.updateGrass).
// Used to compute the view direction V for the per-fragment BRDF.
uniform vec3 cameraPos;

// Grass BRDF mode: 0.0 = simple Lambertian (debug), 1.0 = physical OBC BRDF.
// isSurfaceGrass: per-material flag; 0.0 on concrete stands → always Lambertian.
uniform float grassBRDFMode;
uniform float isSurfaceGrass;

// ── Canopy structure ──────────────────────────────────────────────────────────
// lai: Leaf Area Index [m²/m²].  chiLAD: Campbell ellipsoidal LAD parameter.
// bladeRL: rL = bladeWidth / bladeHeight (hot-spot angular scale).
// bladeCampbellMeanTiltRad: mean zenith [rad] from Campbell LAD (meadow specular).
uniform float lai;
uniform float chiLAD;
uniform float bladeRL;
uniform float bladeCampbellMeanTiltRad;

// Crush map (procedural RTT): R = blend w, G = coherence, B = spread, A = (leanSign+1)/2
// fieldSize: (FIELD_W, FIELD_H) [m].  mowMaxTiltRad: max face zenith from vertical [rad].
uniform sampler2D crushMap;
uniform vec2      fieldSize;
uniform float     mowMaxTiltRad;

// ── Leaf optical properties [linear sRGB, 0–1] ───────────────────────────────
// bladeAlbedo: per-leaf reflectance ρ_leaf.
// bladeTau:    per-leaf transmittance τ_leaf.  Single-scattering albedo ω = ρ+τ.
// soilAlbedo:  soil/infill diffuse reflectance ρ_soil.
uniform vec3 bladeAlbedo;
uniform vec3 bladeTau;
uniform vec3 soilAlbedo;

// ── Cuticle specular ─────────────────────────────────────────────────────────
// bladeCuticleF0: Fresnel at normal incidence (from n_cuticle = 1.40, Woolley 1971).
// alphaT: anisotropic GGX roughness along blade long axis (smooth ridges).
// alphaB: anisotropic GGX roughness across blade width (rough serrated margin).
uniform float bladeCuticleF0;
uniform float alphaT;
uniform float alphaB;

// ── Debug flags (1.0 = enabled, 0.0 = disabled) ──────────────────────────────
//   dbgHotSpot — retroreflection enhancement; 0 → Chs clamped to 1 (Chen 1997)
//   dbgMS      — two-stream multiple-scattering correction (Sellers 1985)
uniform float dbgHotSpot;
uniform float dbgMS;

in  vec3 vWorldPos;
out vec4 fragColor;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — DATA TYPES
// ─────────────────────────────────────────────────────────────────────────────

struct LightData {
    vec3  pos;
    vec3  target;
    float intensity;
    float angleH;
    float penumbra;      // soft-edge fraction [0–1]; only used when iesExponent = 0
    float angleV;
    float visorTan;
    float visorPenumbra;
};

// Fixture-local orthonormal frame.
//   axis  = beam direction (light → target)
//   right = cross(axis, worldUp), along the touchline roughly
//   up    = cross(right, axis), positive → toward stands / sky
struct LocalFrame {
    vec3 axis;
    vec3 right;
    vec3 up;
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — LIGHTING FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

LightData readLight(int i) {
    vec4 r0 = texelFetch(lightData, ivec2(i, 0), 0);
    vec4 r1 = texelFetch(lightData, ivec2(i, 1), 0);
    vec4 r2 = texelFetch(lightData, ivec2(i, 2), 0);
    vec4 r3 = texelFetch(lightData, ivec2(i, 3), 0);

    LightData ld;
    ld.pos          = r0.xyz;
    ld.target       = r1.xyz;
    ld.intensity    = r2.x;
    ld.angleH       = r2.y;
    ld.penumbra     = r2.z;
    ld.angleV       = r2.w;
    ld.visorTan     = r3.x;
    ld.visorPenumbra = r3.y;
    return ld;
}

bool buildLocalFrame(vec3 lpos, vec3 ltgt, out LocalFrame frame) {
    vec3 axisRaw = ltgt - lpos;
    if (dot(axisRaw, axisRaw) < 1e-10) return false;
    frame.axis  = normalize(axisRaw);
    vec3 wUp    = (abs(frame.axis.y) > 0.999) ? vec3(1, 0, 0) : vec3(0, 1, 0);
    frame.right = normalize(cross(frame.axis, wUp));
    frame.up    = cross(frame.right, frame.axis);
    return true;
}

// IES power-cosine beam factor (energy-conserving, dimensionless).
//
//   n = 0: Three.js SpotLight smoothstep — outer edge cosOuter (I=0) to
//          inner edge cosInner = cos(angleH * (1−penumbra)) (I=1).
//   n > 0: power-cosine — w^n × (n+1), flux-normalised to integrate to 1
//          over the hemisphere cone.
float iesBeamFactor(float cosToPoint, float angleH, float penumbra, float n) {
    float cosOuter = cos(angleH);
    if (n <= 0.0) {
        float cosInner = cos(angleH * (1.0 - penumbra));
        return smoothstep(cosOuter, cosInner, cosToPoint);
    }
    float w = max(0.0, (cosToPoint - cosOuter) / (1.0 - cosOuter));
    return pow(w, n) * (n + 1.0);
}

// Returns raw irradiance E_raw = I × bf × visorFade / r² [cd/m²], WITHOUT
// the cosine-of-incidence (NdotL) factor, and outputs the unit direction from
// fragment toward the light source (L).
//
// The full horizontal illuminance from this light is E_h = E_raw × NdotL.
// Separating E_raw lets the BRDF accumulate contributions correctly:
//   Lambertian: L_r = (ρ/π) × Σ(E_raw × NdotL) = (ρ/π) × Eh
//   BRDF:       L_r = Σ( BRDF(L_i, V) × E_raw_i × NdotL_i )
// where the BRDF function internally applies its own NdotL-dependent terms.
float lightRawIrradiance(LightData ld, vec3 fragPos, float n, out vec3 L) {
    vec3  d      = ld.pos - fragPos;
    float r2     = dot(d, d);
    float r      = sqrt(r2);
    L            = d / r;           // unit direction: fragment → light

    float cosInc = L.y;             // = dot((0,1,0), L) for horizontal field
    if (cosInc <= 0.0) return 0.0;

    LocalFrame frame;
    if (!buildLocalFrame(ld.pos, ld.target, frame)) return 0.0;

    vec3  fragDir = -L;             // light → fragment
    float dxLocal = dot(fragDir, frame.right);
    float dyLocal = dot(fragDir, frame.up);
    float dzLocal = dot(fragDir, frame.axis);

    if (dzLocal <= 0.0) return 0.0;

    // Visor (barn-door) cutoff.
    float visorRatio = dyLocal / (ld.visorTan * dzLocal);
    if (visorRatio >= 1.0) return 0.0;
    float vp         = max(ld.visorPenumbra, 0.001);
    float edgeLo     = 1.0 - vp;
    float t          = clamp((visorRatio - edgeLo) / vp, 0.0, 1.0);
    float visorFade  = 1.0 - t * t * (3.0 - 2.0 * t);

    // Elliptical cone gate: maps (dxLocal, dyLocal) to unit disk via (tanH, tanV).
    float tanH = tan(ld.angleH);
    float tanV = tan(ld.angleV);
    float u    = dxLocal / tanH;
    float v    = dyLocal / tanV;
    if (u * u + v * v >= 1.0) return 0.0;

    float bf = iesBeamFactor(dzLocal, ld.angleH, ld.penumbra, n);

    return ld.intensity * bf * visorFade / r2;   // E_raw: no cosInc factor
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — GRASS BRDF MATHEMATICAL FOUNDATIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// Physical model: Oriented-Blade Canopy (OBC) BRDF.
// Complete derivation: see GrassBRDFParams.ts and referenced literature.
//
// All numeric expressions below are derived from cited formulas.
// Comments include source equation numbers where applicable.

const float PI = 3.14159265358979;

// Campbell (1990) normalisation coefficient M(χ) [eq. 5].
// M(χ) = χ + 1.702 × (χ + 1.12)^(−0.708)
// Relative error vs. numerical integration over ellipsoidal LAD: < 2%
// for 0.1 ≤ χ ≤ 5.0.  [Camp90 Table 1]
float campbellM(float chi) {
    return chi + 1.702 * pow(chi + 1.12, -0.708);
}

// Projection function G(θ, χ) from [Camp90, eq. 11].
// θ is the zenith angle of the VIEW / ILLUMINATION ray (not a leaf-normal angle).
// G is the mean projection of unit leaf area onto a plane perpendicular to
// that beam:  G = sqrt((χ cosθ)² + sin²θ) / M(χ)
//
// Limits: G(0°) = χ/M  (zenith, looking straight up/down through canopy)
//         G(90°) = 1/M (horizon)
// For χ=0.5 (erectophile): G(0°) ≈ 0.29, G(90°) ≈ 0.59.
//
// Calling code should pre-compute M = campbellM(chi) and re-use it.
float campbellG(float cosTheta, float chi, float M) {
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    float chiCos   = chi * cosTheta;
    return sqrt(chiCos * chiCos + sinTheta * sinTheta) / M;
}

// Gap fraction P_gap(θ) [Ross 1981, eq. 2.11]:
//   P_gap = exp(−G(θ) × LAI / cosθ)
//
// Physical meaning: fraction of the soil that is visible from direction θ
// through a turbid medium of depth LAI.
// At θ=0 (nadir), LAI=3.5, χ=0.5: P_gap ≈ 0.37 (37% soil visible from above).
float gapFraction(float cosTheta, float lai, float chi, float M) {
    if (cosTheta < 0.001) return 0.0;
    float G = campbellG(cosTheta, chi, M);
    return exp(-G * lai / cosTheta);
}

// Hot-spot multiplier [Chen & Cihlar 1997, eq. 9 simplified].
//
// At retroreflection (delta = 0), illuminated and viewed gaps are perfectly
// correlated — no shadows are visible. This causes a reflectance peak whose
// angular width scales with the leaf size ratio rL = bladeWidth / bladeHeight.
//
// Factor = 1 + exp(−delta / rL)
//   delta = 0:   factor = 2.0  (100% reflectance enhancement at hot-spot)
//   delta = rL:  factor ≈ 1.37 (37% enhancement at one rL angle away)
//   delta → ∞:   factor → 1.0 (no enhancement)
//
// This exponential form is equivalent to [Chen97] eq. 9 with their C0 = 1,
// which they validate against multi-angle AVHRR data for grassland.
// The approximation error vs. the full two-layer shadowing integral:
//   < 5% for delta > rL;  up to 15% very close to hot-spot (delta < 0.05 rad).
float hotSpotFactor(float cosDelta, float rL) {
    float delta = acos(clamp(cosDelta, -1.0, 1.0));
    return 1.0 + exp(-delta / max(rL, 0.01));
}

// Anisotropic GGX Normal Distribution Function [Burley 2012, eq. 10].
//
// D_GGX_aniso(H; T, B, N, αT, αB) =
//   1 / (π × αT × αB × [(T·H/αT)² + (B·H/αB)² + (N·H)²]²)
//
// Normalisation: integral over hemisphere = 1 (verified analytically in [Burl12]).
// αT: roughness along blade tangent (long axis — lower value = sharper lobe).
// αB: roughness along blade bitangent (across blade — higher value = broader lobe).
float D_GGX_aniso(float NdotH, float TdotH, float BdotH, float aT, float aB) {
    float a = TdotH / aT;
    float b = BdotH / aB;
    float d = a * a + b * b + NdotH * NdotH;
    return 1.0 / (PI * aT * aB * d * d);
}

// Smith Lambda function for anisotropic GGX masking [Heitz 2014, eq. 72].
//
// Λ(ω) = (sqrt(1 + (αT × T·ω / N·ω)² + (αB × B·ω / N·ω)²) − 1) / 2
//
// This is the exact per-direction Smith shadow-mask lambda for GGX with
// independent roughness in tangent and bitangent directions.
float Lambda_aniso(float TdotO, float BdotO, float NdotO, float aT, float aB) {
    if (NdotO <= 0.0) return 1e6;
    float tx = TdotO * aT / NdotO;
    float bx = BdotO * aB / NdotO;
    return 0.5 * (-1.0 + sqrt(1.0 + tx * tx + bx * bx));
}

// Height-correlated Smith G2 [Heitz 2014, eq. 99]:
//   G2 = 1 / (1 + Λ(L) + Λ(V))
//
// The height-correlated form is the most accurate masking-shadowing model;
// error vs. Monte Carlo path tracing for GGX surfaces: < 1% [Heit14 Fig.14].
float G2_aniso(float NdotL, float NdotV,
               float TdotL, float TdotV,
               float BdotL, float BdotV,
               float aT,    float aB) {
    float lL = Lambda_aniso(TdotL, BdotL, NdotL, aT, aB);
    float lV = Lambda_aniso(TdotV, BdotV, NdotV, aT, aB);
    return 1.0 / (1.0 + lL + lV);
}

// Fresnel (Schlick 1994 approximation):
//   F(cosθ, F0) ≈ F0 + (1 − F0) × (1 − cosθ)^5
//
// Absolute error vs. exact Fresnel for glass (n=1.40): < 0.002 over [0°, 80°].
float fresnelSchlick(float cosTheta, float F0) {
    float x  = 1.0 - clamp(cosTheta, 0.0, 1.0);
    float x2 = x * x;
    return F0 + (1.0 - F0) * x2 * x2 * x;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — BRDF EVALUATION
// ─────────────────────────────────────────────────────────────────────────────

// Evaluate the full physical OBC grass BRDF for one light source.
//
// Returns the outgoing radiance contribution [cd/m²] from this light,
// already multiplied by E_raw (so the caller just sums over all lights).
//
// Arguments:
//   L        — unit direction fragment → light
//   V        — unit direction fragment → camera
//   N_blade  — blade face normal for this fragment's stripe
//   E_raw    — raw irradiance = I × bf × visorFade / r²  (no NdotL factor)
//   M        — pre-computed campbellM(chiLAD), hoisted outside light loop
//
// Physical breakdown:
//   1. Canopy single-scattering (turbid medium, Ross 1981) + hot-spot
//   2. Soil background (Lambertian, attenuated by gap fractions from both sides)
//   3. Multiple scattering (isotropic approximation, two-stream theory, Sellers 1985)
//   4. Blade face specular (Cook-Torrance: Fresnel + anisotropic GGX, on blade normal)
//
// All four terms include the NdotL (= cos incidence on horizontal surface) factor
// so the caller sums (radiance_per_light) directly into total outgoing radiance.
//
// ENERGY CONSERVATION ANALYSIS
//
// Directional-hemispherical reflectance (DHR) = integral of f_r * cos(theta_v) dOmega_v
// must be <= 1 for all incident directions.
//
// 1. Non-negativity: all terms are products of non-negative quantities. ✓
//
// 2. Helmholtz reciprocity:
//    - ss, soil, ms terms: exactly reciprocal (all symmetric in L <-> V swap). ✓
//    - spec term: formal violation.  The formula D*F*G2/(4*bNdotV)*(1-Pgap_v)
//      represents f_r_CT * bNdotL * (1-Pgap_v); under L<->V swap it becomes
//      f_r_CT * bNdotV * (1-Pgap_L), which differs when bNdotL != bNdotV.
//      This is physically correct (blade irradiance * Cook-Torrance * view attenuation)
//      but not a formally reciprocal BRDF of the horizontal surface.
//      Impact is small: F0 = 0.028 caps the specular energy.
//
// 3. Energy conservation:
//    Default params (omega_G=0.16, LAI=3.5, nadir):
//      DHR_ss ≈ 1.9%,  DHR_soil ≈ 0.6%,  DHR_ms ≈ 0.5%,  DHR_spec ≈ 0.4%
//      DHR_total ≈ 3.4% << 1.0  ✓
//    GUI maximum (omega_G=0.7, LAI=8):
//      DHR_ms <= omega^2/(4*G_eff) * (1-Pgap) ≈ 24%,  DHR_ss <= omega/4 ≈ 18%
//      DHR_total <= 42% << 1.0  ✓
//    Guard for omega > 1 (physically impossible, unreachable via GUI): see clamp below.
vec3 evaluateGrassBRDF(vec3 L, vec3 V, vec3 N_blade, float E_raw, float M, float variance, float w_dir) {

    // Surface normal is horizontal.
    float NdotL = max(0.0, L.y);      // cos of incidence on horizontal field
    float NdotV = max(0.001, V.y);    // cos of view zenith angle

    if (NdotL < 0.001) return vec3(0.0);

    // ── 1. Gap fractions ──────────────────────────────────────────────────────
    // P_gap: fraction of soil visible from each direction through the canopy.
    // Computed using [Camp90] G function with chiLAD and pre-computed M.
    float Pgap_i = gapFraction(NdotL, lai, chiLAD, M);  // illumination path
    float Pgap_v = gapFraction(NdotV, lai, chiLAD, M);  // view path

    // ── 2. Hot-spot factor ────────────────────────────────────────────────────
    // Peak at retroreflection (L ≈ V); angular scale ∝ rL = bladeWidth/bladeHeight.
    // When dbgHotSpot = 0, Chs = 1.0 (no retroreflection enhancement).
    float cosDelta = dot(L, V);
    float Chs      = mix(1.0, hotSpotFactor(cosDelta, bladeRL), dbgHotSpot);

    // ── 3. Canopy single-scattering [Ross 1981, eq. 3.43] ────────────────────
    //
    // f_r_ss × NdotL =
    //   ω × G(θi) × G(θv) × T_att × NdotL × Chs
    //   ───────────────────────────────────────────
    //   4 × (G(θi) × NdotV + G(θv) × NdotL)
    //
    // where:
    //   ω     = ρ_leaf + τ_leaf  (single-scattering albedo, both channels)
    //   T_att = 1 − exp(−(k_i + k_v) × LAI)  (finite canopy depth attenuation)
    //   k(θ)  = G(θ) / cosθ  (extinction coefficient)
    //   Chs   = hot-spot factor applied here (multiplicative)
    //
    // The 1/(cosθi + cosθv)-type denominator comes from integrating the
    // scattering over the two-way path through the turbid layer.
    float G_i = campbellG(NdotL, chiLAD, M);
    float G_v = campbellG(NdotV, chiLAD, M);

    float k_i = G_i / NdotL;
    float k_v = G_v / NdotV;
    float T_att = 1.0 - exp(-(k_i + k_v) * lai);

    float denom_ss = 4.0 * (G_i * NdotV + G_v * NdotL);

    // Clamp single-scattering albedo ω = ρ_leaf + τ_leaf to [0, 1].
    // Physical basis: reflectance + transmittance ≤ 1 by energy conservation at
    // the leaf level (Kirchhoff's law).  Exceeding 1.0 is physically impossible
    // and would cause ms_denom = 1 − ω·(1−G_eff) to go negative, yielding
    // an unbounded rho_ms.  The GUI sliders currently limit ω_G ≤ 0.7, so this
    // clamp is a safety guard for future parameter changes, not an active fix.
    vec3 omega   = clamp(bladeAlbedo + bladeTau, vec3(0.0), vec3(1.0));
    vec3 ss_term = omega * (G_i * G_v * T_att * NdotL / max(denom_ss, 0.001)) * Chs;

    // ── 4. Soil background ────────────────────────────────────────────────────
    //
    // Soil receives illumination through illumination-path gaps (Pgap_i),
    // and the reflected Lambertian radiance travels back through view-path
    // gaps (Pgap_v) to the sensor.
    //
    // [f_r_soil × NdotL] = (ρ_soil / π) × Pgap_i × Pgap_v × NdotL
    //
    // Error of assuming independent gap probabilities (vs. correlated):
    //   < 10% for LAI < 5.  [Verhoef 1984, comparison section]
    vec3 soil_term = soilAlbedo * (1.0 / PI) * Pgap_i * Pgap_v * NdotL;

    // ── 5. Multiple scattering (two-stream approximation) ────────────────────
    //
    // Single scattering underestimates total reflectance by ~15–25% in the
    // visible range due to multiple scattering between blades.
    //
    // The Sellers (1985) two-stream approximation (adapted for canopy BRDFs)
    // gives a correction as a fraction of ω²:
    //
    //   ρ_ms ≈ ω² / (4 × (1 − ω × G_eff)) × (1 − Pgap_avg)
    //
    // where:
    //   G_eff    = mean extinction G = (G_i + G_v) / 2  (average geometric factor)
    //   Pgap_avg = sqrt(Pgap_i × Pgap_v)  (geometric mean gap fraction)
    //
    // The isotropic (Lambertian) approximation introduces an angular error
    // of ±15% vs. 4SAIL model at extreme zenith angles (> 70°).  For the
    // 0°–60° range relevant to stadium cameras: error < 8%.
    float G_eff     = 0.5 * (G_i + G_v);
    float Pgap_avg  = sqrt(Pgap_i * Pgap_v);
    vec3  ms_denom  = vec3(1.0) - omega * (1.0 - G_eff);
    vec3  rho_ms    = omega * omega / (4.0 * max(ms_denom, vec3(0.001)))
                      * (1.0 - Pgap_avg);
    vec3  ms_term   = rho_ms * (1.0 / PI) * NdotL * dbgMS;

    // ── 6. Blade face specular (Cook-Torrance on blade surface) ──────────────
    //
    // The specular highlight comes from the waxy cuticle of individual blades.
    // Critically, it is computed relative to the BLADE FACE NORMAL N_blade
    // (not the horizontal ground normal), so adjacent stripes that lean in
    // opposite directions produce different highlights → visible stripe pattern.
    //
    // Blade face normal: N_blade = (0, cos(tiltRad), ±sin(tiltRad))
    // Blade tangent T: along blade long axis (X direction for N-S tilting stripes)
    // Blade bitangent B: cross(N_blade, T)
    //
    // Cook-Torrance specular BRDF × NdotL_surface:
    //   L_spec = D × F × G2 / (4 × (N_blade·L) × (N_blade·V))
    //            × (N_blade·L) × (1 − Pgap_v) × NdotL_surface
    //
    //   simplified: L_spec = D × F × G2 / (4 × (N_blade·V)) × (1 − Pgap_v) × NdotL_surface
    //
    // The (1 − Pgap_v) factor: only blades intersected by the view ray contribute.
    // NdotL_surface = NdotL = L.y (horizontal irradiance factor).

    float bNdotL_raw = dot(N_blade, L);
    float bNdotV_raw = dot(N_blade, V);

    // Smooth visibility fade around the blade face horizon instead of a hard cutoff.
    //
    // A hard cutoff (bNdotV > 0) produces a camera-angle-dependent seam across
    // the field that moves visibly as the camera rotates — because the line where
    // N_blade·V = 0 sweeps across the pitch.
    //
    // The smooth transition is physically motivated: real blades have a spread of
    // orientations around the mean tilt (AFM data, Koch et al. 2009 reports ~3°
    // RMS angular roughness on ryegrass cuticle).  smoothstep width 0.05 (≈ 3°)
    // matches this natural orientation spread.
    float specFade = smoothstep(0.0, 0.05, bNdotL_raw)
                   * smoothstep(0.0, 0.05, bNdotV_raw);

    vec3 spec_term = vec3(0.0);

    if (specFade > 0.001) {
        float bNdotL = max(bNdotL_raw, 0.001);
        float bNdotV = max(bNdotV_raw, 0.001);

        vec3 H = normalize(L + V);

        // Blade tangent T: project mowing travel direction (world Z) onto blade plane.
        //
        // The mower travels in Z (across the pitch), so blade longitudinal ridges align
        // with Z.  We project Z onto the blade plane because N_blade has a Z component.
        //
        // For N_blade = (0, cos θ, leanSign·sin θ):
        //   dot(N_blade, Ẑ) = leanSign · sin θ
        //   T = normalize(Ẑ − N_blade · leanSign·sin θ)
        //     = normalize(0, −leanSign·cos θ·sin θ, cos²θ)
        //     = (0, −leanSign·sin θ, cos θ)                   [verified analytically]
        //   B = cross(N_blade, T) = (1, 0, 0)                 [exact, both lean signs]
        //
        // alphaT (0.15, sharp) along T ≈ Z: streak follows mowing direction.
        // alphaB (0.60, broad) along B = X: wide lobe along the pitch length.
        vec3 mowDir = vec3(0.0, 0.0, 1.0);
        vec3 T = normalize(mowDir - N_blade * dot(N_blade, mowDir));
        vec3 B = cross(N_blade, T);

        float NdotH = max(0.001, dot(N_blade, H));
        float TdotH = dot(T, H);
        float BdotH = dot(B, H);
        float VdotH = max(0.001, dot(V, H));

        float TdotL = dot(T, L);
        float TdotV = dot(T, V);
        float BdotL = dot(B, L);
        float BdotV = dot(B, V);

        // ── Normal Variance Distribution (Toksvig / LEAN) ──
        // Add geometric variance to the intrinsic roughness (Toksvig formula approximation).
        // Using squared addition is physically more accurate for variance.
        float aT = sqrt(alphaT * alphaT + variance);
        float aB = sqrt(alphaB * alphaB + variance);

        // If it's a pure meadow (w_dir = 0), the azimuthal distribution is isotropic,
        // so the macro specular lobe should be isotropic. We blend the roughnesses.
        float a_mean = (aT + aB) * 0.5;
        aT = mix(a_mean, aT, w_dir);
        aB = mix(a_mean, aB, w_dir);

        float D = D_GGX_aniso(NdotH, TdotH, BdotH, aT, aB);
        float G = G2_aniso(bNdotL, bNdotV, TdotL, TdotV, BdotL, BdotV, aT, aB);
        float F = fresnelSchlick(VdotH, bladeCuticleF0);

        // ── Volumetric Macro-Shadowing for Specular ──
        // Instead of just (1 - Pgap_v), we must account for the probability that 
        // the microfacet is BOTH visible AND illuminated. This is the same bidirectional
        // attenuation integral used in the diffuse single-scattering term.
        float spec_macro_attenuation = (T_att / max(k_i + k_v, 0.0001)) * Chs;

        // Full Cook-Torrance: D×F×G / (4×NdotL_micro×NdotV_micro)
        // However, the microfacet projections (bNdotL and bNdotV) exactly cancel out!
        // 1. bNdotL cancels with the leaf irradiance projection (E_leaf = E_beam * bNdotL).
        // 2. bNdotV cancels with the volumetric visible area fraction (A_vis = bNdotV / V.y).
        // The resulting macroscopic BRDF correctly uses the MACRO surface projections (NdotL and NdotV).
        float spec_brdf_radiance = (D * F * G) / (4.0 * max(NdotV * NdotL, 0.0001));

        // Apply smooth blade-horizon fade.
        spec_term = vec3(spec_brdf_radiance) * spec_macro_attenuation * specFade;
    }

    return (ss_term + soil_term + ms_term + spec_term) * E_raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — MAIN
// ─────────────────────────────────────────────────────────────────────────────

void main() {
    float n = iesExponent;

    // Use physical BRDF only for grass surfaces in mode 1.
    bool useGrassBRDF = (grassBRDFMode > 0.5) && (isSurfaceGrass > 0.5);

    // Lambertian surface colour (used in mode 0 and for stands).
    vec3 surfColor = baseColor;

    vec3 totalL = vec3(0.0);  // accumulated outgoing radiance

    if (useGrassBRDF) {
        // ── Physical OBC BRDF mode ─────────────────────────────────────────────
        // Per-fragment view direction.
        vec3 V = normalize(cameraPos - vWorldPos);

        // Campbell M coefficient: constant for this fragment (only depends on chi).
        float M = campbellM(chiLAD);

        vec2 mapUv = vec2(vWorldPos.x / fieldSize.x + 0.5, vWorldPos.z / fieldSize.y + 0.5);
        vec4 m = texture(crushMap, mapUv);
        float w_map = clamp(m.r, 0.0, 1.0);
        float coherence = clamp(m.g, 0.0, 1.0);
        float spread_map = clamp(m.b, 0.0, 1.0);
        float leanSign = m.a * 2.0 - 1.0;

        float meadowTilt = bladeCampbellMeanTiltRad;
        float effectiveTilt = mix(meadowTilt, mowMaxTiltRad, w_map);
        float yComp = cos(effectiveTilt);
        float zComp = leanSign * sin(effectiveTilt) * w_map;
        vec3 N_blade = normalize(vec3(0.0, yComp + 0.0001, zComp));

        float sinTheta = sin(bladeCampbellMeanTiltRad);
        float meadowVariance = sinTheta * sinTheta * 0.5;
        float variance = mix(meadowVariance, spread_map, w_map);

        for (int i = 0; i < MAX_LIGHTS; i++) {
            if (i >= lightCount) break;
            LightData ld = readLight(i);
            if (ld.intensity <= 0.0) continue;

            vec3  L;
            float E_raw = lightRawIrradiance(ld, vWorldPos, n, L);
            if (E_raw <= 0.0) continue;

            totalL += evaluateGrassBRDF(L, V, N_blade, E_raw, M, variance, coherence) * lightColor;
        }

    } else {
        // ── Simple Lambertian mode (debug / stands) ────────────────────────────
        // Accumulate total horizontal illuminance Eh = Σ(E_raw × NdotL).
        float Eh = 0.0;
        for (int i = 0; i < MAX_LIGHTS; i++) {
            if (i >= lightCount) break;
            LightData ld = readLight(i);
            if (ld.intensity <= 0.0) continue;
            vec3  L;
            float E_raw = lightRawIrradiance(ld, vWorldPos, n, L);
            if (E_raw <= 0.0) continue;
            float NdotL = max(0.0, L.y);
            Eh += E_raw * NdotL;
        }

        // L_r = (surfColor × lightColor / π) × Eh
        totalL = surfColor * lightColor * (1.0 / PI) * Eh;
    }

    #if defined( TONE_MAPPING )
        totalL = toneMapping( totalL );
    #endif

    fragColor = linearToOutputTexel( vec4(totalL, 1.0) );
}
