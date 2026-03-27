// Three.js automatically injects: modelMatrix, modelViewMatrix, projectionMatrix,
// position (vertex attribute).

out vec3 vWorldPos;

void main() {
  // Transform vertex to world space — needed to compute light distances and
  // angles per fragment using world-space light positions from uniforms.
  vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos4.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
