import { BufferAttribute, BufferGeometry, GLSL3, ShaderMaterial, Vector4 } from "three";
import type { Lines } from "./lines";
import { CENTRELINE_FRAGMENT, CENTRELINE_VERTEX } from "./shaders";
import { metreScale, type TileFrame } from "./transform";

/**
 * Every segment of every line as a pair of points, `x, y, z` each, for drawing the data's own
 * centrelines: in Mercator units relative to the tile's corner, z placed by `frame` as the ribbons'
 * is, so the lines lie on them. `metre` is one metre in Mercator units at the equator.
 */
export function centrelineSegments(lines: Lines, frame: TileFrame, metre: number): Float32Array {
  const { vertices, lineStart } = lines;
  const { origin, scale, zScale, zOffset } = frame;
  const n = lineStart.length - 1;
  let count = 0;
  for (let l = 0; l < n; l++) count += Math.max(0, lineStart[l + 1] - lineStart[l] - 1);
  const out = new Float32Array(count * 6);
  let o = 0;
  const put = (k: number) => {
    const [x, y] = [vertices[k * 3] * scale, vertices[k * 3 + 1] * scale];
    const metres = vertices[k * 3 + 2] * zScale + zOffset;
    out.set([x, y, metres * metre * metreScale(origin[1] + y)], o);
    o += 3;
  };
  for (let l = 0; l < n; l++) {
    for (let k = lineStart[l] + 1; k < lineStart[l + 1]; k++) {
      put(k - 1);
      put(k);
    }
  }
  return out;
}

export function centrelineGeometry(segments: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(segments, 3));
  return geometry;
}

/**
 * Translucent red lines over the roads: depth-tested, so roads above hide them, but writing no
 * depth. `uScale` (the tile's Mercator units per tile unit) and `uClip` are set per draw.
 */
export function centrelineMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: CENTRELINE_VERTEX,
    fragmentShader: CENTRELINE_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    uniforms: {
      uScale: { value: 1 },
      uClip: { value: new Vector4(0, 0, 0, 0) },
    },
  });
}
