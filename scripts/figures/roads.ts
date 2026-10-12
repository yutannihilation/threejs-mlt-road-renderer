/**
 * Synthetic road networks, tessellated by the library and drawn as SVG the way the GPU draws
 * them: per draw group, every casing, then every fill, in index order. Coordinates are metres
 * around an origin, y pointing south.
 */
import type { Lines } from "../../src/lines";
import type { StyleTable } from "../../src/style";
import { collapseStubs } from "../../src/stubs";
import { continueShortLinks, type RoadMesh, tessellateRoads } from "../../src/tessellate";
import { type LineNodes, lineNodes } from "../../src/topology";
import { tileFrame } from "../../src/transform";
import { GROUND, polygon, type XY } from "./svg";

export interface Kind {
  readonly fill: string;
  readonly casing: string;
  /** Half the fill width, metres. */
  readonly half: number;
  /** The outline, metres per side. */
  readonly outline: number;
  readonly rank: number;
  readonly group?: number;
}

const CASING = "#5c5c5c";
export const MAJOR: Kind = { fill: "#f4b860", casing: CASING, half: 5, outline: 0.6, rank: 2 };
export const MINOR: Kind = { fill: "#ffffff", casing: CASING, half: 3, outline: 0.6, rank: 1 };
export const NARROW: Kind = { fill: "#ffffff", casing: CASING, half: 1.2, outline: 0.6, rank: 1 };
export const PATH: Kind = { fill: "#c9c9c9", casing: "#c9c9c9", half: 1, outline: 0, rank: 0 };

export interface Road {
  readonly points: readonly XY[];
  readonly kind: Kind;
}

// The world tile at the equator, where one tile unit is one metre.
const CENTRE = 2048;
const frame = tileFrame({ z: 0, x: 0, y: 0 }, 4096, 0);
const metre = 1 / 4096;

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

export interface Network {
  readonly lines: Lines;
  readonly nodes: LineNodes;
  readonly table: StyleTable;
  readonly mesh: RoadMesh;
}

/** Tessellate `roads`; `shortLinks` applies `continueShortLinks` as the layer does. */
export function network(roads: readonly Road[], shortLinks = true): Network {
  let total = 0;
  const lines: Lines = {
    vertices: Float64Array.from(
      roads.flatMap((r) => r.points.flatMap(([x, y]) => [CENTRE + x, CENTRE + y, 0])),
    ),
    lineStart: Uint32Array.from([0, ...roads.map((r) => (total += r.points.length))]),
    props: roads.map(() => ({})),
    startClipped: new Uint8Array(roads.length),
    endClipped: new Uint8Array(roads.length),
  };
  const n = roads.length;
  const group = Int32Array.from(roads, (r) => r.kind.group ?? 0);
  const evaluated: StyleTable = {
    lines: n,
    visible: new Uint8Array(n).fill(1),
    group,
    rank: Int32Array.from(roads, (r) => r.kind.rank),
    halfWidth: Float32Array.from(roads, (r) => r.kind.half),
    outerHalfWidth: Float32Array.from(roads, (r) => r.kind.half + r.kind.outline),
    fill: Uint8Array.from(roads.flatMap((r) => rgb(r.kind.fill))),
    casing: Uint8Array.from(roads.flatMap((r) => rgb(r.kind.casing))),
    groups: [...new Set(group)].sort((a, b) => a - b),
  };
  // As the layer builds a tile: stubs out, then short links restyled.
  const collapsed = collapseStubs(lines, frame, metre, evaluated, lineNodes(lines));
  const drawn = collapsed.lines;
  const nodes = lineNodes(drawn);
  const table = shortLinks
    ? continueShortLinks(drawn, frame, metre, collapsed.table, nodes)
    : collapsed.table;
  const mesh = tessellateRoads(drawn, frame, metre, table, nodes, "butt");
  return { lines: drawn, nodes, table, mesh };
}

/** A triangle of the mesh, in metres, for one pass. */
export interface Triangle {
  readonly points: [XY, XY, XY];
  readonly line: number;
  readonly pass: 0 | 1;
  /** All three vertices sit on the same centreline point: part of a junction's core. */
  readonly core: boolean;
}

/** Every triangle in draw order: per group, the casings, then the fills. */
export function triangles({ mesh, table }: Network): Triangle[] {
  const out: Triangle[] = [];
  const at = (i: number, pass: 0 | 1): XY => {
    const w = pass === 1 ? table.halfWidth : table.outerHalfWidth;
    const [l1, l2] = [mesh.widthLines[i * 2], mesh.widthLines[i * 2 + 1]];
    const e = mesh.extrudes.subarray(i * 4, i * 4 + 4);
    return [
      mesh.positions[i * 3] * 4096 - CENTRE + e[0] * w[l1] + e[2] * w[l2],
      mesh.positions[i * 3 + 1] * 4096 - CENTRE + e[1] * w[l1] + e[3] * w[l2],
    ];
  };
  for (const { start, count } of mesh.groups) {
    for (const pass of [0, 1] as const) {
      for (let k = start; k < start + count; k += 3) {
        const idx = [mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]];
        const same = idx.every(
          (i) =>
            mesh.positions[i * 3] === mesh.positions[idx[0] * 3] &&
            mesh.positions[i * 3 + 1] === mesh.positions[idx[0] * 3 + 1],
        );
        out.push({
          points: [at(idx[0], pass), at(idx[1], pass), at(idx[2], pass)],
          line: mesh.lines[idx[2]],
          pass,
          core: same,
        });
      }
    }
  }
  return out;
}

const hex = (c: ArrayLike<number>) =>
  `#${Array.from(c, (v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The network drawn as the GPU draws it, seen from above. */
export function draw(net: Network): string {
  return triangles(net)
    .map((t) => {
      const c = (t.pass === 1 ? net.table.fill : net.table.casing).subarray(
        t.line * 3,
        t.line * 3 + 3,
      );
      const colour = hex(c);
      // A hairline stroke in the same colour hides the seams SVG anti-aliasing leaves between
      // neighbouring triangles.
      return polygon(
        t.points,
        `fill="${colour}" stroke="${colour}" stroke-width="0.06" stroke-linejoin="round"`,
      );
    })
    .join("");
}

/** Each road drawn on its own, casing then fill, one after another: no shared outline. */
export function drawSeparately(roads: readonly Road[]): string {
  return roads.map((r) => draw(network([r]))).join("");
}

/** The fill pass's triangle edges, and the junction cores tinted. */
export function wireframe(net: Network, colour: string): string {
  return triangles(net)
    .filter((t) => t.pass === 1)
    .map((t) =>
      polygon(
        t.points,
        `fill="${t.core ? colour : "none"}" fill-opacity="${t.core ? 0.12 : 0}" stroke="${colour}" stroke-width="0.12" stroke-linejoin="round"`,
      ),
    )
    .join("");
}

/** A square view of `radius` metres around `centre`, placed at `origin`, `size` units across. */
export function view(origin: XY, size: number, centre: XY, radius: number, body: string): string {
  const [cx, cy] = centre;
  return [
    `<svg x="${origin[0]}" y="${origin[1]}" width="${size}" height="${size}" viewBox="${cx - radius} ${cy - radius} ${radius * 2} ${radius * 2}" overflow="hidden">`,
    `<rect x="${cx - radius}" y="${cy - radius}" width="${radius * 2}" height="${radius * 2}" fill="${GROUND}"/>`,
    body,
    "</svg>",
  ].join("");
}
