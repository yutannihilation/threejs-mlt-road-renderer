import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  GLSL3,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { ROAD_FRAGMENT, ROAD_VERTEX } from "./shaders";
import { STYLE_WIDTH } from "./style";
import type { RoadMesh } from "./tessellate";
import type { TileFrame } from "./transform";

export interface GroupGeometry {
  readonly group: number;
  readonly geometry: BufferGeometry;
}

/**
 * One geometry per draw group, all over the same attributes and index, so the tile's buffers
 * are uploaded once and each geometry draws its group's range. Dispose them together: disposing
 * one frees the shared GL buffers.
 */
export function roadGeometries(mesh: RoadMesh): GroupGeometry[] {
  const position = new BufferAttribute(mesh.positions, 3);
  const extrude = new BufferAttribute(mesh.extrudes, 4);
  const widthLines = new BufferAttribute(mesh.widthLines, 2);
  // Integer arrays bind with vertexAttribIPointer, so the shader reads `uint` and `uvec2` exactly.
  const line = new BufferAttribute(mesh.lines, 1);
  const index = new BufferAttribute(mesh.indices, 1);
  return mesh.groups.map(({ group, start, count }) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", position);
    geometry.setAttribute("aExtrude", extrude);
    geometry.setAttribute("aWidthLines", widthLines);
    geometry.setAttribute("aLine", line);
    geometry.setIndex(index);
    geometry.setDrawRange(start, count);
    return { group, geometry };
  });
}

/** The per-line style as an `RGBA32F` texture the shaders read with `texelFetch`. */
export function styleTexture(texels: Float32Array, height: number): DataTexture {
  const texture = new DataTexture(texels, STYLE_WIDTH, height, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A tile's material: its frame and style texture as uniforms; `uPass`, `uClip` and `depthWrite`
 * and `uCamera` are set per draw in `onBeforeRender`. Casings write depth (offset down by
 * `casingDepthOffset` metres along each pixel's ray) and fills only test it, so fills order among themselves by draw
 * order, cover the casings of roads at their height, and are hidden by roads above them.
 */
export function roadMaterial(
  frame: TileFrame,
  style: Texture,
  metre: number,
  casingDepthOffset: number,
): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    side: DoubleSide,
    depthTest: true,
    depthWrite: false,
    vertexShader: ROAD_VERTEX,
    fragmentShader: ROAD_FRAGMENT,
    uniforms: {
      uOrigin: { value: new Vector2(frame.origin[0], frame.origin[1]) },
      uScale: { value: frame.scale },
      uMetre: { value: metre },
      uLineStyle: { value: style },
      uStyleWidth: { value: STYLE_WIDTH },
      uPass: { value: 1 },
      uCasingDepthOffset: { value: casingDepthOffset },
      uCamera: { value: new Vector3() },
      uClip: { value: new Vector4(0, 0, 0, 0) },
    },
  });
}
