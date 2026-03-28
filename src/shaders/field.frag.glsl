// Three.js injects #version 300 es, precision qualifiers, toneMapping(),
// and linearToOutputTexel() automatically before this source.

// Maximum lights processed per frame.  Must match FieldMaterial.MAX_LIGHTS.
#define MAX_LIGHTS 128

// One RGBA float texture (4 rows x MAX_LIGHTS columns).
//   row 0: pixel i -> (pos.x,     pos.y,    pos.z,    -)
//   row 1: pixel i -> (target.x,  target.y, target.z, -)
//   row 2: pixel i -> (intensity, angleH,   penumbra,  angleV)
//   row 3: pixel i -> (visorTan,  -,        -,         -)
//
// angleH / angleV: horizontal / vertical half-angles [rad] (elliptic TIR lens).
//   angleH >= angleV.  angleH == angleV => circular beam (no asymmetry).
// visorTan: tan of the maximum allowed "above-axis" angle in the fixture-local
//   vertical plane, computed from the far touchline geometry (barn-door visor).
//   Large value (>= 1e8) means no visor applied (light does not face stands).
uniform sampler2D lightData;
uniform int       lightCount;
uniform float     iesExponent;
uniform vec3      baseColor;    // linear-space surface colour
uniform vec3      lightColor;   // CCT tint, luminance-normalised (Y = 1)
uniform float     lightingOnly; // 0 = surface colour, 1 = 18% neutral grey

in  vec3 vWorldPos;
out vec4 fragColor;

// ─────────────────────────────────────────────────────────────────────────────
// Data types
// ─────────────────────────────────────────────────────────────────────────────

struct LightData {
    vec3  pos;
    vec3  target;
    float intensity;
    float angleH;
    float penumbra;      // soft-edge fraction of cone [0–1]; used when iesExponent = 0
    float angleV;
    float visorTan;
    float visorPenumbra; // soft-edge fraction [0–1]; 0 = hard cut, 1 = full fade over full angle
};

// Fixture-local orthonormal frame.
//   axis     = beam direction (light -> target)
//   right    = cross(axis, worldUp), roughly along the touchline
//   up       = cross(right, axis),  the "vertical" in the fixture plane
//              positive up => toward sky / stands; negative up => toward field
struct LocalFrame {
    vec3 axis;
    vec3 right;
    vec3 up;
};

// ─────────────────────────────────────────────────────────────────────────────
// Functions
// ─────────────────────────────────────────────────────────────────────────────

LightData readLight(int i) {
    vec4 r0 = texelFetch(lightData, ivec2(i, 0), 0);
    vec4 r1 = texelFetch(lightData, ivec2(i, 1), 0);
    vec4 r2 = texelFetch(lightData, ivec2(i, 2), 0);
    vec4 r3 = texelFetch(lightData, ivec2(i, 3), 0);

    LightData ld;
    ld.pos       = r0.xyz;
    ld.target    = r1.xyz;
    ld.intensity = r2.x;
    ld.angleH    = r2.y;
    ld.penumbra  = r2.z;
    ld.angleV    = r2.w;
    ld.visorTan      = r3.x;
    ld.visorPenumbra = r3.y;
    return ld;
}

// Returns false when axis is degenerate (light == target).
bool buildLocalFrame(vec3 lpos, vec3 ltgt, out LocalFrame frame) {
    vec3 axisRaw = ltgt - lpos;
    if (dot(axisRaw, axisRaw) < 1e-10) return false;

    frame.axis  = normalize(axisRaw);
    vec3 worldUp = (abs(frame.axis.y) > 0.999) ? vec3(1, 0, 0) : vec3(0, 1, 0);
    frame.right  = normalize(cross(frame.axis, worldUp));
    frame.up     = cross(frame.right, frame.axis);
    return true;
}

// IES power-cosine beam factor (dimensionless, energy-conserving).
//
//   w   = (cosToPoint - cosOuter) / (1 - cosOuter)   in [0, 1]
//   bf  = w^n * (n+1)    for n > 0  (flux integral = 1 over [0,1])
//   bf  = smoothstep(w)  for n = 0  (Three.js default, flat-top with soft edge)
//
// cosToPoint  = cos(angle from beam axis to fragment direction) = dzLocal.
// angleH      = cone half-angle [rad].
// penumbra    = soft-edge fraction [0–1]; only used when n = 0.
// n           = IES beam exponent (iesExponent uniform).
//
// n = 0  — Three.js SpotLight standard: smoothstep from outer edge (cosOuter, I=0)
//           to inner edge (cosInner = cos(angleH * (1-penumbra)), I=1).
//           penumbra = 0 → hard cutoff.  penumbra = 1 → full-cone gradient.
// n > 0  — Power-cosine IES profile; penumbra is not used.
float iesBeamFactor(float cosToPoint, float angleH, float penumbra, float n) {
    float cosOuter = cos(angleH);
    if (n <= 0.0) {
        float cosInner = cos(angleH * (1.0 - penumbra));
        return smoothstep(cosOuter, cosInner, cosToPoint);
    }
    float w = max(0.0, (cosToPoint - cosOuter) / (1.0 - cosOuter));
    return pow(w, n) * (n + 1.0);
}

// Illuminance contribution [lux · m²] from one fixture to one fragment.
//
// Returns 0 when the fragment is:
//   - below the fixture's horizon
//   - behind the beam axis
//   - blocked by the visor (barn-door cutoff)
//   - outside the elliptical beam cone
//
// The caller divides by r² to get lux.
float lightContribution(LightData ld, vec3 fragPos, float n) {
    // Direction from fragment to light; cosInc = vertical incidence component.
    vec3  d      = ld.pos - fragPos;
    float r2     = dot(d, d);
    float r      = sqrt(r2);
    vec3  dn     = d / r;        // fragment -> light, unit
    float cosInc = dn.y;         // cos(incidence on horizontal surface)
    if (cosInc <= 0.0) return 0.0;

    // Build fixture-local frame; discard degenerate lights.
    LocalFrame frame;
    if (!buildLocalFrame(ld.pos, ld.target, frame)) return 0.0;

    // Decompose fragDir (light -> fragment) into local frame components.
    vec3  fragDir = -dn;
    float dxLocal = dot(fragDir, frame.right);
    float dyLocal = dot(fragDir, frame.up);
    float dzLocal = dot(fragDir, frame.axis);  // = cos(theta_from_axis)

    if (dzLocal <= 0.0) return 0.0;  // fragment is behind the fixture

    // Visor (barn-door) soft-edge cutoff.
    //
    // visorRatio = dyLocal / (visorTan * dzLocal):
    //   0   = on beam axis
    //   1   = exactly at the cutoff plane (far touchline + margin)
    //   >1  = past the cutoff → blocked
    //
    // visorPenumbra controls the fade width:
    //   0   = hard step at visorRatio = 1
    //   0.3 = fade starts at visorRatio = 0.7, zero at 1.0
    //   1.0 = fade spans the entire range [0, 1]
    //
    // When visorTan = 1e9 (disabled), visorRatio ≈ 0 → visorFade = 1 (no effect).
    float visorRatio = dyLocal / (ld.visorTan * dzLocal);
    if (visorRatio >= 1.0) return 0.0;
    float vp     = max(ld.visorPenumbra, 0.001);
    float edgeLo = 1.0 - vp;
    float t      = clamp((visorRatio - edgeLo) / vp, 0.0, 1.0);
    float visorFade = 1.0 - t * t * (3.0 - 2.0 * t); // smoothstep fade

    // Elliptical cone gate.
    // Maps the elliptical beam to a unit disk: passes iff u^2 + v^2 < 1.
    // angleH (horizontal) >= angleV (vertical, compressed by TIR lens ratio).
    float tanH = tan(ld.angleH);
    float tanV = tan(ld.angleV);
    float u    = dxLocal / tanH;
    float v    = dyLocal / tanV;
    if (u*u + v*v >= 1.0) return 0.0;

    float bf = iesBeamFactor(dzLocal, ld.angleH, ld.penumbra, n);

    // E_h [lux] = I [cd] * bf * visorFade * cosInc / r^2
    return ld.intensity * bf * visorFade * cosInc / r2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

void main() {
    float Eh = 0.0;
    float n  = iesExponent;

    for (int i = 0; i < MAX_LIGHTS; i++) {
        if (i >= lightCount) break;

        LightData ld = readLight(i);
        if (ld.intensity <= 0.0) continue;

        Eh += lightContribution(ld, vWorldPos, n);
    }

    // In lighting-only mode: replace surface colour with 18% neutral grey
    // so the illuminance distribution is visible without colour bias.
    vec3 surfColor = mix(baseColor, vec3(0.18), lightingOnly);

    // Lambertian: L = (surfColor * lightColor / pi) * Eh
    vec3 linear = surfColor * lightColor * (1.0 / 3.14159265) * Eh;

    #if defined( TONE_MAPPING )
        linear = toneMapping( linear );
    #endif

    fragColor = linearToOutputTexel( vec4(linear, 1.0) );
}
