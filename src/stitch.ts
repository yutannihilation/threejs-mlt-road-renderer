import { pushTo } from "./collections";
import type { Lines } from "./lines";
import type { Props } from "./style";
import type { LineTile } from "./tile";

/**
 * One line of a tile, or a line stitched from such pieces: `x, y, z` per vertex, x and y in tile
 * units of the tile being built (a neighbour's pieces are shifted by whole tiles), z in metres.
 */
export interface Piece {
  readonly vertices: Float64Array;
  readonly props: Props;
  /** Whether the first (last) vertex is where the tiler cut the line, not where it ends. */
  readonly startClipped: boolean;
  readonly endClipped: boolean;
}

/**
 * How far, in tile units, a clip vertex may lie from the segment it was cut from: the tiler rounds
 * it to the grid, which moves it by up to half a unit on each axis.
 */
export const STITCH_TOLERANCE = 1.5;

/**
 * The lines of `tile` as pieces, shifted by `offset` tile units, z in metres; given `box`
 * (`x0, y0, x1, y1` after the shift), only those whose bounds meet it. An end on the box `buffer`
 * units around the tile, where the tiler clips, is clipped. Throws when a vertex lies beyond that
 * box: the buffer given is not the tiles'.
 */
export function piecesOf(
  tile: LineTile,
  props: readonly Props[],
  buffer: number,
  offset: readonly [number, number],
  box?: readonly [number, number, number, number],
): Piece[] {
  const { vertices } = tile.layer.geometry;
  const { extent } = tile.layer;
  const { lineStart, featureOfLine } = tile.ids;
  const { zScale, zOffset } = tile.frame;
  const [lo, hi] = [-buffer, extent + buffer];
  const [dx, dy] = offset;
  const onBox = (k: number) =>
    vertices[k] === lo || vertices[k] === hi || vertices[k + 1] === lo || vertices[k + 1] === hi;
  const pieces: Piece[] = [];
  for (let l = 0; l + 1 < lineStart.length; l++) {
    const [first, end] = [lineStart[l], lineStart[l + 1]];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let v = first; v < end; v++) {
      const x = vertices[v * 3];
      const y = vertices[v * 3 + 1];
      if (x < lo || x > hi || y < lo || y > hi) {
        const { z, x: tx, y: ty } = tile.index;
        throw new Error(
          `tile ${z}/${tx}/${ty}: vertex (${x}, ${y}) lies beyond the tile's buffer of ${buffer} units`,
        );
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (end - first < 2) continue;
    if (box && (x1 + dx < box[0] || x0 + dx > box[2] || y1 + dy < box[1] || y0 + dy > box[3]))
      continue;
    const out = new Float64Array((end - first) * 3);
    for (let v = first; v < end; v++) {
      const o = (v - first) * 3;
      out[o] = vertices[v * 3] + dx;
      out[o + 1] = vertices[v * 3 + 1] + dy;
      out[o + 2] = vertices[v * 3 + 2] * zScale + zOffset;
    }
    pieces.push({
      vertices: out,
      props: props[featureOfLine[l]],
      startClipped: onBox(first * 3),
      endClipped: onBox((end - 1) * 3),
    });
  }
  return pieces;
}

type Point = readonly [number, number, number];

/** A line as its original vertices, with the clip vertex beyond each clipped end. */
interface Run {
  readonly points: Point[];
  start: Point | undefined;
  end: Point | undefined;
  readonly props: Props;
  readonly group: number;
  /** The first piece it came from, for a stable order. */
  readonly order: number;
}

const propsKeys = new WeakMap<Props, string>();

/** A key equal for equal properties, whatever their order. */
function propsKey(props: Props): string {
  let key = propsKeys.get(props);
  if (key === undefined) {
    key = JSON.stringify(
      Object.keys(props)
        .sort()
        .map((k) => [k, props[k]]),
    );
    propsKeys.set(props, key);
  }
  return key;
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1] && Math.abs(a[2] - b[2]) < 1e-6;

/** The distance from `p` to `q` in the ground plane. */
const span = (p: Point, q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** A run's vertices with the clip vertex beyond each clipped end. */
const fullPoints = (run: Run): Point[] => [
  ...(run.start ? [run.start] : []),
  ...run.points,
  ...(run.end ? [run.end] : []),
];

/** The distance from `c` to the segment `a`–`b`, in the ground plane. */
function toSegment(c: Point, a: Point, b: Point): number {
  const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
  const len2 = ex * ex + ey * ey;
  const t = len2 ? Math.max(0, Math.min(1, ((c[0] - a[0]) * ex + (c[1] - a[1]) * ey) / len2)) : 0;
  return Math.hypot(c[0] - a[0] - t * ex, c[1] - a[1] - t * ey);
}

/** The distance from `c` to the line through `a` and `b`, and how far along it from `a`. */
function toLine(c: Point, a: Point, b: Point): [number, number] {
  const len = span(a, b);
  const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const [cx, cy] = [c[0] - a[0], c[1] - a[1]];
  return [Math.abs(cx * uy - cy * ux), cx * ux + cy * uy];
}

/**
 * Whether `points` lie within `tolerance` of one line: the line through the two of them farthest
 * apart, or, given `exact`, through it and the point farthest from it. Clip vertices are rounded,
 * and the longest span tilts the line least.
 */
function onOneLine(points: readonly Point[], tolerance: number, exact?: Point): boolean {
  const all = exact ? [exact, ...points] : points;
  let [a, b] = [all[0], all[1]];
  for (let i = 0; i < (exact ? 1 : all.length); i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (span(all[i], all[j]) > span(a, b)) [a, b] = [all[i], all[j]];
    }
  }
  if (span(a, b) === 0) return true;
  return all.every((p) => toLine(p, a, b)[0] <= tolerance);
}

/**
 * The lines the pieces of neighbouring tiles make, each piece cut where its tile's data ends. Two
 * pieces are one line when they have equal properties and either share a run of vertices (one
 * vertex is enough where each was clipped past it onto the other's segment), or one stops at a
 * clip vertex and the other starts at one, both within `tolerance` of the segment from the first's
 * last vertex to the second's first. Pieces of clip vertices only, segments crossing a tile with
 * no vertex in it, are dropped where a line covers them, extend a clipped end they continue, or
 * else merge with those on the same segment. Lines merely meeting at a vertex stay apart. An end
 * still clipped keeps its clip vertex. Lines come ordered by properties, then first vertex, so
 * neighbouring tiles order the lines they share alike.
 */
export function stitch(pieces: readonly Piece[], tolerance = STITCH_TOLERANCE): Piece[] {
  const groups = new Map<string, number>();
  const runs: Run[] = [];
  const clipOnly: Run[] = [];
  pieces.forEach((piece, order) => {
    const { vertices: v } = piece;
    const all: Point[] = [];
    for (let i = 0; i < v.length; i += 3) all.push([v[i], v[i + 1], v[i + 2]]);
    const start = piece.startClipped ? all.shift() : undefined;
    const end = piece.endClipped && all.length ? all.pop() : undefined;
    const key = propsKey(piece.props);
    let group = groups.get(key);
    if (group === undefined) groups.set(key, (group = groups.size));
    const run: Run = { points: all, start, end, props: piece.props, group, order };
    if (all.length) runs.push(run);
    else
      clipOnly.push({ ...run, points: [start!, end ?? start!], start: undefined, end: undefined });
  });

  const lines = gapJoin(overlapJoin(runs, tolerance), tolerance);
  const loose = absorbClipOnly(lines, clipOnly, tolerance);

  const out = [
    ...lines.map((r) => ({ run: r, piece: toPiece(r) })),
    ...loose.map((r) => ({
      run: r,
      piece: toPiece({ ...r, points: [], start: r.points[0], end: r.points[1] }),
    })),
  ];
  out.sort((a, b) => {
    const [ka, kb] = [propsKey(a.run.props), propsKey(b.run.props)];
    if (ka !== kb) return ka < kb ? -1 : 1;
    const [va, vb] = [a.piece.vertices, b.piece.vertices];
    return va[0] - vb[0] || va[1] - vb[1] || a.run.order - b.run.order;
  });
  return out.map((o) => o.piece);
}

function toPiece(run: Run): Piece {
  const points = fullPoints(run);
  const vertices = new Float64Array(points.length * 3);
  points.forEach((p, i) => vertices.set(p, i * 3));
  return {
    vertices,
    props: run.props,
    startClipped: run.start !== undefined,
    endClipped: run.end !== undefined,
  };
}

/** Grid points as one number; tile coordinates are integers well within 2^20. */
function pointKey(p: Point): number {
  const [x, y] = p;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    Math.abs(x) >= 2 ** 20 ||
    Math.abs(y) >= 2 ** 20
  ) {
    throw new Error(`stitch: vertex (${x}, ${y}) is not on the tile grid`);
  }
  return (x + 2 ** 20) * 2 ** 21 + (y + 2 ** 20);
}

/** Join runs sharing vertices: each set of runs aligned by shared vertices becomes one run. */
function overlapJoin(runs: readonly Run[], tolerance: number): Run[] {
  const index = new Map<number, number[]>();
  runs.forEach((run, r) =>
    run.points.forEach((p, i) => {
      const key = pointKey(p);
      const list = index.get(key);
      if (list) list.push(r, i);
      else index.set(key, [r, i]);
    }),
  );
  // Edges: run q's vertex k is run p's vertex k + d.
  const edges = new Map<number, { q: number; d: number }[]>();
  const seen = new Set<string>();
  for (const list of index.values()) {
    for (let a = 0; a < list.length; a += 2) {
      for (let b = a + 2; b < list.length; b += 2) {
        const [p, i, q, j] =
          list[a] < list[b]
            ? [list[a], list[a + 1], list[b], list[b + 1]]
            : [list[b], list[b + 1], list[a], list[a + 1]];
        if (p === q || runs[p].group !== runs[q].group) continue;
        const id = `${p},${q},${i - j}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!aligned(runs[p], runs[q], i - j, tolerance)) continue;
        pushTo(edges, p, { q, d: i - j });
        pushTo(edges, q, { q: p, d: j - i });
      }
    }
  }
  const joined: Run[] = [];
  const offset = new Map<number, number>();
  for (let r = 0; r < runs.length; r++) {
    if (offset.has(r)) continue;
    offset.set(r, 0);
    const members = [r];
    for (let m = 0; m < members.length; m++) {
      const p = members[m];
      for (const { q, d } of edges.get(p) ?? []) {
        const at = offset.get(p)! + d;
        const known = offset.get(q);
        if (known === undefined) {
          offset.set(q, at);
          members.push(q);
        } else if (known !== at) {
          throw new Error(`stitch: the pieces of a line align in two ways`);
        }
      }
    }
    joined.push(assemble(members.map((m) => ({ run: runs[m], at: offset.get(m)! }))));
  }
  return joined;
}

/**
 * Whether run `q`, its vertex `k` being run `p`'s vertex `k + d`, is part of the same line as `p`:
 * they agree wherever they overlap, and wherever one runs on past the other's end, that end was
 * clipped onto the segment the other runs on. Sharing a single vertex and nothing past it, they
 * must also have been clipped alike there.
 */
function aligned(p: Run, q: Run, d: number, tolerance: number): boolean {
  const [np, nq] = [p.points.length, q.points.length];
  const [lo, hi] = [Math.max(0, d), Math.min(np, d + nq)];
  if (hi - lo < 1) return false;
  for (let k = lo; k < hi; k++) if (!same(p.points[k], q.points[k - d])) return false;
  const [first, last] = [Math.min(0, d), Math.max(np, d + nq)];
  const at = (t: number) => (t < np && t >= 0 ? p.points[t] : q.points[t - d]);
  for (const [run, off, n] of [
    [p, 0, np],
    [q, d, nq],
  ] as const) {
    if (off > first && !(run.start && toSegment(run.start, at(off - 1), at(off)) <= tolerance)) {
      return false;
    }
    if (
      off + n < last &&
      !(run.end && toSegment(run.end, at(off + n - 1), at(off + n)) <= tolerance)
    ) {
      return false;
    }
  }
  if (hi - lo > 1) return true;
  // One shared vertex. Where both runs stop at it, their clip vertices must agree.
  const agree = (a: Point | undefined, b: Point | undefined, v: Point) =>
    a === undefined || b === undefined
      ? a === b
      : toSegment(a, b, v) <= tolerance || toSegment(b, a, v) <= tolerance;
  const v = p.points[lo];
  if (d === 0 && !agree(p.start, q.start, v)) return false;
  if (np === d + nq && !agree(p.end, q.end, v)) return false;
  return true;
}

/** One run from runs at known offsets: their vertices in order, the outermost clips at the ends. */
function assemble(parts: readonly { run: Run; at: number }[]): Run {
  const first = Math.min(...parts.map((m) => m.at));
  const last = Math.max(...parts.map((m) => m.at + m.run.points.length));
  const points: (Point | undefined)[] = Array.from({ length: last - first });
  for (const { run, at } of parts) run.points.forEach((p, i) => (points[at - first + i] ??= p));
  if (points.some((p) => p === undefined)) throw new Error(`stitch: a joined line has a hole`);
  const full = points as Point[];
  /** Unclipped if any run ends there unclipped, else the clip vertex farthest out. */
  const clip = (ends: (Point | undefined)[], anchor: Point) =>
    ends.includes(undefined)
      ? undefined
      : ends.reduce((a, b) => (span(b!, anchor) > span(a!, anchor) ? b : a));
  const starts = parts.filter((m) => m.at === first).map((m) => m.run.start);
  const ends = parts.filter((m) => m.at + m.run.points.length === last).map((m) => m.run.end);
  const base = parts.reduce((a, b) => (b.run.order < a.run.order ? b : a)).run;
  return {
    points: full,
    start: clip(starts, full[0]),
    end: clip(ends, full[full.length - 1]),
    props: base.props,
    group: base.group,
    order: base.order,
  };
}

/**
 * Join a run stopping at a clip vertex to one starting at one, both on the segment between them;
 * of several such, the one across the shortest segment.
 */
function gapJoin(runs: readonly Run[], tolerance: number): Run[] {
  const next = new Map<number, number>();
  const previous = new Map<number, number>();
  const byGroup = new Map<number, number[]>();
  runs.forEach((r, i) => pushTo(byGroup, r.group, i));
  // Every candidate join, then the shortest gaps first: where a line runs nearly straight through
  // several tiles, a piece's clip vertex also lies on the segment skipping the next piece, but the
  // next piece's vertex is nearer.
  const candidates: { a: number; b: number; gap: number }[] = [];
  for (const members of byGroup.values()) {
    for (const a of members) {
      const ra = runs[a];
      if (!ra.end) continue;
      const p = ra.points[ra.points.length - 1];
      for (const b of members) {
        const rb = runs[b];
        if (a === b || !rb.start) continue;
        const q = rb.points[0];
        if (same(p, q)) continue;
        if (toSegment(ra.end, p, q) > tolerance || toSegment(rb.start, p, q) > tolerance) continue;
        candidates.push({ a, b, gap: span(p, q) });
      }
    }
  }
  candidates.sort((x, y) => x.gap - y.gap);
  for (const { a, b } of candidates) {
    if (next.has(a) || previous.has(b)) continue;
    next.set(a, b);
    previous.set(b, a);
  }
  const out: Run[] = [];
  const done = new Set<number>();
  const chain = (head: number, closed: boolean) => {
    const parts: Run[] = [];
    for (let r: number | undefined = head; r !== undefined && !done.has(r); r = next.get(r)) {
      done.add(r);
      parts.push(runs[r]);
    }
    const points = parts.flatMap((r) => r.points);
    if (closed) points.push(points[0]);
    out.push({
      ...parts[0],
      points,
      start: closed ? undefined : parts[0].start,
      end: closed ? undefined : parts[parts.length - 1].end,
      order: Math.min(...parts.map((r) => r.order)),
    });
  };
  runs.forEach((_, i) => {
    if (!previous.has(i)) chain(i, false);
  });
  // What is left are rings joined all round.
  runs.forEach((_, i) => {
    if (!done.has(i)) chain(i, true);
  });
  return out;
}

/**
 * Settle the runs of clip vertices only (`points` being their two clip vertices): drop those a
 * line covers, extend clipped ends along those continuing them, and merge the rest that lie on one
 * segment. Returns those left.
 */
function absorbClipOnly(lines: Run[], clipOnly: readonly Run[], tolerance: number): Run[] {
  const full = lines.map(fullPoints);
  const left = clipOnly.filter((c) => {
    const [c0, c1] = c.points;
    return !lines.some((line, l) => {
      if (line.group !== c.group) return false;
      const all = full[l];
      for (let i = 0; i + 1 < all.length; i++) {
        if (
          toSegment(c0, all[i], all[i + 1]) <= tolerance &&
          toSegment(c1, all[i], all[i + 1]) <= tolerance
        ) {
          return true;
        }
      }
      return false;
    });
  });
  // Extend a clipped end, from its last vertex through its clip vertex, over what continues it.
  const used = new Set<Run>();
  for (const line of lines) {
    for (const atEnd of [false, true]) {
      for (let grown = true; grown;) {
        grown = false;
        const clip = atEnd ? line.end : line.start;
        if (!clip) break;
        const anchor = atEnd ? line.points[line.points.length - 1] : line.points[0];
        const reach = span(anchor, clip);
        for (const c of left) {
          if (used.has(c) || c.group !== line.group) continue;
          if (!onOneLine([clip, ...c.points], tolerance, anchor)) continue;
          const [[, t0], [, t1]] = c.points.map((p) => toLine(p, anchor, clip));
          if (Math.min(t0, t1) > reach + tolerance) continue;
          if (Math.max(t0, t1) <= 0) continue;
          used.add(c);
          const far = t1 > t0 ? c.points[1] : c.points[0];
          if (Math.max(t0, t1) > reach) {
            if (atEnd) line.end = far;
            else line.start = far;
            // Measure the rest from the new clip vertex.
            grown = true;
            break;
          }
        }
      }
    }
  }
  // Merge the rest lying on one segment, keeping the first one's direction.
  const rest = left.filter((c) => !used.has(c)).map((c) => ({ ...c, points: [...c.points] }));
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < rest.length && !merged; i++) {
      for (let j = i + 1; j < rest.length && !merged; j++) {
        const [a, b] = [rest[i], rest[j]];
        if (a.group !== b.group) continue;
        const [a0, a1] = a.points;
        const length = span(a0, a1);
        if (!onOneLine([a0, a1, ...b.points], tolerance)) continue;
        const [[, t0], [, t1]] = b.points.map((p) => toLine(p, a0, a1));
        if (Math.max(t0, t1) < -tolerance || Math.min(t0, t1) > length + tolerance) continue;
        const candidates = [
          [0, a0],
          [length, a1],
          [t0, b.points[0]],
          [t1, b.points[1]],
        ] as const;
        const start = candidates.reduce((x, y) => (y[0] < x[0] ? y : x))[1];
        const end = candidates.reduce((x, y) => (y[0] > x[0] ? y : x))[1];
        rest[i] = { ...a, points: [start, end], order: Math.min(a.order, b.order) };
        rest.splice(j, 1);
        merged = true;
      }
    }
  }
  return rest;
}

/**
 * The lines near a tile, for building it: each cut, at vertices, to the segments that meet the
 * box `margin` tile units around the tile. Where a cut leaves a line's end, that end is clipped.
 */
export function linesFor(lines: readonly Piece[], extent: number, margin: number): Lines {
  const [lo, hi] = [-margin, extent + margin];
  // No more vertices than come in, and no more lines than segments.
  const total = lines.reduce((n, line) => n + line.vertices.length, 0);
  const vertices = new Float64Array(total);
  let count = 0;
  const lineStart = new Uint32Array(total / 3 + 1);
  const props: Props[] = [];
  const startClipped = new Uint8Array(total / 3);
  const endClipped = new Uint8Array(total / 3);
  /** Whether the segment from vertex `i` to `i + 1` of `v` meets the box. */
  const meets = (v: Float64Array, i: number) => {
    const ax = v[i * 3];
    const ay = v[i * 3 + 1];
    const bx = v[i * 3 + 3];
    const by = v[i * 3 + 4];
    if (
      Math.max(ax, bx) < lo ||
      Math.min(ax, bx) > hi ||
      Math.max(ay, by) < lo ||
      Math.min(ay, by) > hi
    ) {
      return false;
    }
    // The box's corners all on one side of the segment's line: they do not meet.
    const side = (x: number, y: number) => Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax));
    const [s0, s1, s2, s3] = [side(lo, lo), side(hi, lo), side(lo, hi), side(hi, hi)];
    return !((s0 > 0 && s1 > 0 && s2 > 0 && s3 > 0) || (s0 < 0 && s1 < 0 && s2 < 0 && s3 < 0));
  };
  for (const line of lines) {
    const v = line.vertices;
    const n = v.length / 3;
    let open = false;
    const close = (last: number) => {
      endClipped[props.length - 1] = last < n - 1 || line.endClipped ? 1 : 0;
      lineStart[props.length] = count / 3;
      open = false;
    };
    for (let i = 0; i + 1 < n; i++) {
      if (!meets(v, i)) {
        if (open) close(i);
        continue;
      }
      if (!open) {
        open = true;
        vertices.set(v.subarray(i * 3, i * 3 + 3), count);
        count += 3;
        startClipped[props.length] = i > 0 || line.startClipped ? 1 : 0;
        props.push(line.props);
      }
      vertices.set(v.subarray(i * 3 + 3, i * 3 + 6), count);
      count += 3;
    }
    if (open) close(n - 1);
  }
  return {
    vertices: vertices.slice(0, count),
    lineStart: lineStart.slice(0, props.length + 1),
    props,
    startClipped: startClipped.slice(0, props.length),
    endClipped: endClipped.slice(0, props.length),
  };
}

/** A tile's lines for building one, shifted by `offset` tile units. */
export interface StitchSource {
  readonly tile: LineTile;
  readonly props: readonly Props[];
  readonly offset: readonly [number, number];
}

/**
 * The lines to build a tile from: those of `sources`, the tile and its neighbours shifted into its
 * units, stitched into whole lines and cut to `margin` units around the tile. Only pieces
 * reaching that box matter; their pieces beyond it join on its edge. A tile given alone, its own
 * `buffer` covering the margin, has every line it needs whole.
 */
export function stitchedLines(
  sources: readonly StitchSource[],
  extent: number,
  buffer: number,
  margin: number,
): Lines {
  const reach = margin + STITCH_TOLERANCE;
  const box = [-reach, -reach, extent + reach, extent + reach] as const;
  const pieces = sources.flatMap(({ tile, props, offset }) =>
    piecesOf(tile, props, buffer, offset, box),
  );
  return linesFor(sources.length > 1 ? stitch(pieces) : pieces, extent, margin);
}
