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
  float worldZ = worldXZ.y;

  float edgeNoise = (sin(worldZ * 18.3 + worldX * 3.0) * 0.5 + 
                     sin(worldZ * 29.1 - worldX * 2.0) * 0.3 + 
                     sin(worldZ * 9.7) * 0.7) * 0.08;
  float noisyX = worldX + edgeNoise;

  float sw = max(mowArtStripeWidthM, 0.01);
  float stripeIdx = floor(noisyX / sw);
  float alt = mod(stripeIdx, 2.0) < 1.0 ? -1.0 : 1.0;
  float leanStriped = mix(1.0, alt, mowArtStripesEnabled);
  float stripePhase = mowArtStripesEnabled > 0.5
    ? (mod(stripeIdx, 2.0) < 1.0 ? 0.0 : 1.0)
    : 0.0;
  float rModStriped = mix(1.0, mix(1.0 - 0.08 * mowArtStripeBendVariation, 1.0, stripePhase), mowArtStripesEnabled);

  float leanSign = mix(1.0, leanStriped, step(0.5, mowArtMowingEnabled));
  float rMod = mix(1.0, rModStriped, step(0.5, mowArtMowingEnabled));

  float localX = mod(noisyX, sw);
  float distToEdge = min(localX, sw - localX);
  
  float edgeCrushRaw = max(0.0, 1.0 - distToEdge / 0.4);
  float edgeCrush = edgeCrushRaw * edgeCrushRaw * (3.0 - 2.0 * edgeCrushRaw) * 0.06;

  float R = clamp(mowBend * rMod + edgeCrush * step(0.5, mowArtMowingEnabled), 0.0, 1.0);
  float G = clamp(mowCoherence, 0.0, 1.0);
  float B = clamp(mowSpread, 0.0, 1.0);
  float A = leanSign * 0.5 + 0.5;

  fragColor = vec4(R, G, B, A);
}
