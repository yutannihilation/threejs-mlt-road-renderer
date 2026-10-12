import type { LineTile } from "./tile";

/** The lowest and highest elevation of a tile's vertices, in metres; `undefined` with none. */
export function elevationRange(tile: LineTile): readonly [number, number] | undefined {
  const { vertices } = tile.layer.geometry;
  const { zScale, zOffset } = tile.frame;
  let [lo, hi] = [Infinity, -Infinity];
  for (let k = 2; k < vertices.length; k += 3) {
    const z = vertices[k];
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  if (lo > hi) return undefined;
  // The grid may run either way: a negative scale swaps the ends.
  const [a, b] = [lo * zScale + zOffset, hi * zScale + zOffset];
  return a <= b ? [a, b] : [b, a];
}

/** The range covering both, either of which may be missing. */
export function unionRange(
  a: readonly [number, number] | undefined,
  b: readonly [number, number] | undefined,
): readonly [number, number] | undefined {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}
