uniform vec3  uColor;
uniform float uFadeStart;
uniform float uFadeEnd;

in vec2  vWorldXZ;
out vec4 fragColor;

void main() {
  vec2  coord = vWorldXZ;
  vec2  fw    = fwidth(coord);
  vec2  g     = abs(fract(coord - 0.5) - 0.5) / max(fw, vec2(0.0001));
  float line  = 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);

  if (line < 0.01) discard;

  float dist = length(vWorldXZ);
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);

  if (fade < 0.01) discard;

  fragColor = vec4(uColor, line * fade);
}
