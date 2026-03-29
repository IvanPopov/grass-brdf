import * as THREE from 'three';
import type { GrassBRDFParams } from '../scene/GrassBRDFParams';
import { FIELD_H, FIELD_W } from '../config';
import crushMapGenVert from '../shaders/crushMapGen.vert.glsl';
import crushMapGenFrag from '../shaders/crushMapGen.frag.glsl';
import { CRUSH_MAP_TEX_H, CRUSH_MAP_TEX_W } from './crushMap';

/**
 * Renders the procedural crush map via GPU (same formula as crushMap.ts).
 */
export class CrushMapGpu {
  readonly renderTarget: THREE.WebGLRenderTarget;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.renderTarget = new THREE.WebGLRenderTarget(CRUSH_MAP_TEX_W, CRUSH_MAP_TEX_H, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS:     THREE.ClampToEdgeWrapping,
      wrapT:     THREE.ClampToEdgeWrapping,
      colorSpace: THREE.NoColorSpace,
    });

    this.scene  = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.camera.position.z = 1;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader:   crushMapGenVert,
      fragmentShader: crushMapGenFrag,
      side: THREE.DoubleSide,
      uniforms: {
        fieldW:                 { value: FIELD_W },
        fieldH:                 { value: FIELD_H },
        mowBend:                { value: 0.0 },
        mowCoherence:           { value: 1.0 },
        mowSpread:              { value: 0.0 },
        mowArtMowingEnabled:    { value: 1.0 },
        mowArtStripeWidthM:     { value: 5.4 },
        mowArtStripesEnabled:   { value: 1.0 },
        mowArtStripeBendVariation: { value: 1.0 },
      },
      depthTest:  false,
      depthWrite: false,
    });

    const quad = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(quad, this.material);
    this.scene.add(this.mesh);
  }

  dispose(): void {
    this.renderTarget.dispose();
    this.material.dispose();
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
  }

  syncUniforms(p: GrassBRDFParams): void {
    const u = this.material.uniforms;
    u['fieldW'].value               = FIELD_W;
    u['fieldH'].value               = FIELD_H;
    u['mowBend'].value              = p.mowBend;
    u['mowCoherence'].value         = p.mowCoherence;
    u['mowSpread'].value            = p.mowSpread;
    u['mowArtMowingEnabled'].value = p.mowArtMowingEnabled ? 1.0 : 0.0;
    u['mowArtStripeWidthM'].value   = p.mowArtStripeWidthM;
    u['mowArtStripesEnabled'].value = p.mowArtStripesEnabled ? 1.0 : 0.0;
    u['mowArtStripeBendVariation'].value = p.mowArtStripeBendVariation;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.renderTarget);
    renderer.clear(true, true, true);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    this.renderTarget.texture.needsUpdate = true;
  }

  get texture(): THREE.Texture {
    return this.renderTarget.texture;
  }
}
