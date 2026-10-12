export interface TileIndex {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/**
 * What the vertex shader needs to place a tile's decoded integers: the tile in Web Mercator
 * units (`0 .. 1` across the world) and the z grid in metres. Five numbers per tile; every
 * vertex is transformed on the GPU.
 */
export interface TileFrame {
  /** The tile's north-west corner. */
  readonly origin: readonly [number, number];
  /** Mercator units per tile coordinate. */
  readonly scale: number;
  /** Metres are `z * zScale + zOffset`, the layer's `-10000 + z * 10 ** zStep`. */
  readonly zScale: number;
  readonly zOffset: number;
}

/**
 * How many times wider a metre is at Mercator `y` than at the equator, `1 / cos(latitude)`: for a
 * Mercator `y`, `cosh(π (1 − 2y))`.
 */
export function metreScale(y: number): number {
  return Math.cosh(Math.PI * (1 - 2 * y));
}

export function tileFrame(tile: TileIndex, extent: number, zStep: number): TileFrame {
  const tiles = 2 ** tile.z;
  return {
    origin: [tile.x / tiles, tile.y / tiles],
    scale: 1 / (extent * tiles),
    zScale: 10 ** zStep,
    zOffset: -10000,
  };
}

/** A frame for vertices whose z is already in metres. */
export function metreFrame(tile: TileIndex, extent: number): TileFrame {
  return { ...tileFrame(tile, extent, 0), zScale: 1, zOffset: 0 };
}

/**
 * Tile units per metre at tile coordinate `y` of `frame`; `metre` is one metre in Mercator units
 * at the equator.
 */
export function unitsPerMetreAt(frame: TileFrame, metre: number, y: number): number {
  return (metre * metreScale(frame.origin[1] + y * frame.scale)) / frame.scale;
}

/** The most tile units one metre spans anywhere in the tile: at its poleward edge. */
export function unitsPerMetre(tile: TileIndex, extent: number, metre: number): number {
  const frame = tileFrame(tile, extent, 0);
  return Math.max(unitsPerMetreAt(frame, metre, 0), unitsPerMetreAt(frame, metre, extent));
}

/** The inverse of a column-major 4 × 4 matrix, or `null` when it has none. */
export function invert4(m: ArrayLike<number>): number[] | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] =
    Array.from({ length: 16 }, (_, i) => m[i]);
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/**
 * The eye of a perspective view, in the coordinates `matrix` (column-major, 16 numbers) takes: the
 * point it maps to clip `x = y = w = 0`. Throws for a projection without one, such as an
 * orthographic one.
 */
export function cameraPosition(matrix: ArrayLike<number>): [number, number, number] {
  // The solution of M c = (0, 0, 1, 0) is the third column of the inverse.
  const inv = invert4(matrix);
  if (!inv) throw new Error("cameraPosition: the matrix is singular");
  const [x, y, z, w] = inv.slice(8, 12);
  const size = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (!(Math.abs(w) > 1e-12 * size))
    throw new Error("cameraPosition: the projection has no eye (not a perspective view)");
  return [x / w, y / w, z / w];
}
