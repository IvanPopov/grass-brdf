// ─── IES-corrected horizontal illuminance — fragment shader (GLSL 3.00) ────
//
// Light data storage — DataTexture instead of uniform arrays.
//
//   Uniform arrays of vec3/vec4 each consume 1 vec4 from MAX_FRAGMENT_UNIFORM_VECTORS
//   (WebGL2 minimum = 224).  For N lights, 3 arrays × N = 3N vec4s.  At N = 64
//   that is 192 vec4s — already tight; at N = 80+ it exceeds the minimum.
//
//   A float DataTexture stores the same data as texels with no uniform budget cost.
//   Only 1 sampler unit is used regardless of MAX_LIGHTS.
//
//   Texture layout (width = MAX_LIGHTS, height = 3, RGBA float):
//     row 0  pixel i → (pos.x, pos.y, pos.z,   0)
//     row 1  pixel i → (tgt.x, tgt.y, tgt.z,   0)
//     row 2  pixel i → (intensity, angle, penumbra, 0)
//
//   texelFetch(lightData, ivec2(i, row), 0)  — no filtering, integer coords.
//
// Three.js pipeline (GLSL3 + toneMapped: true):
//   gl_FragColor NOT declared; must use own "out vec4 fragColor".
//   Prefix includes tonemapping_pars_fragment →  toneMapping(vec3) and
//   linearToOutputTexel(vec4) are available; do NOT re-declare them.

#define MAX_LIGHTS 128

// One RGBA float texture (3 rows × MAX_LIGHTS columns).
uniform sampler2D lightData;
uniform int       lightCount;
uniform float     iesExponent;
// Linear-space grass colour (sRGB→linear in FieldMaterial.ts).
uniform vec3      baseColor;
// CCT tint — luminance-normalised linear-light RGB (Y = 1.0).
// Normalisation ensures that changing CCT shifts chromaticity (warm/cool hue)
// without changing perceived brightness.  Photometric intensity [cd] is
// independent of spectral distribution, so E_h [lux] must not change with CCT.
uniform vec3      lightColor;

// Lighting-only debug mode.  1.0 = replace grass with 18% neutral grey so the
// pure illumination distribution (no surface colour bias) is visible.
uniform float     lightingOnly;

in  vec3 vWorldPos;
out vec4 fragColor;

void main() {
  float Eh = 0.0;

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= lightCount) break;

    vec4  par       = texelFetch(lightData, ivec2(i, 2), 0);
    float intensity = par.x;
    float angle     = par.y;
    float penumbra  = par.z;

    // Skip unused / cleared slots.  Zero intensity can also produce NaN
    // via 0×∞ if position == target (normalize(0)).
    if (intensity <= 0.0) continue;

    vec3 lpos = texelFetch(lightData, ivec2(i, 0), 0).xyz;
    vec3 ltgt = texelFetch(lightData, ivec2(i, 1), 0).xyz;

    vec3  d   = lpos - vWorldPos;
    float r2  = dot(d, d);
    float r   = sqrt(r2);
    vec3  dn  = d / r;

    // Horizontal illuminance: field normal = +Y, only upper hemisphere counts.
    float cosInc = dn.y;
    if (cosInc <= 0.0) continue;

    vec3 axisRaw = ltgt - lpos;
    // Guard against degenerate position == target (normalize(0) = NaN).
    if (dot(axisRaw, axisRaw) < 1e-10) continue;
    vec3  axis       = normalize(axisRaw);
    float cosToPoint = dot(-dn, axis);
    float cosOuter   = cos(angle);
    if (cosToPoint < cosOuter) continue;

    float bf;
    float n = iesExponent;
    if (n > 0.0) {
      // IES power-cosine with flux conservation:
      //   w(θ) = (cosToPoint − cosOuter) / (1 − cosOuter)   [0 at edge, 1 on-axis]
      //   bf   = w^n × (n+1)
      // (n+1) preserves total flux: ∫ w^n dΩ = Ω/(n+1) → ∫ w^n×(n+1) dΩ = Ω
      float denom = max(1.0 - cosOuter, 1e-7);
      float w     = (cosToPoint - cosOuter) / denom;
      bf = pow(max(0.0, w), n) * (n + 1.0);
    } else {
      // Uniform cone with smooth penumbra (Three.js SpotLight default).
      float cosInner = cos(angle * (1.0 - penumbra));
      float denom    = max(cosInner - cosOuter, 1e-5);
      float t        = clamp((cosToPoint - cosOuter) / denom, 0.0, 1.0);
      bf = t * t * (3.0 - 2.0 * t);
    }

    // E_h [lux] += I [cd] × beamFactor × cosInc / r² [m²]
    Eh += intensity * bf * cosInc / r2;
  }

  // In lighting-only mode, swap grass colour for 18% neutral grey (standard
  // photographic reference reflectance) so the illumination distribution is
  // visible without any surface-colour bias.
  vec3 surfColor = mix(baseColor, vec3(0.18), lightingOnly);

  // Lambertian: L = surfColor × lightColor / π × E_h
  // lightColor is luminance-normalised so CCT changes hue, not brightness.
  // toneMapping() applies toneMappingExposure internally — do not multiply here.
  vec3 linear = surfColor * lightColor * (1.0 / 3.14159265) * Eh;

  #if defined( TONE_MAPPING )
    linear = toneMapping( linear );
  #endif

  fragColor = linearToOutputTexel( vec4( linear, 1.0 ) );
}
