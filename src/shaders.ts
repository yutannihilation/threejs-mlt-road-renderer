/**
 * GLSL ES 3.00. Three.js adds `#version`, the precision, `projectionMatrix`, `modelViewMatrix`
 * and the `position` attribute.
 */

/**
 * Every vertex sits on a centreline point (`position`, Mercator units relative to the tile's
 * corner) and carries its offset as two terms, `aExtrude.xy` times the half width of line
 * `aWidthLines.x` plus `aExtrude.zw` times that of `aWidthLines.y`, the widths in metres from the
 * style texels of the pass; `aLine` gives the colour. The offset is scaled by a metre at the
 * vertex's latitude, `uMetre * cosh(π (1 − 2y))`. Vertices with equal attributes land on the same
 * point, which keeps junctions watertight.
 */
export const ROAD_VERTEX = /* glsl */ `
in vec4 aExtrude;
in uvec2 aWidthLines;
in uint aLine;

uniform vec2 uOrigin;
uniform float uScale;
uniform float uMetre;
uniform sampler2D uLineStyle;
uniform int uStyleWidth;
// 0 draws the casing (the second texel), 1 the fill (the first).
uniform int uPass;
// The casing's depth is that of the point where the vertex's own ray from the camera reaches this
// many metres lower, so that at every pixel and from any angle, the fill of any road within that
// height draws over it (the network's outline is one), while a road higher than that keeps its own
// outline over the roads beneath.
uniform float uCasingDepthOffset;
// The camera's eye, in the tile's local Mercator units.
uniform vec3 uCamera;

flat out vec3 vColor;
out vec2 vTile;

const float PI = 3.141592653589793;

// A line's style texel for the pass: colour, and half width in metres.
vec4 lineStyle(uint line) {
  int texel = int(line) * 2 + (uPass == 0 ? 1 : 0);
  return texelFetch(uLineStyle, ivec2(texel % uStyleWidth, texel / uStyleWidth), 0);
}

void main() {
  vec2 extrude = aExtrude.xy * lineStyle(aWidthLines.x).a + aExtrude.zw * lineStyle(aWidthLines.y).a;
  float metre = uMetre * cosh(PI * (1.0 - 2.0 * (uOrigin.y + position.y)));
  vec2 local = position.xy + extrude * metre;
  vColor = lineStyle(aLine).rgb;
  // Where the vertex lands in the tile's own units, for clipping to the tile.
  vTile = local / uScale;
  mat4 toClip = projectionMatrix * modelViewMatrix;
  gl_Position = toClip * vec4(local, position.z, 1.0);
  if (uPass == 0) {
    vec3 at = vec3(local, position.z);
    float drop = uCamera.z - at.z;
    if (drop > 0.0) {
      // Same place on screen, the depth of the point on its ray the offset lower.
      vec4 below = toClip * vec4(at + (at - uCamera) * (uCasingDepthOffset * metre / drop), 1.0);
      gl_Position.z = below.z / below.w * gl_Position.w;
    } else {
      // A ray that never descends reaches no lower point: the casing lies behind everything.
      gl_Position.z = gl_Position.w;
    }
  }
}
`;

/**
 * The pass's colour, clipped to `uClip` (`x0, y0, x1, y1` in tile units): a tile draws only its
 * own footprint, or the footprint of a child it stands in for, so neighbouring tiles never
 * overdraw each other's ordering, whatever their buffer holds.
 */
export const ROAD_FRAGMENT = /* glsl */ `
flat in vec3 vColor;
in vec2 vTile;

uniform vec4 uClip;

out vec4 outColor;

void main() {
  if (vTile.x < uClip.x || vTile.y < uClip.y || vTile.x >= uClip.z || vTile.y >= uClip.w) discard;
  outColor = vec4(vColor, 1.0);
}
`;

/** A centreline point (`position`, as for the ribbons), passed on in tile units for clipping. */
export const CENTRELINE_VERTEX = /* glsl */ `
uniform float uScale;

out vec2 vTile;

void main() {
  vTile = position.xy / uScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** A translucent red, clipped to `uClip` as the ribbons are. */
export const CENTRELINE_FRAGMENT = /* glsl */ `
in vec2 vTile;

uniform vec4 uClip;

out vec4 outColor;

void main() {
  if (vTile.x < uClip.x || vTile.y < uClip.y || vTile.x >= uClip.z || vTile.y >= uClip.w) discard;
  outColor = vec4(0.9, 0.0, 0.0, 0.55);
}
`;
