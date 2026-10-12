import { pushTo } from "./collections";
import type { Lines } from "./lines";
import type { Cap, StyleTable } from "./style";
import type { LineNodes, NodeEnd } from "./topology";
import { metreScale, type TileFrame, unitsPerMetreAt } from "./transform";

/**
 * A tile's roads as triangles whose widths are applied on the GPU. Every vertex sits on a
 * centreline point and carries its offset as up to two terms, each a vector times one line's half
 * width for the pass: `e1 * w(l1) + e2 * w(l2)`. A point inside one ribbon names its own line; a
 * junction corner, where one road's edge meets the next road's edge, names both. One geometry
 * therefore draws the casing at the outer widths and the fill at the fill widths, exact at every
 * junction in both, and a style change touches no vertex.
 */
export interface RoadMesh {
  /** `x, y, z` per vertex, in Web Mercator units relative to the tile's corner. */
  readonly positions: Float32Array;
  /** `e1x, e1y, e2x, e2y` per vertex, in the ground plane, in units of half widths. */
  readonly extrudes: Float32Array;
  /** `l1, l2` per vertex: the lines whose half widths scale `e1` and `e2`. */
  readonly widthLines: Uint32Array;
  /** The line each vertex takes its colour from. */
  readonly lines: Uint32Array;
  /** Three vertices per triangle. */
  readonly indices: Uint32Array;
  /** The index range of each draw group, in ascending group order; the ranges are contiguous. */
  readonly groups: readonly GroupRange[];
}

export interface GroupRange {
  readonly group: number;
  /** First index. */
  readonly start: number;
  /** Number of indices. */
  readonly count: number;
}

/** One term of an offset: `(ex, ey)` times line `line`'s half width. */
export interface Term {
  readonly line: number;
  readonly ex: number;
  readonly ey: number;
}

/** Turns up to this angle get a miter; sharper ones a round join. */
export const MITER_MAX_TURN = (15 * Math.PI) / 180;
/**
 * Where two lines of unequal widths meet near straight, the narrower's edge starts this many
 * metres along per metre of difference in half widths: a 1 : 3 taper.
 */
export const TAPER = 3;
/** The largest angle one triangle of a round join or cap spans. */
export const ARC_STEP = (15 * Math.PI) / 180;
/**
 * A road continues through a junction when every corner on each side of it lies on its edges,
 * give or take this fraction of its half width: what a slight bend at the node allows.
 */
export const CONTINUES_TOLERANCE = 0.5;
/**
 * Across a gap wider than a right angle, a junction corner farther from its node than this many
 * of the wider half width is not used.
 */
export const CORNER_LIMIT = 4;

/** A typed array that doubles its capacity as it fills. */
class Growing<A extends Float32Array | Uint32Array> {
  array: A;
  length = 0;
  private readonly make: (n: number) => A;

  constructor(make: (n: number) => A, capacity: number) {
    this.make = make;
    this.array = make(Math.max(16, capacity));
  }

  push(...values: number[]): void {
    if (this.length + values.length > this.array.length) {
      const grown = this.make(Math.max(this.array.length * 2, this.length + values.length));
      grown.set(this.array.subarray(0, this.length));
      this.array = grown;
    }
    for (const v of values) this.array[this.length++] = v;
  }

  done(): A {
    return this.array.slice(0, this.length) as A;
  }
}

/**
 * The canonical encoding of an offset: zero terms dropped, terms of one line summed, sorted by
 * line, padded with a zero term. Two vertices built from the same terms get bit-identical
 * attributes, so the GPU places them on exactly the same point.
 */
function encode(
  colour: number,
  terms: readonly Term[],
): [number, number, number, number, number, number] {
  const live: Term[] = [];
  for (const t of terms) {
    if (t.ex === 0 && t.ey === 0) continue;
    const i = live.findIndex((u) => u.line === t.line);
    if (i >= 0) live[i] = { line: t.line, ex: live[i].ex + t.ex, ey: live[i].ey + t.ey };
    else live.push(t);
  }
  if (live.length > 2) throw new Error(`an offset of ${live.length} lines; at most 2 are drawn`);
  if (live.length === 0) return [colour, 0, 0, colour, 0, 0];
  live.sort((a, b) => a.line - b.line);
  const [p, q = { line: p.line, ex: 0, ey: 0 }] = live;
  return [p.line, p.ex, p.ey, q.line, q.ex, q.ey];
}

/**
 * Each line's distinct `(x, y)` points as vertex indices, cached by line: a segment of no length
 * has no direction.
 */
function distinctPoints({ vertices, lineStart }: Lines): (l: number) => number[] {
  const cache = new Map<number, number[]>();
  return (l) => {
    let points = cache.get(l);
    if (!points) {
      points = [];
      for (let k = lineStart[l]; k < lineStart[l + 1]; k++) {
        const last = points.at(-1);
        if (
          last === undefined ||
          vertices[k * 3] !== vertices[last * 3] ||
          vertices[k * 3 + 1] !== vertices[last * 3 + 1]
        ) {
          points.push(k);
        }
      }
      cache.set(l, points);
    }
    return points;
  };
}

/** The unit direction from vertex `a` to vertex `b`, and the distance in tile units. */
function direction(vertices: ArrayLike<number>, a: number, b: number): [number, number, number] {
  const [ex, ey] = [vertices[b * 3] - vertices[a * 3], vertices[b * 3 + 1] - vertices[a * 3 + 1]];
  const len = Math.hypot(ex, ey);
  return [ex / len, ey / len, len];
}

/** The direction and length (tile units) of a line's first segment into it from its start or end. */
function firstSegment(
  vertices: ArrayLike<number>,
  points: readonly number[],
  atEnd: boolean,
): [number, number, number] {
  const n = points.length;
  return atEnd
    ? direction(vertices, points[n - 1], points[n - 2])
    : direction(vertices, points[0], points[1]);
}

/** Whether a line end is drawn: its line is visible and has two distinct points, so a direction. */
function liveEnds(table: StyleTable, pointsOf: (l: number) => number[]): (e: NodeEnd) => boolean {
  return (e) => table.visible[e.line] === 1 && pointsOf(e.line).length >= 2;
}

/**
 * The one other live end at the node a line's end leads to, where that is a node of two:
 * `undefined` at a free end or a junction.
 */
function continuation(
  nodes: LineNodes,
  live: (e: NodeEnd) => boolean,
  line: number,
  atEnd: boolean,
): NodeEnd | undefined {
  const node = atEnd ? nodes.endNode[line] : nodes.startNode[line];
  if (node < 0) return undefined;
  const others = nodes.nodes[node].filter(
    (e) => live(e) && !(e.line === line && e.atEnd === atEnd),
  );
  return others.length === 1 ? others[0] : undefined;
}

/** The visible lines in draw order: by group, then level (rank, lowered by junctions), then id. */
function drawOrder(table: StyleTable, level: Float64Array): number[] {
  const order: number[] = [];
  for (let line = 0; line < table.lines; line++) if (table.visible[line]) order.push(line);
  return order.sort((a, b) => table.group[a] - table.group[b] || level[a] - level[b] || a - b);
}

/**
 * The draw level of each line: its rank, lowered beneath the owner of every junction it ends at,
 * along with the lines it continues into through nodes of two, of its own group and rank. A road
 * merging into another is then drawn beneath it wherever they overlap, and shows only beyond its
 * edges; rank still orders roads overlapping without meeting.
 */
export function drawLevels(
  table: StyleTable,
  nodes: LineNodes,
  junctions: readonly { readonly owner: number; readonly lines: readonly number[] }[],
  live: (e: NodeEnd) => boolean,
): Float64Array {
  const level = Float64Array.from(table.rank);
  // Chains of lines continuing into one another through nodes of two.
  const chain = Int32Array.from({ length: table.lines }, (_, i) => i);
  const find = (l: number): number => {
    while (chain[l] !== l) l = chain[l] = chain[chain[l]];
    return l;
  };
  for (let a = 0; a < table.lines; a++) {
    for (const atEnd of [false, true]) {
      if (!live({ line: a, atEnd })) continue;
      const b = continuation(nodes, live, a, atEnd)?.line;
      if (b === undefined || table.group[a] !== table.group[b] || table.rank[a] !== table.rank[b])
        continue;
      chain[find(a)] = find(b);
    }
  }
  const members = new Map<number, number[]>();
  for (let l = 0; l < table.lines; l++) pushTo(members, find(l), l);
  // Lower until settled; a cycle of roads each ending at the other stops after a few rounds.
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const { owner, lines } of junctions) {
      for (const line of lines) {
        if (find(line) === find(owner) || table.group[line] !== table.group[owner]) continue;
        if (level[line] < level[owner]) continue;
        for (const l of members.get(find(line))!) {
          level[l] = Math.min(level[l], level[owner] - 0.5);
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
  return level;
}

/** A line end at a junction, leaving the node. */
interface Leaving {
  readonly line: number;
  readonly atEnd: boolean;
  /** The unit direction of its first segment out of the node, and the angle of it. */
  readonly ux: number;
  readonly uy: number;
  readonly angle: number;
  /** The length of that segment in metres. */
  readonly length: number;
  /**
   * How far the road runs on straight from the node, in metres along that segment's direction:
   * on along the line, and through nodes of two into lines drawn alike, while it turns no more
   * than a miter's turn from it. Only as far as a junction's corners can reach.
   */
  readonly run: number;
}

/** A node where two or more live ends meet: its vertex's element offset and the ends, by angle. */
interface Junction {
  readonly k: number;
  readonly leaving: Leaving[];
}

/** Where a line end stops at a junction: its corners, left and right looking out of the node. */
interface EndPair {
  readonly left: readonly Term[];
  readonly right: readonly Term[];
}

/** How two neighbouring line ends meet across the gap between them. */
interface Gap {
  /** The first line's corner, on its left edge. */
  readonly left: readonly Term[];
  /** The second line's corner, on its right edge; the same array when the corner is shared. */
  readonly right: readonly Term[];
  /** From `left` to `right` round the outside of the node, when they differ. */
  readonly chain: readonly (readonly Term[])[];
  /** Where the edges meet, when one line stops short of it on its own edge. */
  readonly corner?: readonly Term[];
  /**
   * Whether `corner` lies past both lines' first segments: where their edges would meet had they
   * run on straight, but both bend away before it, so nothing is filled out to it as it is.
   */
  readonly bent?: boolean;
  /** Whether `chain` is a taper between unequal widths meeting near straight. */
  readonly taper?: boolean;
  /**
   * Whether both lines stop square at the node because the owner's road has no edge where their
   * corner would be: the other line's square corner bounds nothing of the road's part.
   */
  readonly square?: boolean;
}

/** Part of the polygon filling a junction around its node, drawn by one of its lines. */
interface Core {
  /** The element offset of the node's vertex. */
  readonly k: number;
  /** Triangles, each three offsets; the empty offset is the node itself. */
  readonly triangles: readonly (readonly (readonly Term[])[])[];
}

const NODE: readonly Term[] = [];

/**
 * The style table with each link too short to taper from the road it continues drawn as that road.
 * Such a link meets a wider road of its group at a node of two, turning from it by at most a right
 * angle, runs to a junction of three or more ends, and is shorter than `TAPER` times the difference
 * in their half widths, the length the narrowing would take. The data splits a road there for a
 * narrower class over its last few metres; drawn as it is, the narrowing would fill the whole link
 * and the road would end in a wedge short of the junction. Returns a new table; the input is kept.
 */
export function continueShortLinks(
  input: Lines,
  frame: TileFrame,
  metre: number,
  table: StyleTable,
  nodes: LineNodes,
): StyleTable {
  const { vertices, lineStart } = input;
  const pointsOf = distinctPoints(input);
  const live = liveEnds(table, pointsOf);
  /** A line's length in metres. */
  const length = (l: number) => {
    let total = 0;
    for (let k = lineStart[l] + 1; k < lineStart[l + 1]; k++) {
      const [x0, y0, x1, y1] = [
        vertices[k * 3 - 3],
        vertices[k * 3 - 2],
        vertices[k * 3],
        vertices[k * 3 + 1],
      ];
      total += Math.hypot(x1 - x0, y1 - y0) / unitsPerMetreAt(frame, metre, (y0 + y1) / 2);
    }
    return total;
  };
  const out = {
    ...table,
    rank: Int32Array.from(table.rank),
    halfWidth: Float32Array.from(table.halfWidth),
    outerHalfWidth: Float32Array.from(table.outerHalfWidth),
    fill: Uint8Array.from(table.fill),
    casing: Uint8Array.from(table.casing),
  };
  for (let l = 0; l < table.lines; l++) {
    if (!live({ line: l, atEnd: false })) continue;
    for (const atEnd of [false, true]) {
      const far = atEnd ? nodes.startNode[l] : nodes.endNode[l];
      const other = continuation(nodes, live, l, atEnd);
      if (!other || far < 0 || nodes.nodes[far].filter(live).length < 3) continue;
      const w = other.line;
      if (w === l || table.group[w] !== table.group[l]) continue;
      const step = table.halfWidth[w] - table.halfWidth[l];
      if (step <= 0 || length(l) >= TAPER * step) continue;
      const [ax, ay] = firstSegment(vertices, pointsOf(l), atEnd);
      const [bx, by] = firstSegment(vertices, pointsOf(w), other.atEnd);
      // Opposite directions out of the node are straight on; a right angle's turn at most.
      if (ax * bx + ay * by > 0) continue;
      out.rank[l] = table.rank[w];
      out.halfWidth[l] = table.halfWidth[w];
      out.outerHalfWidth[l] = table.outerHalfWidth[w];
      out.fill.set(table.fill.subarray(w * 3, w * 3 + 3), l * 3);
      out.casing.set(table.casing.subarray(w * 3, w * 3 + 3), l * 3);
      break;
    }
  }
  return out;
}

/**
 * Tessellate the visible lines into a `RoadMesh`, their z placed by `frame`. `metre` is one metre
 * in Web Mercator units at the equator; elevations are scaled by the metre at each point's
 * latitude, as the shader scales the widths.
 *
 * At a node where two or more visible lines meet, the lines are taken in order of angle, and each
 * neighbouring pair meets at a corner: where the first one's left edge crosses the next one's
 * right edge, in both passes' widths. Each line stops at its two corners, and a core of triangles
 * around the node fills the rest, so the junction is exact and watertight. The owner's road (see
 * `ownerOf`) draws the core within its own outline; the other lines draw their mouths beneath it.
 * Where the edges diverge (the outer side of a bend) a round fan bridges them; where a corner would
 * fall too far out, or beyond the first segment of either line, the lines stop square at the node
 * and a triangle bridges them. A free
 * end gets `cap`; an end where the data runs out (clipped) gets none. Repeated `(x, y)` points are
 * skipped; a line left with one point emits nothing.
 */
export function tessellateRoads(
  input: Lines,
  frame: TileFrame,
  metre: number,
  table: StyleTable,
  nodes: LineNodes,
  cap: Cap,
): RoadMesh {
  const { vertices, startClipped, endClipped } = input;
  const { origin, scale, zScale, zOffset } = frame;
  const estimate = (vertices.length / 3) * 2;
  const positions = new Growing((n) => new Float32Array(n), estimate * 3);
  const extrudes = new Growing((n) => new Float32Array(n), estimate * 4);
  const widthLines = new Growing((n) => new Uint32Array(n), estimate * 2);
  const lines = new Growing((n) => new Uint32Array(n), estimate);
  const indices = new Growing((n) => new Uint32Array(n), estimate * 3);
  const groups: GroupRange[] = [];

  // The current point, in Mercator units relative to the tile.
  let px = 0;
  let py = 0;
  let pz = 0;
  /** A vertex at the current point, coloured by `colour`, offset by `terms`. */
  const vertex = (colour: number, terms: readonly Term[]): number => {
    const index = lines.length;
    const [l1, e1x, e1y, l2, e2x, e2y] = encode(colour, terms);
    positions.push(px, py, pz);
    extrudes.push(e1x, e1y, e2x, e2y);
    widthLines.push(l1, l2);
    lines.push(colour);
    return index;
  };
  const triangle = (a: number, b: number, c: number) => indices.push(a, b, c);
  /** Move the current point to the vertex at element offset `k`. */
  const moveTo = (k: number) => {
    px = vertices[k] * scale;
    py = vertices[k + 1] * scale;
    const metres = vertices[k + 2] * zScale + zOffset;
    pz = metres * metre * metreScale(origin[1] + py);
  };

  const pointsOf = distinctPoints(input);
  const live = liveEnds(table, pointsOf);

  const widths = [table.halfWidth, table.outerHalfWidth];
  const endPairs = new Map<string, EndPair>();
  const cores = new Map<number, Core[]>();
  const endKey = (line: number, atEnd: boolean) => `${line}:${atEnd ? 1 : 0}`;

  // The junctions: the nodes where two or more live ends meet.
  const junctions = nodes.nodes.flatMap((ends) => leavingAt(ends) ?? []);
  // First, how far along each line end its corners would reach, in metres in the wider pass, so
  // that the two ends of a short line can share its length.
  const needed = new Map<string, number>();
  for (const junction of junctions) {
    junction.leaving.forEach((a, i, all) => {
      const b = all[(i + 1) % all.length];
      const corner = cornerOf(a, b, gapAngle(all, i));
      if (!corner) return;
      for (const [end, along] of [
        [a, reach(corner, a)],
        [b, reach(corner, b)],
      ] as const) {
        const key = endKey(end.line, end.atEnd);
        needed.set(key, Math.max(needed.get(key) ?? 0, ...along));
      }
    });
  }
  const owners: { owner: number; lines: number[] }[] = [];
  for (const junction of junctions) buildJunction(junction);
  const level = drawLevels(table, nodes, owners, live);

  /**
   * How far along its first segment a line end may place its corners, in metres. A line with
   * more vertices keeps clear of the miter at its next one; a line of two shares its length with
   * its far end, in proportion to what each needs, when both together need more.
   */
  function allowance(end: Leaving): number {
    const outer = table.outerHalfWidth[end.line];
    if (pointsOf(end.line).length > 2) return end.length - outer * Math.tan(MITER_MAX_TURN / 2);
    const mine = needed.get(endKey(end.line, end.atEnd)) ?? 0;
    const other = needed.get(endKey(end.line, !end.atEnd)) ?? 0;
    if (mine + other <= end.length) return end.length - other;
    return (end.length * mine) / (mine + other);
  }

  /** The live line ends at a node leaving it, sorted by angle, if two or more meet there. */
  function leavingAt(ends: readonly NodeEnd[]): Junction | undefined {
    const ends_ = ends.filter(live);
    if (ends_.length < 2) return undefined;
    const first = pointsOf(ends_[0].line);
    const k = (ends_[0].atEnd ? first[first.length - 1] : first[0]) * 3;
    const unitsPerMetre = unitsPerMetreAt(frame, metre, vertices[k + 1]);
    const reach =
      CORNER_LIMIT * Math.max(...ends_.map((e) => table.outerHalfWidth[e.line])) * unitsPerMetre;
    const leaving: Leaving[] = ends_.map(({ line, atEnd }) => {
      const [ux, uy, len] = firstSegment(vertices, pointsOf(line), atEnd);
      const run = straightRun(line, atEnd, ux, uy, reach);
      return {
        line,
        atEnd,
        ux,
        uy,
        angle: Math.atan2(uy, ux),
        length: len / unitsPerMetre,
        run: run / unitsPerMetre,
      };
    });
    leaving.sort((a, b) => a.angle - b.angle);
    return { k, leaving };
  }

  /**
   * How far, in tile units along `(ux, uy)`, a line leaving a node runs on within a miter's turn of
   * that direction: along its segments, then through nodes of two into lines drawn alike, up to
   * `reach`.
   */
  function straightRun(
    line: number,
    atEnd: boolean,
    ux: number,
    uy: number,
    reach: number,
  ): number {
    const straight = Math.cos(MITER_MAX_TURN);
    const seen = new Set<number>();
    let run = 0;
    for (let [l, back] = [line, atEnd]; !seen.has(l);) {
      seen.add(l);
      const p = pointsOf(l);
      const n = p.length;
      for (let i = 1; i < n; i++) {
        const [dx, dy, len] = back
          ? direction(vertices, p[n - i], p[n - i - 1])
          : direction(vertices, p[i - 1], p[i]);
        const along = dx * ux + dy * uy;
        if (along < straight) return run;
        run += len * along;
        if (run >= reach) return run;
      }
      const next = continuation(nodes, live, l, !back);
      if (!next || !alike(l, next.line)) return run;
      [l, back] = [next.line, next.atEnd];
    }
    return run;
  }

  /** The angle of gap `i`, from `leaving[i]` to the next one round. */
  function gapAngle(leaving: readonly Leaving[], i: number): number {
    const [a, b] = [leaving[i], leaving[(i + 1) % leaving.length]];
    return i + 1 < leaving.length ? b.angle - a.angle : b.angle + 2 * Math.PI - a.angle;
  }

  /** The corners and core of a junction. */
  function buildJunction({ k, leaving }: Junction): void {
    const n = leaving.length;
    // Gap i lies between leaving[i]'s left edge and leaving[i + 1]'s right edge.
    const gaps = leaving.map((a, i) => gap(a, leaving[(i + 1) % n], gapAngle(leaving, i)));
    const { owner, partner } = ownerOf(leaving, gaps);
    // The road running through stays level; the others go beneath it.
    owners.push({ owner, lines: leaving.map((e) => e.line).filter((l) => l !== partner) });
    /**
     * The owner's road: the owner, the end it runs on into, and any end drawn like it but for its
     * width, as where a road narrows at a node.
     */
    const sameFill = (line: number) =>
      table.group[line] === table.group[owner] &&
      [0, 1, 2].every((c) => table.fill[line * 3 + c] === table.fill[owner * 3 + c]);
    const road = (line: number) =>
      line === owner ||
      line === partner ||
      (sameFill(line) && table.rank[line] === table.rank[owner]);
    const isRoad = leaving.map((e) => road(e.line));
    // An owner ending here runs on into an end of its colour leaving straight on, whatever that
    // end's rank, as a motorway into its ramp.
    if (partner === undefined && isRoad.filter(Boolean).length === 1) {
      const end = leaving[isRoad.indexOf(true)];
      const on = leaving.findIndex(
        (e) =>
          e !== end &&
          sameFill(e.line) &&
          Math.PI - Math.abs(Math.abs(e.angle - end.angle) - Math.PI) >= Math.PI - MITER_MAX_TURN,
      );
      if (on >= 0) isRoad[on] = true;
    }
    // Where another road's edge meets the road's beyond where the road runs straight, as on a
    // roundabout curving away from a wide road entering it, the road's edge is not there: both stop
    // square at the node, the other road beneath the road, whose own band covers its end.
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const corner = gaps[i].corner;
      if (!corner || isRoad[i] === isRoad[j]) continue;
      const end = isRoad[i] ? leaving[i] : leaving[j];
      if (reach(corner, end).some((d) => d > end.run + 1e-9)) {
        gaps[i] = { ...squareGap(leaving[i], leaving[j], gapAngle(leaving, i)), square: true };
      }
    }
    for (let i = 0; i < n; i++) {
      const { line, atEnd } = leaving[i];
      endPairs.set(endKey(line, atEnd), {
        left: gaps[i].left,
        right: gaps[(i + n - 1) % n].right,
      });
    }
    /**
     * A gap's fill beneath the owner's: the owner's between two ends of its road, else that of the
     * other road beside it, or of the more dominant of two other roads.
     */
    const gapLine = (i: number) => {
      const j = (i + 1) % n;
      const [a, b] = [leaving[i].line, leaving[j].line];
      if (isRoad[i] && isRoad[j]) return owner;
      if (isRoad[i]) return b;
      if (isRoad[j]) return a;
      return dominates(a, b) ? a : b;
    };
    // The core, each part drawn by a line, so at its level and in its colour: each line's mouth,
    // from the node to its two corners, and its notches; the gaps between the lines; and, on each
    // side of the owner's road where other roads leave between its ends, the owner's part of the
    // junction: up to the other roads' mouths, but no farther than the road's own outline.
    const parts = new Map<number, (readonly Term[])[][]>();
    const add = (line: number, triangle: (readonly Term[])[]) => pushTo(parts, line, triangle);
    for (let i = 0; i < n; i++) {
      const [before, after] = [gaps[(i + n - 1) % n], gaps[i]];
      const by = isRoad[i] ? owner : leaving[i].line;
      add(by, [NODE, before.right, after.left]);
      const chain = after.chain;
      for (let j = 0; j + 1 < chain.length; j++) add(gapLine(i), [NODE, chain[j], chain[j + 1]]);
      // A line stopped short of a corner leaves a notch between where it stops and the edge
      // it should have reached: fill it to the corner, as its own, so the edge runs straight past;
      // not to a corner past where both lines bend. Towards another road, the owner's side covers it.
      const notch = (g: Gap, other: number) =>
        g.corner && !g.bent && (!isRoad[i] || isRoad[other]) ? g.corner : undefined;
      const beforeCorner = notch(before, (i + n - 1) % n);
      if (beforeCorner && before.right !== beforeCorner) {
        add(by, [beforeCorner, before.right, after.left]);
      }
      const afterCorner = notch(after, (i + 1) % n);
      if (afterCorner && after.left !== afterCorner) {
        add(by, [before.right, after.left, afterCorner]);
      }
    }
    // A road with one end here ends at the node: its part is its own mouth, and the other roads
    // fill the rest of the junction, as they leave it.
    const roadEnds = leaving.flatMap((_, i) => (isRoad[i] ? [i] : []));
    if (roadEnds.length > 1)
      roadEnds.forEach((i, r) => {
        const j = roadEnds[(r + 1) % roadEnds.length];
        // Next to each other, two ends of the road leave no one between them.
        if ((j - i + n) % n === 1) return;
        for (const triangle of side(leaving, gaps, isRoad, i, j)) add(owner, triangle);
      });
    for (const [line, triangles] of parts) pushTo(cores, line, { k, triangles });
  }

  /**
   * The owner's part of a junction on the side counter-clockwise from its road's end `i` to
   * another of its ends `j`: the junction's polygon there, from `i`'s left corner through the other
   * roads' mouths to `j`'s right corner, as the old single-colour core drew it, but no farther out
   * than the road's own outline: `i`'s left edge, `j`'s right edge, and between them, round a
   * reflex side, a round join. A corner beyond it, as where two other roads part at a sharp angle
   * far out, is pulled in onto it. Every point stays a combination of half widths, so both passes
   * draw it exactly.
   */
  function side(
    leaving: readonly Leaving[],
    gaps: readonly Gap[],
    road: readonly boolean[],
    i: number,
    j: number,
  ): (readonly Term[])[][] {
    const n = leaving.length;
    const [a, b] = [leaving[i], leaving[j]];
    const count = (j - i + n) % n;
    const theta = (((b.angle - a.angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const [wa, wb] = [table.halfWidth[a.line], table.halfWidth[b.line]];
    const sweep = theta - Math.PI;
    /**
     * The outline at angle `psi` from `a`, counter-clockwise: how far out, and the point there.
     * Ahead of the node along `a` (within a right angle of it), `a`'s left edge as far as its first
     * segment runs, then across its end; likewise along `b`, its right edge; ahead of both, the
     * farther, the road being both links there; between them, round a reflex side, the join, its
     * radius going from `a`'s half width to `b`'s.
     */
    const outline = (psi: number): { r: number; terms: Term[]; edge: boolean } => {
      const [dx, dy] = [Math.cos(a.angle + psi), Math.sin(a.angle + psi)];
      const strip = (end: Leaving, w: number, off: number, side: 1 | -1) => {
        const [sin, cos] = [Math.sin(off), Math.cos(off)];
        const [toEdge, toEnd] = [sin > 1e-9 ? w / sin : Infinity, end.run / cos];
        if (toEdge <= toEnd) {
          const cot = cos / sin;
          const terms: Term[] = [
            { line: end.line, ex: -side * end.uy + cot * end.ux, ey: side * end.ux + cot * end.uy },
          ];
          return { r: toEdge, terms, edge: true };
        }
        return {
          r: toEnd,
          terms: [{ line: end.line, ex: (toEnd / w) * dx, ey: (toEnd / w) * dy }],
          edge: false,
        };
      };
      const alongA = psi < Math.PI / 2 ? strip(a, wa, psi, 1) : undefined;
      const alongB = theta - psi < Math.PI / 2 ? strip(b, wb, theta - psi, -1) : undefined;
      // Ahead of both, the road is both links: out to the farther edge.
      if (alongA && alongB) return alongA.r >= alongB.r ? alongA : alongB;
      if (alongA) return alongA;
      if (alongB) return alongB;
      const f = sweep > 1e-9 ? (psi - Math.PI / 2) / sweep : 0;
      return {
        r: (1 - f) * wa + f * wb,
        terms: [
          { line: a.line, ex: (1 - f) * dx, ey: (1 - f) * dy },
          { line: b.line, ex: f * dx, ey: f * dy },
        ],
        edge: false,
      };
    };
    /** A point's angle from `a`, counter-clockwise, within the side; and its distance. */
    const place = (terms: readonly Term[]): { psi: number; r: number } => {
      const [[x, y]] = cornerAt(terms);
      let psi = (((Math.atan2(y, x) - a.angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      // Just outside the side, as a notch's corner may be: at its nearer end.
      if (psi > theta) psi = psi - theta < 2 * Math.PI - psi ? theta : 0;
      return { psi, r: Math.hypot(x, y) };
    };
    // The polygon's outer points in order, each mouth between two: each gap's corner (where a road
    // stopped short of it, its notch reaches it), else its rim.
    // A corner past where both its lines bend is no boundary: beside it, the outline is.
    const polygon: { terms: readonly Term[]; free: boolean; others: boolean }[] = [];
    for (let s = 0; s < count; s++) {
      const g = gaps[(i + s) % n];
      // Where one of the road's two ends and another road taper into each other, the outline
      // bounds the road, not how the other road bridges to it.
      const byEnd = (s === 0 || s === count - 1) && !!g.taper;
      const others = !road[(i + s) % n] && !road[(i + s + 1) % n];
      // Where the other road stops square beneath the road, only the road's own corner counts.
      const ps = g.square
        ? [road[(i + s) % n] ? g.left : g.right]
        : g.corner
          ? [g.corner]
          : g.chain.length
            ? g.chain
            : [g.left];
      for (const p of ps) {
        const free = p === g.corner ? !!g.bent : byEnd;
        // Their corner proper, not a rim round a reflex gap or a taper.
        const meet = p === g.corner || (g.left === g.right && p === g.left);
        if (polygon.at(-1)?.terms !== p) polygon.push({ terms: p, free, others: others && meet });
      }
    }
    // Pulled in onto the outline where beyond it. Where two other roads meet each other against
    // one of the road's own edges, pushed out onto that edge: the road runs on unbroken past them.
    // Its join round a bend is no edge of its own, and leaves them their mouths.
    const points = polygon.map(({ terms, free, others }) => {
      const { psi, r } = place(terms);
      const limit = outline(psi);
      const inside = r <= limit.r + 1e-9;
      // Where two other roads meet each other against one of the road's edges, out onto it.
      const pushed = inside && others && limit.edge;
      return {
        terms: inside && !pushed ? terms : limit.terms,
        psi,
        r: pushed ? limit.r : r,
        free,
        at: cornerAt(pushed ? limit.terms : terms)[0],
      };
    });
    // Where the outline bends, between two points, and lies inside the polygon's own edge there,
    // it is the boundary: follow it round its corners and its join. Beside a free point, follow it
    // all the way to the next point's ray.
    const bends = [Math.atan2(wa, a.length), theta - Math.atan2(wb, b.length)];
    // Round the join only where the road turns: a side nearly straight is a change of width, which
    // the mouths of the roads leaving there bound.
    if (sweep >= MITER_MAX_TURN) {
      for (let psi = Math.PI / 2; psi < theta - Math.PI / 2; psi += ARC_STEP) bends.push(psi);
      bends.push(theta - Math.PI / 2);
    }
    bends.sort((x, y) => x - y);
    /** How far out along the ray at `psi` the segment from `q` to `p` lies, if it crosses it. */
    const across = (psi: number, [qx, qy]: number[], [px, py]: number[]) => {
      const [dx, dy] = [Math.cos(a.angle + psi), Math.sin(a.angle + psi)];
      const [ex, ey] = [px - qx, py - qy];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) return undefined;
      const t = (qx * ey - qy * ex) / den;
      const s = (qx * dy - qy * dx) / den;
      return s >= -1e-9 && s <= 1 + 1e-9 && t > 0 ? t : undefined;
    };
    const rim: (readonly Term[])[] = [];
    /** The outline at `psi`, where it lies beyond the point `p` on that ray. */
    const beyond = (p: (typeof points)[number]) => {
      const limit = outline(p.psi);
      return limit.r > p.r + 1e-9 ? [limit.terms] : [];
    };
    points.forEach((p, k) => {
      const q = points[k - 1];
      if (q) {
        const free = q.free || p.free;
        if (free) rim.push(...beyond(q));
        for (const psi of bends) {
          if (psi <= q.psi + 1e-9 || psi >= p.psi - 1e-9) continue;
          const edge = across(psi, q.at, p.at);
          const limit = outline(psi);
          if (free || (edge !== undefined && limit.r < edge - 1e-9)) rim.push(limit.terms);
        }
        if (free) rim.push(...beyond(p));
      }
      rim.push(p.terms);
    });
    const triangles = rim.slice(1).map((terms, k) => [NODE, rim[k], terms]);
    // Past the side's first and last points, each link's own body on this side, out to its square
    // end at the node, is the road's too: the mouths there leave part of it uncovered.
    const fan = (from: (typeof points)[number], to: number, end: readonly Term[]) => {
      const run: (readonly Term[])[] = [...beyond(from)];
      const [lo, hi] = from.psi < to ? [from.psi, to] : [to, from.psi];
      const inner = bends.filter((psi) => psi > lo + 1e-9 && psi < hi - 1e-9);
      for (const psi of from.psi < to ? inner : inner.reverse()) run.push(outline(psi).terms);
      run.push(end);
      const start = [from.terms, ...run];
      for (let k = 0; k + 1 < start.length; k++) triangles.push([NODE, start[k], start[k + 1]]);
    };
    const [first, last] = [points[0], points[points.length - 1]];
    if (last.psi < Math.PI / 2) fan(last, Math.PI / 2, [{ line: a.line, ex: -a.uy, ey: a.ux }]);
    if (theta - first.psi < Math.PI / 2) {
      fan(first, theta - Math.PI / 2, [{ line: b.line, ex: b.uy, ey: -b.ux }]);
    }
    return triangles;
  }

  /**
   * The line whose colour fills a junction's polygon, whose edges are the mouths of the roads
   * meeting there. A road continues through the junction when two ends drawn alike leave it so that,
   * on each side, the polygon between them lies along the edges those two ends would form on their
   * own: filled in its colour, its edges then run straight on past the other roads, which stop at
   * them.
   * Of several such roads (a crossing), the one that draws on top owns it; with none, the line
   * that draws on top. Rank comes before running straight: a road with two ends drawn alike
   * turning by at most a right angle owns it over a lower group or rank running through, with the
   * straightest such pair. `partner` is the owner's other end, where the owner runs through.
   */
  function ownerOf(
    leaving: readonly Leaving[],
    gaps: readonly Gap[],
  ): { owner: number; partner?: number } {
    const n = leaving.length;
    const top = leaving.map((e) => e.line).reduce((a, b) => (dominates(b, a) ? b : a));
    let owner: number | undefined;
    let partner: number | undefined;
    // The highest-ranked pair of ends drawn alike that does not run through, and its turn.
    let bent: { owner: number; partner: number; turn: number } | undefined;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const [p, q] = [leaving[i], leaving[j]];
        // Counter-clockwise from p to q, then from q round to p.
        if (!alike(p.line, q.line)) continue;
        const theta = q.angle - p.angle;
        const sideA = continues(p, q, theta, gaps.slice(i, j));
        const sideB =
          sideA && continues(q, p, 2 * Math.PI - theta, [...gaps.slice(j), ...gaps.slice(0, i)]);
        const [line, other] = dominates(p.line, q.line) ? [p.line, q.line] : [q.line, p.line];
        if (sideA && sideB) {
          if (owner === undefined || dominates(line, owner)) [owner, partner] = [line, other];
          continue;
        }
        const turn = Math.abs(Math.PI - theta);
        if (turn > Math.PI / 2) continue;
        const order = bent === undefined ? 1 : outranks(line, bent.owner);
        if (order > 0 || (order === 0 && turn < bent!.turn))
          bent = { owner: line, partner: other, turn };
      }
    }
    if (owner !== undefined && bent !== undefined && outranks(bent.owner, owner) > 0) {
      return { owner: bent.owner, partner: bent.partner };
    }
    return owner === undefined ? { owner: top } : { owner, partner };
  }

  /**
   * Whether the corners of `between`, the gaps counter-clockwise from `a` to `b` across the angle
   * `theta`, all lie along the edge `a` and `b` would form on their own: `a`'s left edge and `b`'s
   * right edge, each running out from the corner where they meet, in the fill pass. Where a line
   * stopped short of a corner, the corner it could not reach counts. With no road between them,
   * they meet directly and the side is continuous; where their edges never meet, it is not.
   */
  function continues(a: Leaving, b: Leaving, theta: number, between: readonly Gap[]): boolean {
    if (between.length <= 1) return true;
    const corner = rawCorner(a, b, theta);
    if (!corner) return false;
    const [[cx, cy]] = cornerAt(corner);
    const w = table.halfWidth;
    const slack = CONTINUES_TOLERANCE * Math.min(w[a.line], w[b.line]);
    /** The distance from `[x, y]` to the ray from the corner along `(ux, uy)`. */
    const toRay = (x: number, y: number, ux: number, uy: number) => {
      const along = Math.max(0, (x - cx) * ux + (y - cy) * uy);
      return Math.hypot(x - cx - along * ux, y - cy - along * uy);
    };
    return between.every((gap) =>
      (gap.corner ? [gap.corner] : [gap.left, gap.right, ...gap.chain]).every((terms) => {
        const [[x, y]] = cornerAt(terms);
        return Math.min(toRay(x, y, a.ux, a.uy), toRay(x, y, b.ux, b.uy)) <= slack;
      }),
    );
  }

  /** Whether two lines are drawn alike, so that two of their ends can be one road. */
  function alike(a: number, b: number): boolean {
    return (
      table.group[a] === table.group[b] &&
      table.rank[a] === table.rank[b] &&
      table.halfWidth[a] === table.halfWidth[b] &&
      table.outerHalfWidth[a] === table.outerHalfWidth[b] &&
      [0, 1, 2].every((c) => table.fill[a * 3 + c] === table.fill[b * 3 + c])
    );
  }

  /**
   * Where `a`'s left edge meets `b`'s right edge across the angle `theta`, as offset terms, with
   * no limit on how far out: `undefined` where they diverge or run parallel.
   */
  function rawCorner(a: Leaving, b: Leaving, theta: number): Term[] | undefined {
    const [nax, nay, nbx, nby] = [-a.uy, a.ux, -b.uy, b.ux];
    const equal =
      table.halfWidth[a.line] === table.halfWidth[b.line] &&
      table.outerHalfWidth[a.line] === table.outerHalfWidth[b.line];
    if (equal && theta <= Math.PI + MITER_MAX_TURN) {
      const den = 1 - (nax * nbx + nay * nby);
      return den > 1e-9
        ? [{ line: Math.min(a.line, b.line), ex: (nax - nbx) / den, ey: (nay - nby) / den }]
        : undefined;
    }
    const sin = Math.sin(theta);
    if (equal || theta >= Math.PI || sin <= 1e-9) return undefined;
    return [
      { line: a.line, ex: b.ux / sin, ey: b.uy / sin },
      { line: b.line, ex: a.ux / sin, ey: a.uy / sin },
    ];
  }

  /** How `a` orders against `b` by group, then rank alone: positive where it draws above. */
  function outranks(a: number, b: number): number {
    return table.group[a] - table.group[b] || table.rank[a] - table.rank[b];
  }

  /** Whether line `a` draws over line `b`: a higher group, then rank, then width, then lower id. */
  function dominates(a: number, b: number): boolean {
    const order =
      table.group[a] - table.group[b] ||
      table.rank[a] - table.rank[b] ||
      table.outerHalfWidth[a] - table.outerHalfWidth[b] ||
      b - a;
    return order > 0;
  }

  /**
   * Where `a`'s left edge meets `b`'s right edge, `theta` being the angle from `a` to `b` counter
   * to the clock of the tile's axes, as offset terms; `undefined` where they diverge (a reflex
   * gap), run parallel, or meet farther out than `CORNER_LIMIT`.
   */
  function cornerOf(a: Leaving, b: Leaving, theta: number): Term[] | undefined {
    const corner = rawCorner(a, b, theta);
    // Edges meeting across a wide gap are near-parallel offsets of one another, as where a road
    // changes width: a far corner is no corner. Across an acute gap, as where a ramp merges, a far
    // corner is where the roads truly part; the allowances bound it.
    return corner && (theta < Math.PI / 2 || withinLimit(corner, a, b)) ? corner : undefined;
  }

  /**
   * How `a` and `b` meet across the gap between them. `left` is `a`'s corner and `right` is
   * `b`'s: the same offset when their edges meet within both lines' allowances. A line whose
   * allowance the corner exceeds stops on its own edge, as far along as it may in every pass, and
   * `chain` bridges the two; where the edges never meet, each stops square at the node and
   * `chain` runs from one to the other, round over a reflex gap.
   */
  function gap(a: Leaving, b: Leaving, theta: number): Gap {
    const [nax, nay, nbx, nby] = [-a.uy, a.ux, -b.uy, b.ux];
    const found = cornerOf(a, b, theta);
    // A corner far behind the node, where near-parallel edges of unequal widths meet, is none.
    const corner =
      found &&
      widths.every((w, p) => {
        const behind = -Math.max(w[a.line], w[b.line]);
        return reach(found, a)[p] >= behind && reach(found, b)[p] >= behind;
      })
        ? found
        : undefined;
    if (corner) {
      const [allowA, allowB] = [allowance(a), allowance(b)];
      const [sA, tB] = [reach(corner, a), reach(corner, b)];
      const fitsA = sA.every((d) => d <= allowA);
      const fitsB = tB.every((d) => d <= allowB);
      if (fitsA && fitsB) return { left: corner, right: corner, chain: [] };
      /** The largest fraction of the half width a line may run along, in every pass. */
      const along = (d: readonly number[], allow: number, line: number) =>
        Math.max(
          0,
          Math.min(...widths.map((w, p) => (w[line] ? Math.min(d[p], allow) / w[line] : Infinity))),
        );
      const ka = along(sA, allowA, a.line);
      const kb = along(tB, allowB, b.line);
      const left: readonly Term[] = fitsA
        ? corner
        : [{ line: a.line, ex: nax + ka * a.ux, ey: nay + ka * a.uy }];
      const right: readonly Term[] = fitsB
        ? corner
        : [{ line: b.line, ex: -nbx + kb * b.ux, ey: -nby + kb * b.uy }];
      const within = (d: readonly number[], end: Leaving) => d.every((x) => x <= end.run + 1e-9);
      const bent = !within(sA, a) && !within(tB, b);
      return { left, right, chain: [left, right], corner, bent };
    }
    const unequal =
      table.halfWidth[a.line] !== table.halfWidth[b.line] ||
      table.outerHalfWidth[a.line] !== table.outerHalfWidth[b.line];
    if (unequal && theta >= Math.PI / 2 && theta <= Math.PI + MITER_MAX_TURN) {
      // Unequal widths meeting near straight: the wider stops square at the node and the
      // narrower's edge starts `TAPER` times the difference in half widths further on, so the step
      // is a slanted face the casing outlines.
      const wider = table.outerHalfWidth[a.line] >= table.outerHalfWidth[b.line] ? a : b;
      const narrower = wider === a ? b : a;
      const taper = Math.min(
        TAPER,
        ...widths.map((w) => {
          const step = w[wider.line] - w[narrower.line];
          return step > 0 ? allowance(narrower) / step : Infinity;
        }),
      );
      const [ux, uy] = [narrower.ux, narrower.uy];
      if (wider === a) {
        const left: Term[] = [{ line: a.line, ex: nax, ey: nay }];
        const right: Term[] = [
          { line: b.line, ex: -nbx - taper * ux, ey: -nby - taper * uy },
          { line: a.line, ex: taper * ux, ey: taper * uy },
        ];
        return { left, right, chain: [left, right], taper: true };
      }
      const right: Term[] = [{ line: b.line, ex: -nbx, ey: -nby }];
      const left: Term[] = [
        { line: a.line, ex: nax - taper * ux, ey: nay - taper * uy },
        { line: b.line, ex: taper * ux, ey: taper * uy },
      ];
      return { left, right, chain: [left, right], taper: true };
    }
    return squareGap(a, b, theta);
  }

  /**
   * Both lines stopping square at the node, `chain` running from `a`'s left corner to `b`'s right
   * one, round over a reflex gap.
   */
  function squareGap(a: Leaving, b: Leaving, theta: number): Gap {
    const [nax, nay, nbx, nby] = [-a.uy, a.ux, -b.uy, b.ux];
    const left: Term[] = [{ line: a.line, ex: nax, ey: nay }];
    const right: Term[] = [{ line: b.line, ex: -nbx, ey: -nby }];
    const sweep = theta - Math.PI;
    const steps = sweep > 0 ? Math.ceil(sweep / ARC_STEP) : 1;
    const chain: (readonly Term[])[] = [left];
    for (let j = 1; j < steps; j++) {
      // Round from a's left to b's right, the radius going from a's half width to b's.
      const f = j / steps;
      const [c, s] = [Math.cos(f * sweep), Math.sin(f * sweep)];
      const [dx, dy] = [nax * c - nay * s, nax * s + nay * c];
      chain.push([
        { line: a.line, ex: (1 - f) * dx, ey: (1 - f) * dy },
        { line: b.line, ex: f * dx, ey: f * dy },
      ]);
    }
    chain.push(right);
    return { left, right, chain };
  }

  /** The corner in each pass, in metres from the node. */
  function cornerAt(corner: readonly Term[]): [number, number][] {
    return widths.map((w) => {
      let [cx, cy] = [0, 0];
      for (const t of corner) {
        cx += t.ex * w[t.line];
        cy += t.ey * w[t.line];
      }
      return [cx, cy];
    });
  }

  /** How far along `end`'s direction the corner lies, in each pass, in metres. */
  function reach(corner: readonly Term[], end: Leaving): number[] {
    return cornerAt(corner).map(([cx, cy]) => cx * end.ux + cy * end.uy);
  }

  /** Whether a corner lies within `CORNER_LIMIT` of the wider half width, in both passes. */
  function withinLimit(corner: readonly Term[], a: Leaving, b: Leaving): boolean {
    return cornerAt(corner).every(
      ([cx, cy], p) =>
        Math.hypot(cx, cy) <= CORNER_LIMIT * Math.max(widths[p][a.line], widths[p][b.line]) + 1e-12,
    );
  }

  let line = 0;
  const own = (ex: number, ey: number): Term[] => [{ line, ex, ey }];
  /**
   * A fan around the current point from `(fx, fy)` through the angle `sweep`, between the
   * existing vertices `from` and `to`. Round joins inside a line.
   */
  const fan = (from: number, to: number, fx: number, fy: number, sweep: number) => {
    const centre = vertex(line, NODE);
    const steps = Math.ceil(Math.abs(sweep) / ARC_STEP);
    let previous = from;
    for (let j = 1; j < steps; j++) {
      const angle = (sweep * j) / steps;
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      const arc = vertex(line, own(fx * c - fy * s, fx * s + fy * c));
      triangle(centre, previous, arc);
      previous = arc;
    }
    triangle(centre, previous, to);
  };
  /**
   * Close a free end at the current point: `(dx, dy)` points out of the line there, `left` and
   * `right` are the end's pair, left being to the left of the line's own direction.
   */
  const closeEnd = (kind: Cap, dx: number, dy: number, left: number, right: number) => {
    const [nx, ny] = [-dy, dx];
    if (kind === "round") {
      const centre = vertex(line, NODE);
      let previous = vertex(line, own(nx, ny));
      const steps = Math.ceil(Math.PI / ARC_STEP);
      for (let j = 1; j <= steps; j++) {
        const angle = (Math.PI * j) / steps;
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        const rim = vertex(line, own(nx * c + dx * s, ny * c + dy * s));
        triangle(centre, previous, rim);
        previous = rim;
      }
    } else if (kind === "square") {
      const cornerLeft = vertex(line, own(nx + dx, ny + dy));
      const cornerRight = vertex(line, own(-nx + dx, -ny + dy));
      triangle(left, right, cornerLeft);
      triangle(right, cornerRight, cornerLeft);
    }
  };
  /** Draw a junction's core around its node, in the current line's colour. */
  const drawCore = ({ k, triangles }: Core) => {
    moveTo(k);
    const index = new Map<readonly Term[], number>();
    const at = (terms: readonly Term[]) => {
      let i = index.get(terms);
      if (i === undefined) {
        i = vertex(line, terms);
        index.set(terms, i);
      }
      return i;
    };
    for (const [a, b, c] of triangles) triangle(at(a), at(b), at(c));
  };

  let currentGroup: { group: number; start: number; count: number } | undefined;
  for (const l of drawOrder(table, level)) {
    line = l;
    const group = table.group[line];
    if (!currentGroup || currentGroup.group !== group) {
      currentGroup = { group, start: indices.length, count: 0 };
      groups.push(currentGroup);
    }
    const points = pointsOf(line);
    const m = points.length;
    if (m < 2) continue;
    // Each segment's unit direction; tile coordinates and Mercator units share their axes.
    const dx = new Float64Array(m - 1);
    const dy = new Float64Array(m - 1);
    for (let i = 0; i + 1 < m; i++) [dx[i], dy[i]] = direction(vertices, points[i], points[i + 1]);
    const startPair = endPairs.get(`${line}:0`);
    const endPair = endPairs.get(`${line}:1`);

    // The pair (left, right) the previous segment starts from, and the line's first pair.
    let fromLeft = 0;
    let fromRight = 0;
    let firstLeft = 0;
    let firstRight = 0;
    for (let i = 0; i < m; i++) {
      moveTo(points[i] * 3);
      // The pairs this point ends the incoming segment with, and starts the outgoing one from.
      let toLeft: number;
      let toRight: number;
      let nextLeft: number;
      let nextRight: number;
      if (i === 0 && startPair) {
        // Leaving the node is the line's own direction, so left is left.
        toLeft = nextLeft = vertex(line, startPair.left);
        toRight = nextRight = vertex(line, startPair.right);
      } else if (i === m - 1 && endPair) {
        // Leaving the node runs against the line, so the line's left is the pair's right.
        toLeft = nextLeft = vertex(line, endPair.right);
        toRight = nextRight = vertex(line, endPair.left);
      } else if (i === 0 || i === m - 1) {
        const s = i === 0 ? 0 : m - 2;
        const [nx, ny] = [-dy[s], dx[s]];
        toLeft = nextLeft = vertex(line, own(nx, ny));
        toRight = nextRight = vertex(line, own(-nx, -ny));
      } else {
        const [ax, ay, bx, by] = [dx[i - 1], dy[i - 1], dx[i], dy[i]];
        const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by); // signed, left positive
        const [n0x, n0y, n1x, n1y] = [-ay, ax, -by, bx];
        if (Math.abs(turn) <= MITER_MAX_TURN) {
          // One pair on the bisector, pushed out so that both edges keep their width.
          const [mx, my] = [n0x + n1x, n0y + n1y];
          const stretch = 1 / (mx * n0x + my * n0y);
          toLeft = nextLeft = vertex(line, own(mx * stretch, my * stretch));
          toRight = nextRight = vertex(line, own(-mx * stretch, -my * stretch));
        } else {
          toLeft = vertex(line, own(n0x, n0y));
          toRight = vertex(line, own(-n0x, -n0y));
          nextLeft = vertex(line, own(n1x, n1y));
          nextRight = vertex(line, own(-n1x, -n1y));
          // A fan around the point on the outer side, which is the right of a left turn.
          const side = turn > 0 ? -1 : 1;
          fan(
            side > 0 ? toLeft : toRight,
            side > 0 ? nextLeft : nextRight,
            side * n0x,
            side * n0y,
            turn,
          );
        }
      }
      if (i > 0) {
        triangle(fromLeft, fromRight, toLeft);
        triangle(fromRight, toRight, toLeft);
      } else {
        firstLeft = nextLeft;
        firstRight = nextRight;
      }
      fromLeft = nextLeft;
      fromRight = nextRight;
    }
    // Free ends take the style's cap; the current point is the last one, then back to the first.
    if (!endPair && !endClipped[line]) closeEnd(cap, dx[m - 2], dy[m - 2], fromLeft, fromRight);
    if (!startPair && !startClipped[line] && cap !== "butt") {
      moveTo(points[0] * 3);
      // Out of the line at its start is against its first direction; the pair's left is still
      // to the left of that direction, so the rim runs from the left side round the back.
      closeEnd(cap, -dx[0], -dy[0], firstRight, firstLeft);
    }
    for (const core of cores.get(line) ?? []) drawCore(core);
    currentGroup.count = indices.length - currentGroup.start;
  }
  return {
    positions: positions.done(),
    extrudes: extrudes.done(),
    widthLines: widthLines.done(),
    lines: lines.done(),
    indices: indices.done(),
    groups,
  };
}
