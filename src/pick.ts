import type { Lines } from "./lines";
import type { Props, StyleTable } from "./style";
import { invert4, metreScale, type TileFrame, type TileIndex } from "./transform";

/** A drawn tile as the renderer placed it: its matrix from local positions to clip space. */
export interface PickTarget {
  readonly index: TileIndex;
  readonly lines: Lines;
  readonly frame: TileFrame;
  readonly table: StyleTable;
  /** Column-major 4 × 4, as `THREE.Matrix4.elements`. */
  readonly matrix: ArrayLike<number>;
  /** The part of the tile drawn, `x0, y0, x1, y1` in tile units. Default: all of it. */
  readonly clip?: readonly [number, number, number, number];
}

export interface RoadHit {
  /** The tile it was picked in, and the line there. */
  readonly index: TileIndex;
  readonly line: number;
  readonly props: Props;
  /** From the click to the centreline, in CSS pixels. */
  readonly distance: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * A local position (Mercator units relative to the tile) on screen, with its depth (clip z / w,
 * smaller is nearer), or `null` behind the camera.
 */
function projectLocal(
  m: ArrayLike<number>,
  view: Viewport,
  lx: number,
  ly: number,
  lz: number,
): [number, number, number] | null {
  const cx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
  const cy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
  const cz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
  const cw = m[3] * lx + m[7] * ly + m[11] * lz + m[15];
  if (cw <= 0) return null;
  return [((cx / cw + 1) / 2) * view.width, ((1 - cy / cw) / 2) * view.height, cz / cw];
}

/** A tile vertex on screen with its depth, as `projectVertex`. */
function projectWithDepth(
  frame: TileFrame,
  metre: number,
  m: ArrayLike<number>,
  view: Viewport,
  x: number,
  y: number,
  z: number,
): [number, number, number] | null {
  const lx = x * frame.scale;
  const ly = y * frame.scale;
  const lz = (z * frame.zScale + frame.zOffset) * metre * metreScale(frame.origin[1] + ly);
  return projectLocal(m, view, lx, ly, lz);
}

/**
 * A tile vertex on screen, placed as the vertex shader places it: tile units to Mercator units
 * relative to the tile, z from the grid to metres to Mercator units at that latitude, then
 * through the tile's matrix. `null` when it lies behind the camera.
 */
export function projectVertex(
  frame: TileFrame,
  metre: number,
  m: ArrayLike<number>,
  view: Viewport,
  x: number,
  y: number,
  z: number,
): [number, number] | null {
  const p = projectWithDepth(frame, metre, m, view, x, y, z);
  return p && [p[0], p[1]];
}

/** Clip coordinates through an inverse matrix, divided by w; `null` at infinity. */
function unproject(
  inv: readonly number[],
  x: number,
  y: number,
  z: number,
): [number, number, number] | null {
  const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  if (!w) return null;
  return [
    (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) / w,
    (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) / w,
    (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) / w,
  ];
}

/**
 * The road under `(x, y)` in CSS pixels across `targets`. The click is cast as a ray into each
 * tile and met with each segment's ribbon, flat at the segment's elevation: of the ribbons it hits
 * within the part of the tile drawn, the one nearest the camera wins, as the depth test draws it on
 * top. Failing that, the line whose ribbon edge is nearest on screen, within `radius` pixels;
 * `null` when there is none. Working on the ground rather than on screen keeps roads passing under
 * or behind the camera, whose projections blow up, from claiming the click.
 */
export function pickRoad(
  targets: readonly PickTarget[],
  x: number,
  y: number,
  view: Viewport,
  metre: number,
  radius: number,
): RoadHit | null {
  const [nx, ny] = [(x / view.width) * 2 - 1, 1 - (y / view.height) * 2];
  let best: RoadHit | null = null;
  // How `best` was found: on its ribbon at a ray parameter, or beyond its edge by pixels.
  let bestOn = false;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const { index, lines, frame, table, matrix, clip } of targets) {
    const inv = invert4(matrix);
    const near = inv && unproject(inv, nx, ny, -1);
    const far = inv && unproject(inv, nx, ny, 1);
    if (!near || !far) continue;
    const ray = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    if (!ray[2]) continue;
    const { vertices, lineStart } = lines;
    const { scale, origin, zScale, zOffset } = frame;
    const [x0, y0, x1, y1] = clip ?? [-Infinity, -Infinity, Infinity, Infinity];
    /** Vertex `v` in Mercator units relative to the tile, its elevation scaled as the shader does. */
    const local = (v: number): [number, number, number] => {
      const ly = vertices[v * 3 + 1] * scale;
      const metres = vertices[v * 3 + 2] * zScale + zOffset;
      return [vertices[v * 3] * scale, ly, metres * metre * metreScale(origin[1] + ly)];
    };
    for (let line = 0; line + 1 < lineStart.length; line++) {
      if (!table.visible[line]) continue;
      const outer = table.outerHalfWidth[line];
      for (let v = lineStart[line]; v + 1 < lineStart[line + 1]; v++) {
        const a = local(v);
        const b = local(v + 1);
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const len2 = dx * dx + dy * dy;
        // Meet the ray with the ribbon's plane at the elevation of the nearest point, twice: the
        // second pass corrects for the slope along the segment.
        let z = (a[2] + b[2]) / 2;
        let s = 0;
        let t = 0;
        let q: [number, number] = [0, 0];
        for (let pass = 0; pass < 2; pass++) {
          s = (z - near[2]) / ray[2];
          q = [near[0] + s * ray[0], near[1] + s * ray[1]];
          t =
            len2 === 0
              ? 0
              : Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2));
          z = a[2] + t * (b[2] - a[2]);
        }
        // Between the near and far planes, and in the part of the tile drawn.
        if (s < 0 || s > 1) continue;
        if (q[0] / scale < x0 || q[1] / scale < y0 || q[0] / scale >= x1 || q[1] / scale >= y1) {
          continue;
        }
        const n: [number, number, number] = [a[0] + t * dx, a[1] + t * dy, z];
        const off = Math.hypot(q[0] - n[0], q[1] - n[1]);
        const half = outer * metre * metreScale(origin[1] + n[1]);
        const centre = projectLocal(matrix, view, n[0], n[1], n[2]);
        const distance = centre ? Math.hypot(x - centre[0], y - centre[1]) : 0;
        let on = off <= half;
        let rank = s;
        if (!on) {
          // Beyond the edge: the pixels from the click to the edge point towards it.
          const k = half / off;
          const edge = projectLocal(
            matrix,
            view,
            n[0] + (q[0] - n[0]) * k,
            n[1] + (q[1] - n[1]) * k,
            n[2],
          );
          if (!edge) continue;
          rank = Math.hypot(x - edge[0], y - edge[1]);
          if (rank > radius) continue;
          on = false;
        }
        if ((on && !bestOn) || (on === bestOn && rank < bestRank)) {
          best = { index, line, props: lines.props[line], distance };
          bestOn = on;
          bestRank = rank;
        }
      }
    }
  }
  return best;
}
