import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 80, 120);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// 1m grid with smooth distance fade via shader
const gridMat = new THREE.ShaderMaterial({
  uniforms: {
    uColor:     { value: new THREE.Color(0x707070) },
    uFadeStart: { value: 80.0 },
    uFadeEnd:   { value: 250.0 },
  },
  vertexShader: /* glsl */`
    out vec2 vWorldXZ;
    void main() {
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorldXZ = w.xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
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
      float dist  = length(vWorldXZ);
      float fade  = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
      if (fade < 0.01) discard;
      fragColor = vec4(uColor, line * fade);
    }
  `,
  transparent: true,
  depthWrite: false,
  glslVersion: THREE.GLSL3,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});
const gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 1, 1), gridMat);
gridMesh.rotation.x = -Math.PI / 2;
gridMesh.renderOrder = 1;
scene.add(gridMesh);

// FIFA standard pitch: 105 x 68 meters
const planeGeo = new THREE.PlaneGeometry(105, 68);
const planeMat = new THREE.MeshLambertMaterial({
  color: 0x2d7a2d,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
const plane = new THREE.Mesh(planeGeo, planeMat);
plane.rotation.x = -Math.PI / 2;
plane.receiveShadow = true;
scene.add(plane);

// Spotlight
const spotLight = new THREE.SpotLight(0xfff8e0, 3000, 250, Math.PI / 5, 0.3, 1.5);
spotLight.position.set(0, 60, 0);
spotLight.target.position.set(0, 0, 0);
spotLight.castShadow = true;
spotLight.shadow.mapSize.set(2048, 2048);
spotLight.shadow.camera.near = 1;
spotLight.shadow.camera.far = 200;
scene.add(spotLight);
scene.add(spotLight.target);

const markerGeo = new THREE.SphereGeometry(1.2, 16, 16);
const markerMat = new THREE.MeshBasicMaterial({ color: 0xffee88 });
const marker = new THREE.Mesh(markerGeo, markerMat);
marker.position.copy(spotLight.position);
scene.add(marker);

// Dimension annotations
const DIM_COLOR = 0x00d4ff;
const DIM_Y = 0.15;
const FIELD_W = 105;
const FIELD_H = 68;
const HALF_W = FIELD_W / 2;
const HALF_H = FIELD_H / 2;
const OFFSET = 7;

const DIM_RENDER_ORDER = 2;

function dimLineMat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: DIM_COLOR, depthTest: false, transparent: true });
}

function dimMeshMat(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: DIM_COLOR, depthTest: false, transparent: true });
}

function addLine(a: THREE.Vector3, b: THREE.Vector3): void {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const line = new THREE.Line(geo, dimLineMat());
  line.renderOrder = DIM_RENDER_ORDER;
  scene.add(line);
}

const CONE_HEIGHT = 1.8;

function addArrowHead(tip: THREE.Vector3, dir: THREE.Vector3): void {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, CONE_HEIGHT, 8), dimMeshMat());
  const d = dir.clone().normalize();
  cone.position.copy(tip).addScaledVector(d, -(CONE_HEIGHT / 2));
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  cone.renderOrder = DIM_RENDER_ORDER;
  scene.add(cone);
}

function addTextSprite(text: string, pos: THREE.Vector3): void {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#00d4ff';
  ctx.font = 'bold 44px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 160, 40);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: true });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(pos);
  sprite.scale.set(12, 3, 1);
  sprite.renderOrder = DIM_RENDER_ORDER;
  scene.add(sprite);
}

// Length dimension (105 m) — along X, offset on -Z side
const lenZ = -HALF_H - OFFSET;
addLine(new THREE.Vector3(-HALF_W, DIM_Y, -HALF_H), new THREE.Vector3(-HALF_W, DIM_Y, lenZ - 1));
addLine(new THREE.Vector3(HALF_W, DIM_Y, -HALF_H), new THREE.Vector3(HALF_W, DIM_Y, lenZ - 1));
addLine(new THREE.Vector3(-HALF_W, DIM_Y, lenZ), new THREE.Vector3(HALF_W, DIM_Y, lenZ));
// Arrows point inward toward each other; tips at the extension lines
addArrowHead(new THREE.Vector3(-HALF_W, DIM_Y, lenZ), new THREE.Vector3(1, 0, 0));
addArrowHead(new THREE.Vector3(HALF_W, DIM_Y, lenZ), new THREE.Vector3(-1, 0, 0));
addTextSprite('105 m', new THREE.Vector3(0, DIM_Y, lenZ - 3.5));

// Width dimension (68 m) — along Z, offset on -X side
const widX = -HALF_W - OFFSET;
addLine(new THREE.Vector3(-HALF_W, DIM_Y, -HALF_H), new THREE.Vector3(widX - 1, DIM_Y, -HALF_H));
addLine(new THREE.Vector3(-HALF_W, DIM_Y, HALF_H), new THREE.Vector3(widX - 1, DIM_Y, HALF_H));
addLine(new THREE.Vector3(widX, DIM_Y, -HALF_H), new THREE.Vector3(widX, DIM_Y, HALF_H));
// Arrows point inward toward each other; tips at the extension lines
addArrowHead(new THREE.Vector3(widX, DIM_Y, -HALF_H), new THREE.Vector3(0, 0, 1));
addArrowHead(new THREE.Vector3(widX, DIM_Y, HALF_H), new THREE.Vector3(0, 0, -1));
addTextSprite('68 m', new THREE.Vector3(widX - 4.5, DIM_Y, 0));

// Camera controls
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 0, 0);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate(): void {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
}

animate();
