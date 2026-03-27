out vec2 vWorldXZ;

void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorldXZ = w.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
