// Procedural crush map (must match src/crushMap/crushMap.ts sampleCrushMap).
// R = blend w, G = coherence, B = spread, A = (leanSign + 1) * 0.5

precision highp float;

uniform float fieldW;
uniform float fieldH;
uniform float mowBend;
uniform float mowCoherence;
uniform float mowSpread;
uniform float mowArtMowingEnabled;
uniform float mowArtStripeWidthM;
uniform float mowArtStripesEnabled;
uniform float mowArtStripeBendVariation;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 worldXZ = (vUv - 0.5) * vec2(fieldW, fieldH);
  float worldX = worldXZ.x;

  float sw = max(mowArtStripeWidthM, 0.01);
  float stripeIdx = floor(worldX / sw);
  float alt = mod(stripeIdx, 2.0) < 1.0 ? -1.0 : 1.0;
  float leanStriped = mix(1.0, alt, mowArtStripesEnabled);
  float stripePhase = mowArtStripesEnabled > 0.5
    ? (mod(stripeIdx, 2.0) < 1.0 ? 0.0 : 1.0)
    : 0.0;
  float rModStriped = mix(1.0, mix(1.0 - 0.08 * mowArtStripeBendVariation, 1.0, stripePhase), mowArtStripesEnabled);

  float leanSign = mix(1.0, leanStriped, step(0.5, mowArtMowingEnabled));
  float rMod = mix(1.0, rModStriped, step(0.5, mowArtMowingEnabled));

  float R = clamp(mowBend * rMod, 0.0, 1.0);
  float G = clamp(mowCoherence, 0.0, 1.0);
  float B = clamp(mowSpread, 0.0, 1.0);
  float A = leanSign * 0.5 + 0.5;

  fragColor = vec4(R, G, B, A);
}
