import { describe, expect, test } from "vite-plus/test";
import { linesOf, type Point } from "./__fixtures__/lines";
import type { Lines } from "./lines";
import type { Cap, StyleTable } from "./style";
import {
  ARC_STEP,
  continueShortLinks,
  MITER_MAX_TURN,
  type RoadMesh,
  tessellateRoads,
} from "./tessellate";
import { lineNodes } from "./topology";
import { tileFrame } from "./transform";

interface TableOptions {
  group?: number[];
  rank?: number[];
  visible?: number[];
  /** Half widths in metres; default 2. The casing adds 0.5 unless `outer` says otherwise. */
  half?: number[];
  outer?: number[];
}

function tableOf(n: number, o: TableOptions = {}): StyleTable {
  const half = Float32Array.from({ length: n }, (_, i) => o.half?.[i] ?? 2);
  const group = Int32Array.from({ length: n }, (_, i) => o.group?.[i] ?? 0);
  return {
    lines: n,
    visible: Uint8Array.from({ length: n }, (_, i) => o.visible?.[i] ?? 1),
    group,
    rank: Int32Array.from({ length: n }, (_, i) => o.rank?.[i] ?? 0),
    halfWidth: half,
    outerHalfWidth: Float32Array.from({ length: n }, (_, i) => o.outer?.[i] ?? half[i] + 0.5),
    fill: new Uint8Array(n * 3),
    casing: new Uint8Array(n * 3),
    groups: [...new Set(group)].sort((a, b) => a - b),
  };
}

// The world tile, where at the equator (y = 2048) one metre is one tile unit, 1 / 4096 of the
// world; positions and offsets below are in tile units, which are metres there.
const frame = tileFrame({ z: 0, x: 0, y: 0 }, 4096, 0);
const metre = 1 / 4096;

/** The node the junction tests put at the tile's centre, with its surroundings in metres. */
const NODE: Point = [2048, 2048, 0];
/** The points `(x, y)` metres from `NODE`. */
const to = (...points: [number, number][]): Point[] =>
  points.map(([x, y]) => [2048 + x, 2048 + y, 0]);
/** The point `r` metres from `NODE` at `deg` degrees. */
const out = (deg: number, r = 100): Point => [
  2048 + r * Math.cos((deg * Math.PI) / 180),
  2048 + r * Math.sin((deg * Math.PI) / 180),
  0,
];
/** The point `d` metres from `NODE` along `dir`, then `side` metres to the left of it. */
const beside = ([dx, dy]: [number, number], d: number, side: number): [number, number] => {
  const h = Math.hypot(dx, dy);
  return [2048 + (d * dx - side * dy) / h, 2048 + (d * dy + side * dx) / h];
};

function mesh(lines: Lines, o: { table?: StyleTable; cap?: Cap } = {}): RoadMesh {
  const table = o.table ?? tableOf(lines.props.length);
  const nodes = lineNodes(lines);
  return tessellateRoads(lines, frame, metre, table, nodes, o.cap ?? "butt");
}

/** Vertex `i`'s centre in tile units. */
const at = (m: RoadMesh, i: number) => [m.positions[i * 3] * 4096, m.positions[i * 3 + 1] * 4096];

/** Vertex `i`'s offset from its centre in a pass, as the shader computes it. */
function offset(m: RoadMesh, t: StyleTable, i: number, pass: "fill" | "casing" = "fill") {
  const w = pass === "fill" ? t.halfWidth : t.outerHalfWidth;
  const [l1, l2] = [m.widthLines[i * 2], m.widthLines[i * 2 + 1]];
  const e = m.extrudes.subarray(i * 4, i * 4 + 4);
  return [e[0] * w[l1] + e[2] * w[l2], e[1] * w[l1] + e[3] * w[l2]];
}

/** Everything the vertex shader reads for a position: equal keys land on the same pixel. */
function key(m: RoadMesh, i: number): string {
  return [
    ...m.positions.subarray(i * 3, i * 3 + 3),
    ...m.extrudes.subarray(i * 4, i * 4 + 4),
    ...m.widthLines.subarray(i * 2, i * 2 + 2),
  ].join();
}

/** The vertices of line `line` (by colour) centred on `[x, y]`. */
function verticesAt(m: RoadMesh, line: number, [x, y]: [number, number]): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.lines.length; i++) {
    const [px, py] = at(m, i);
    if (m.lines[i] === line && Math.abs(px - x) < 1e-6 && Math.abs(py - y) < 1e-6) out.push(i);
  }
  return out;
}

/**
 * The vertices where line `line`'s ribbon ends at `[x, y]`: of its vertices there, those of a
 * triangle reaching away from it. A junction's core lies wholly at its node.
 */
function endsAt(m: RoadMesh, line: number, xy: [number, number]): number[] {
  const here = new Set(verticesAt(m, line, xy));
  const out = new Set<number>();
  for (let k = 0; k < m.indices.length; k += 3) {
    const tri = [m.indices[k], m.indices[k + 1], m.indices[k + 2]];
    if (tri.some((i) => !here.has(i)) && tri.some((i) => m.lines[i] === line)) {
      for (const i of tri) if (here.has(i)) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The lines whose triangles cover `[x, y]` (tile units) in a pass, each triangle counted by the
 * colour of its last vertex, as the GPU's flat shading takes it.
 */
function coveringLines(
  m: RoadMesh,
  t: StyleTable,
  [x, y]: [number, number],
  pass: "fill" | "casing" = "fill",
): Set<number> {
  const point = (i: number) => {
    const [cx, cy] = at(m, i);
    const [ox, oy] = offset(m, t, i, pass);
    return [cx + ox, cy + oy];
  };
  const out = new Set<number>();
  for (let k = 0; k < m.indices.length; k += 3) {
    const [a, b, c] = [m.indices[k], m.indices[k + 1], m.indices[k + 2]].map(point);
    const cross = (p: number[], q: number[]) =>
      (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    const [d1, d2, d3] = [cross(a, b), cross(b, c), cross(c, a)];
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) out.add(m.lines[m.indices[k + 2]]);
  }
  return out;
}

/** The line drawn last, so on top, over `[x, y]` in the fill pass; `undefined` where none is. */
function topLine(m: RoadMesh, t: StyleTable, xy: [number, number]): number | undefined {
  let top: number | undefined;
  for (let k = 0; k < m.indices.length; k += 3) {
    const tri: RoadMesh = { ...m, indices: m.indices.subarray(k, k + 3) };
    if (coveringLines(tri, t, xy).size) top = m.lines[m.indices[k + 2]];
  }
  return top;
}

/** Offsets rounded for comparison as sets, `-0` folded into `0`. */
const rounded = (pairs: number[][]) =>
  pairs
    .map(([x, y]) => [Math.round(x * 1e4) / 1e4 + 0, Math.round(y * 1e4) / 1e4 + 0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe("tessellateRoads: a single line", () => {
  test("a straight segment is a quad on the centreline, pushed out by the half width", () => {
    const layer = linesOf([
      [0, 2048, 10500],
      [10, 2048, 10600],
    ]);
    const t = tableOf(1);
    const m = mesh(layer, { table: t });
    expect(m.lines).toHaveLength(4);
    expect([0, 1, 2, 3].map((i) => at(m, i))).toEqual([
      [0, 2048],
      [0, 2048],
      [10, 2048],
      [10, 2048],
    ]);
    expect(rounded([0, 1].map((i) => offset(m, t, i)))).toEqual([
      [0, -2],
      [0, 2],
    ]);
    expect(rounded([0, 1].map((i) => offset(m, t, i, "casing")))).toEqual([
      [0, -2.5],
      [0, 2.5],
    ]);
    // Elevation in Mercator units: a metre at the equator.
    expect(m.positions[2] * 4096).toBeCloseTo(500, 6);
    expect(m.positions[8] * 4096).toBeCloseTo(600, 6);
    expect([...m.indices]).toEqual([0, 1, 2, 1, 3, 2]);
    expect(m.groups).toEqual([{ group: 0, start: 0, count: 6 }]);
  });

  test("a slight turn shares one mitred pair, stretched to keep the width", () => {
    const t = tableOf(1);
    const m = mesh(
      linesOf([
        [0, 2048, 0],
        [100, 2048, 0],
        [200, 2058, 0],
      ]),
      { table: t },
    );
    expect(m.lines).toHaveLength(6);
    const turn = Math.atan2(10, 100);
    expect(turn).toBeLessThan(MITER_MAX_TURN);
    const [x, y] = offset(m, t, 2);
    expect(Math.hypot(x, y)).toBeCloseTo(2 / Math.cos(turn / 2), 5);
    // On the first segment's normal, the stretch is exactly the half width.
    expect(y).toBeCloseTo(2, 5);
  });

  test("a sharp turn ends both segments and fans the outer side round", () => {
    const t = tableOf(1);
    const m = mesh(
      linesOf([
        [0, 2048, 0],
        [100, 2048, 0],
        [100, 2148, 0],
      ]),
      { table: t },
    );
    const steps = Math.ceil(Math.PI / 2 / ARC_STEP);
    expect(m.lines).toHaveLength(2 + 4 + 1 + (steps - 1) + 2);
    expect(m.indices).toHaveLength((2 + 2 + steps) * 3);
    expect(offset(m, t, 6)).toEqual([0, 0]);
    for (let i = 7; i < 7 + steps - 1; i++)
      expect(Math.hypot(...offset(m, t, i))).toBeCloseTo(2, 5);
  });

  test("free ends take the style's cap", () => {
    const layer = linesOf([
      [0, 2048, 0],
      [10, 2048, 0],
    ]);
    const t = tableOf(1);
    const steps = Math.ceil(Math.PI / ARC_STEP);
    expect(mesh(layer, { table: t }).lines).toHaveLength(4);
    const round = mesh(layer, { table: t, cap: "round" });
    expect(round.lines).toHaveLength(4 + 2 * (steps + 2));
    for (let i = 5; i <= 5 + steps; i++)
      expect(Math.hypot(...offset(round, t, i))).toBeCloseTo(2, 5);
    const square = mesh(layer, { table: t, cap: "square" });
    expect(square.lines).toHaveLength(8);
    expect(square.indices).toHaveLength(18);
    expect(rounded([4, 5].map((i) => offset(square, t, i)))).toEqual([
      [2, -2],
      [2, 2],
    ]);
    expect(rounded([6, 7].map((i) => offset(square, t, i)))).toEqual([
      [-2, -2],
      [-2, 2],
    ]);
  });
});

describe("tessellateRoads: junctions", () => {
  // A through road (lines 0 and 1, half width 2, rank 1) and a narrower stem (line 2, half
  // width 1, rank 0) leaving the node at (100, 2048) towards +y.
  const tee = (stemLength = 100) =>
    linesOf(
      [
        [0, 2048, 0],
        [100, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [200, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [100, 2048 + stemLength, 0],
      ],
    );
  const teeTable = () => tableOf(3, { half: [2, 2, 1], rank: [1, 1, 0] });
  const node: [number, number] = [100, 2048];

  test("a narrower road ends exactly on the edge of the road it meets, in both passes", () => {
    const t = teeTable();
    const m = mesh(tee(), { table: t, cap: "round" });
    const stem = endsAt(m, 2, node);
    expect(stem).toHaveLength(2);
    expect(rounded(stem.map((i) => offset(m, t, i)))).toEqual([
      [-1, 2],
      [1, 2],
    ]);
    expect(rounded(stem.map((i) => offset(m, t, i, "casing")))).toEqual([
      [-1.5, 2.5],
      [1.5, 2.5],
    ]);
  });

  test("the through road's links end at the same corners and straight across the far side", () => {
    const t = teeTable();
    const m = mesh(tee(), { table: t });
    const [ownEnd0, ownEnd1] = [endsAt(m, 0, node).slice(0, 2), endsAt(m, 1, node)];
    expect(rounded(ownEnd0.map((i) => offset(m, t, i)))).toEqual([
      [-1, 2],
      [0, -2],
    ]);
    expect(rounded(ownEnd1.map((i) => offset(m, t, i)))).toEqual([
      [0, -2],
      [1, 2],
    ]);
  });

  test("every corner two links share is bit-identical in both, so the junction has no crack", () => {
    const t = teeTable();
    const m = mesh(tee(), { table: t });
    const keysOf = (line: number) => new Set(verticesAt(m, line, node).map((i) => key(m, i)));
    let shared = 0;
    for (const line of [0, 1, 2]) {
      for (const i of verticesAt(m, line, node)) {
        const [l1, l2] = [m.widthLines[i * 2], m.widthLines[i * 2 + 1]];
        if (l1 === l2) continue;
        // A corner of two lines: the other line draws the very same vertex.
        const other = l1 === line ? l2 : l1;
        expect(keysOf(other).has(key(m, i))).toBe(true);
        shared++;
      }
    }
    expect(shared).toBeGreaterThan(0);
  });

  test("two lower roads meeting at a sharp angle beside the owner keep their own colour", () => {
    // A 都道府県道 running through (lines 0 and 1, half 4) and two narrow roads (lines 2 and 3,
    // half 2) leaving the node 15° apart on one side: their edges meet ~15 m out, far beyond the
    // through road's edge. That wedge is theirs, not the through road's.
    const layer = linesOf([out(180), NODE], [NODE, out(0)], [NODE, out(100)], [NODE, out(115)]);
    const t = tableOf(4, { half: [4, 4, 2, 2], rank: [1, 1, 0, 0] });
    const m = mesh(layer, { table: t });
    // In the wedge, 12 m out between the two narrow roads.
    const [wx, wy] = out(107.5, 12);
    expect([2, 3]).toContain(topLine(m, t, [wx, wy]));
    // On the through road beside the node, under both narrow roads' mouths.
    for (const x of [2046, 2047, 2049]) expect([0, 1]).toContain(topLine(m, t, [x, 2051]));
  });

  test("a bend between two equal roads shares its inner corner and rounds its outer side", () => {
    const layer = linesOf(
      [
        [0, 2048, 0],
        [100, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [100, 2148, 0],
      ],
    );
    const t = tableOf(2);
    const m = mesh(layer, { table: t });
    const ends = [...endsAt(m, 0, node).slice(0, 2), ...endsAt(m, 1, node)];
    const inner = ends.filter((i) => rounded([offset(m, t, i)])[0].join() === "-2,2");
    expect(inner).toHaveLength(2);
    expect(key(m, inner[0])).toBe(key(m, inner[1]));
    // The outer side: arc points at the half width, in the quadrant away from both roads.
    const arcs = verticesAt(m, 0, node).filter((i) => {
      const [x, y] = offset(m, t, i);
      return x > 1e-6 && y < -1e-6;
    });
    expect(arcs).toHaveLength(Math.ceil(Math.PI / 2 / ARC_STEP) - 1);
    for (const i of arcs) expect(Math.hypot(...offset(m, t, i))).toBeCloseTo(2, 5);
  });

  test("a width change between two links in line tapers, its outline unbroken", () => {
    const layer = linesOf(
      [
        [0, 2048, 0],
        [100, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [200, 2048, 0],
      ],
    );
    const t = tableOf(2, { half: [2, 1] });
    const m = mesh(layer, { table: t, cap: "round" });
    // The wider ends square at the node; the narrower reaches its edge 3 m (3 × the 1 m step) on.
    expect(
      rounded(
        endsAt(m, 0, node)
          .slice(0, 2)
          .map((i) => offset(m, t, i)),
      ),
    ).toEqual([
      [0, -2],
      [0, 2],
    ]);
    expect(rounded(endsAt(m, 1, node).map((i) => offset(m, t, i)))).toEqual([
      [3, -1],
      [3, 1],
    ]);
    // Just outside the fill's slanted face, on either side, the casing shows and the fill does not.
    for (const side of [1, -1]) {
      const [nx, ny] = [1 / Math.hypot(1, 3), 3 / Math.hypot(1, 3)];
      const xy: [number, number] = [101.5 + 0.2 * nx, 2048 + side * (1.5 + 0.2 * ny)];
      expect(coveringLines(m, t, xy, "fill").size, `fill ${xy.join(",")}`).toBe(0);
      expect(coveringLines(m, t, xy, "casing").size, `casing ${xy.join(",")}`).toBeGreaterThan(0);
    }
  });

  test("a wide road forking into two narrower ones tapers into the straighter, without a spike", () => {
    // As at 14/14344/6473 (268,3914): line 0 (half 5) arriving, line 1 (half 3) leaving 7° off
    // straight, line 2 (half 3) leaving on the other side.
    const layer = linesOf(
      [
        [100, 2048, 0],
        [123, 2068, 0],
      ],
      [
        [100, 2048, 0],
        [88, 2040, 0],
        [40, 2000, 0],
      ],
      [
        [100, 2048, 0],
        [105, 2041, 0],
        [140, 2000, 0],
      ],
    );
    const t = tableOf(3, { half: [5, 3, 3] });
    const m = mesh(layer, { table: t });
    // No vertex at the node lies farther from it than the widest half width and the taper allow.
    for (let i = 0; i < m.lines.length; i++) {
      const [x, y] = at(m, i);
      if (Math.hypot(x - 100, y - 2048) > 1e-6) continue;
      expect(Math.hypot(...offset(m, t, i))).toBeLessThan(5 + 3 * 2 + 1e-6);
    }
  });

  test("a road too short to reach the corner stops on its own edges, sharing its length with its far end", () => {
    const t = teeTable();
    const m = mesh(tee(1), { table: t });
    // The stem is 1 m long, its far end free, and its corners would be 2 m along it: its casing
    // (half 1.5) stops at its full length, and its fill (half 1) on the same offset scaled.
    const stem = endsAt(m, 2, node);
    expect(rounded(stem.map((i) => offset(m, t, i, "casing")))).toEqual([
      [-1.5, 1],
      [1.5, 1],
    ]);
    expect(rounded(stem.map((i) => offset(m, t, i)))).toEqual([
      [-1, 0.6667],
      [1, 0.6667],
    ]);
  });

  test("a line with more vertices may use its whole first segment for a corner", () => {
    // The stem's first segment is 3 m, then it bends: the 2 m corner fits.
    const layer = linesOf(
      [
        [0, 2048, 0],
        [100, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [200, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [100, 2051, 0],
        [130, 2080, 0],
      ],
    );
    const t = teeTable();
    const m = mesh(layer, { table: t });
    expect(rounded(endsAt(m, 2, node).map((i) => offset(m, t, i)))).toEqual([
      [-1, 2],
      [1, 2],
    ]);
  });

  test("a short wide road meeting a narrow one at an acute angle does not stick out sideways", () => {
    // Line 0: wide (half 8), 10 m long, leaving the node at 45°. Line 1: narrow (half 3),
    // leaving at 83°, 38° counterclockwise of it (y runs down the tile). Their edges meet ~16 m
    // along line 0, past its end.
    const theta = (38 * Math.PI) / 180;
    const [ax, ay] = [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)];
    const [bx, by] = [Math.cos(Math.PI / 4 + theta), Math.sin(Math.PI / 4 + theta)];
    const layer = linesOf(
      [
        [100, 2048, 0],
        [100 + Math.round(10 * ax), 2048 + Math.round(10 * ay), 0],
      ],
      [
        [100, 2048, 0],
        [100 + Math.round(60 * bx), 2048 + Math.round(60 * by), 0],
      ],
      [
        [100, 2048, 0],
        [40, 2048, 0],
      ],
    );
    const t = tableOf(3, { half: [8, 3, 3], rank: [2, 0, 0] });
    const m = mesh(layer, { table: t });
    // Line 0's end pair at the node: no point lies farther than 90° from its direction, so none
    // sticks out past line 1.
    const [l0x, l0y] = [ax, ay];
    for (const i of endsAt(m, 0, node).slice(0, 2)) {
      const [x, y] = offset(m, t, i);
      expect(x * l0x + y * l0y).toBeGreaterThan(-1e-9);
    }
    // Their edges meet past line 0's end, where it has no edge: both stop square at the node,
    // line 1 beneath line 0, which covers it as far as its band reaches.
    // Line 1's direction as its rounded end point gives it.
    const [ex, ey] = [Math.round(60 * bx), Math.round(60 * by)];
    const [ux, uy] = [ex / Math.hypot(ex, ey), ey / Math.hypot(ex, ey)];
    const right = endsAt(m, 1, node)
      .map((i) => offset(m, t, i))
      .find(([x, y]) => x * -uy + y * ux < 0)!;
    expect(rounded([right])).toEqual(rounded([[3 * uy, -3 * ux]]));
    for (const d of [1, 3, 6]) {
      expect(topLine(m, t, [100 + d * bx, 2048 + d * by]), `${d}`).toBe(0);
    }
  });

  test("a road narrowing as it bends stays whole, lower roads meeting its outline", () => {
    // From the crossing at 18/229457/103565: a 都道府県道 bending at the node and narrowing (line
    // 0 west, half 4; line 1 at 75°, half 3), with three narrow roads on the outside of the bend,
    // two of them 15° apart.
    const layer = linesOf(
      [out(180), NODE],
      [NODE, out(75)],
      [NODE, out(250)],
      [NODE, out(265)],
      [NODE, out(0)],
    );
    const t = tableOf(5, { half: [4, 3, 2, 2, 2], rank: [1, 1, 0, 0, 0] });
    const m = mesh(layer, { table: t });
    const point = (deg: number, r: number): [number, number] => {
      const [x, y] = out(deg, r);
      return [x, y];
    };
    // The outside of the bend, beyond both links' ends at the node: the road's round join.
    expect([0, 1]).toContain(topLine(m, t, point(300, 2.5)));
    // The inside of the bend.
    expect([0, 1]).toContain(topLine(m, t, point(127.5, 3)));
    // The wedge between the two narrow roads, beyond the bend.
    expect([2, 3]).toContain(topLine(m, t, point(257.5, 12)));
  });

  test("the crossing at 18/229457/103565: one yellow road, its outline unbroken", () => {
    // The real junction, in metres from the node (tile units / 32.83): a 都道府県道 coming from the
    // west (line 0, half 8.29) and leaving south-south-east narrower (line 1, half 5.85), and four
    // white roads; two of them (lines 4 and 5) leave 19° apart, the narrower stopping short.
    const layer = linesOf(
      [NODE, ...to([-18.73, -2.25])],
      [NODE, ...to([26.35, 95.86])],
      [NODE, ...to([23.48, 2.44])],
      [NODE, ...to([-3.53, 8.44], [-13.19, 14.44])],
      [NODE, ...to([-21.87, -70.55])],
      [NODE, ...to([-6.61, -8.92], [-22.12, -17.85], [-36.62, -18.99])],
    );
    const t = tableOf(6, {
      half: [8.29, 5.85, 8.29, 2.92, 5.85, 2.92],
      rank: [2, 2, 0, 0, 0, 0],
    });
    for (const l of [0, 1]) t.fill.set([255, 255, 0], l * 3);
    for (const l of [2, 3, 4, 5]) t.fill.set([255, 255, 255], l * 3);
    const m = mesh(layer, { table: t });
    const at = (d: number, side: number) => beside([-18.73, -2.25], d, side);
    const yellow = (xy: [number, number]) => [0, 1].includes(topLine(m, t, xy)!);
    for (const along of [1, 3, 5, 7, 9, 11]) {
      // The west link's edge runs straight to the node: yellow just inside, not just outside.
      expect(yellow(at(along, 8.1)), `inside at ${along} m`).toBe(true);
      expect(yellow(at(along, 8.5)), `outside at ${along} m`).toBe(false);
    }
    // The inside of the bend, within the west link's edge, beside line 3's mouth: yellow.
    expect(yellow([2048 - 4.4, 2048 + 7.5])).toBe(true);
    // No wedge between lines 4 and 5, and the bend's outside is yellow.
    expect(yellow(at(-3, 12))).toBe(false);
    expect(yellow([2048 + 2, 2048 - 3])).toBe(true);
  });

  test("a wide link of the road branching off a narrow one does not bulge past the narrow one", () => {
    // From 18/229476/103575, in metres: a narrow 国道 running through (lines 0 and 1, half 2.92),
    // a wide 国道 link branching south-east (line 2, half 8.29), and a 都道府県道 meeting it from
    // the north-west (line 3, half 8.29, rank 2).
    const layer = linesOf(
      [NODE, ...to([-109.3, -20.7])],
      [NODE, ...to([61.2, 14.3])],
      [NODE, ...to([18.3, 38.7])],
      [NODE, ...to([-3.72, -7.19], [-16.2, -29.1])],
    );
    const t = tableOf(4, { half: [2.92, 2.92, 8.29, 8.29], rank: [3, 3, 3, 2] });
    for (const l of [0, 1, 2]) t.fill.set([235, 122, 122], l * 3);
    t.fill.set([255, 255, 0], 3 * 3);
    const m = mesh(layer, { table: t });
    // North of the narrow 国道's edge (2.92 m), east of the node: not the 国道.
    for (const xy of [
      [3, -3.3],
      [5, -3.4],
      [7, -3.3],
    ] as [number, number][]) {
      const top = topLine(m, t, [2048 + xy[0], 2048 + xy[1]]);
      expect([0, 1, 2], xy.join(",")).not.toContain(top);
    }
    // Inside it, the 国道.
    expect([0, 1, 2]).toContain(topLine(m, t, [2048 + 4, 2048 - 1]));
  });

  test("no fill reaches a corner beyond a stopped road's first segment, where the road bends away", () => {
    // From 18/229478/103571, in metres: a 都道府県道 (line 0, half 8.29) whose first segment runs
    // 24 m before it bends, a white road (line 1, half 4.87) leaving 8.6° from it, and the
    // 都道府県道 on the other side (line 2, half 5.85). Their edges meet 87 m out, past the bend.
    // On the outside of the bend, a wide white road (line 3) and a narrow one (line 4).
    const layer = linesOf(
      [
        NODE,
        ...to(
          [-20.27, -12.77],
          [-34.39, -18.84],
          [-50.88, -23.57],
          [-68.54, -25.98],
          [-87.35, -23.93],
        ),
      ],
      [NODE, ...to([-38.5, -33.26], [-50.46, -43.72], [-62.71, -57.07], [-89.1, -90.33])],
      [NODE, ...to([18.5, -11.25], [49.57, -22.62])],
      [NODE, ...to([16.14, 25.47])],
      [NODE, ...to([-16.78, 2.8], [-49.65, 25.86])],
    );
    const t = tableOf(5, { half: [8.29, 4.87, 5.85, 8.29, 0.97], rank: [2, 0, 2, 0, 0] });
    for (const l of [0, 2]) t.fill.set([255, 255, 0], l * 3);
    for (const l of [1, 3]) t.fill.set([255, 255, 255], l * 3);
    const m = mesh(layer, { table: t });
    // On the white road, beside where the 都道府県道's first segment would run on: white.
    expect(topLine(m, t, [2048 - 47.03, 2048 - 37.9])).toBe(1);
    expect(topLine(m, t, [2048 - 60, 2048 - 52])).toBe(1);
    // On the 都道府県道 near the node: yellow.
    expect([0, 2]).toContain(topLine(m, t, [2048 - 10, 2048 - 2]));
    // The outside of its bend, between the white road's mouth and the outline: yellow.
    expect([0, 2]).toContain(topLine(m, t, [2048 - 5.8, 2048 - 10.2]));
    // The outside of its bend, where a wide white road (line 3) meets it: the white road's mouth
    // bounds it, no round join over the white road.
    for (const [x, y] of [
      [-1, 3],
      [2.4, 4.8],
    ]) {
      expect(topLine(m, t, [2048 + x, 2048 + y]), `${x}, ${y}`).toBe(3);
    }
  });

  test("a road widening at a junction keeps its narrower edge, a side road meeting the step", () => {
    // From 18/229476/103572, in metres: a 都道府県道 widening at the node (line 0 south-west, half
    // 5.85; line 1 north-east, half 8.29), a white road from the north-west (line 2, half 2.92)
    // whose edge meets the wider link's edge line 2 m behind the node, outside the narrower link,
    // and two more roads on the other side.
    const layer = linesOf(
      [NODE, ...to([-158.04, 137.84])],
      [NODE, ...to([14.41, -12.52], [26.53, -23.3], [37.96, -31.22])],
      [NODE, ...to([-5.36, -8.86], [-7.31, -16.15])],
      [NODE, ...to([12.22, 1.89], [41.12, 11.45], [69.61, 21.32])],
      [NODE, ...to([16.45, 17.33], [22.36, 23.4], [108.26, 111.22])],
    );
    const t = tableOf(5, { half: [5.85, 8.29, 2.92, 2.92, 0.97], rank: [2, 2, 0, 0, 0] });
    for (const l of [0, 1]) t.fill.set([255, 255, 0], l * 3);
    const m = mesh(layer, { table: t });
    // Around the node on the north-west side, beyond the white road's mouth: not yellow.
    const at = (d: number, side: number) => beside([-158.04, 137.84], d, side);
    for (const along of [-1.5, -0.5, 0.5]) {
      expect([0, 1], `outside at ${along} m`).not.toContain(topLine(m, t, at(along, 7.6)));
    }
    expect([0, 1]).toContain(topLine(m, t, at(1, 5.4)));
    // At the node, between the white road's mouth and the narrower edge: the mouth runs straight
    // from one link's edge to the other's, without a kink at the narrower link's square end.
    expect([0, 1]).toContain(topLine(m, t, at(0, 6.2)));
  });

  test("a road bending slightly keeps its edge where a ramp leaves it, beyond a corner behind a link", () => {
    // From 18/229504/103582, in metres: a 国道 running through with a slight bend (lines 0 and 1,
    // half 8.29) and two motorway ramps leaving it at shallow angles (lines 2 and 3, half 2.92).
    // Line 3's corner with line 0 lies 12 m behind line 0's start, on its edge run on past the node.
    const layer = linesOf(
      [NODE, ...to([-96.12, -24.1])],
      [NODE, ...to([41.65, 12.67], [60.93, 17.12])],
      [NODE, ...to([43.75, -0.79], [55.63, 0], [68, -0.52])],
      [NODE, ...to([25.56, 16.36], [26.81, 17.12])],
    );
    const t = tableOf(4, { half: [8.29, 8.29, 2.92, 2.92], rank: [3, 3, 4, 4] });
    const m = mesh(layer, { table: t });
    // Just inside line 1's south edge, from the node out to where the ramp leaves it: the 国道.
    for (const along of [3, 6, 9, 12, 15]) {
      const xy = beside([41.65, 12.67], along, 7.8);
      expect([0, 1], `at ${along} m`).toContain(topLine(m, t, xy));
    }
  });

  test("two roads drawn differently running on into each other meet square", () => {
    // From 18/229471/103571: two narrow roads of one rank and width but different colours and
    // outlines run on into each other. The one drawn on top owns the node, alone: no round cap of
    // its outline over the other.
    const layer = linesOf(
      [
        [2048, 2048, 0],
        [2050.5, 2032, 0],
      ],
      [
        [2048, 2048, 0],
        [2046, 2063, 0],
      ],
    );
    const t = tableOf(2, { half: [0.97, 0.97], outer: [1.2, 1.5] });
    t.fill.set([240, 240, 240], 0);
    t.fill.set([173, 173, 173], 3);
    const m = mesh(layer, { table: t });
    // Line 1, whose outline is wider, owns it. Just past the node on line 0: line 0 only.
    for (const x of [2047.7, 2048, 2048.3]) expect(topLine(m, t, [x, 2047.3]), `${x}`).toBe(0);
  });

  test("a link running straight on into another drawn alike counts as one first segment", () => {
    // From 18/229460/103573, in metres: a 国道 (half 8.29) crossing white roads through a 2.5 m
    // link (line 1) that runs straight on into the next (line 2) at a node of two. The white road
    // from the south-west (line 4) meets the 国道's edge past that short link's end.
    const layer = linesOf(
      [...to([-32.15, -28.2]), NODE],
      [NODE, ...to([1.92, 1.61])],
      [...to([1.92, 1.61], [36.95, 35.09])],
      [NODE, ...to([8.07, -16.91], [36.95, -46.58])],
      [...to([-45.54, 49.9]), NODE],
    );
    const t = tableOf(5, { half: [8.29, 8.29, 8.29, 2.92, 4.87], rank: [3, 3, 3, 0, 0] });
    const m = mesh(layer, { table: t });
    // Just inside the 国道's south-west edge around the node: the 国道.
    for (const along of [-2, 0, 2, 4]) {
      const xy = beside([35.03, 33.48], along, 7.8);
      expect([0, 1, 2], `at ${along} m`).toContain(topLine(m, t, xy));
    }
  });

  test("a link bending slightly past a short first segment counts it as straight on", () => {
    // The same junction with the 国道's short link and the next one as one line (line 1), so the
    // slight turn is at a vertex of the line rather than at a node of two.
    const layer = linesOf(
      [...to([-32.15, -28.2]), NODE],
      [NODE, ...to([1.92, 1.61], [36.95, 35.09])],
      [NODE, ...to([8.07, -16.91], [36.95, -46.58])],
      [...to([-45.54, 49.9]), NODE],
    );
    const t = tableOf(4, { half: [8.29, 8.29, 2.92, 4.87], rank: [3, 3, 0, 0] });
    const m = mesh(layer, { table: t });
    for (const along of [-2, 0, 2, 4]) {
      const xy = beside([35.03, 33.48], along, 7.8);
      expect([0, 1], `at ${along} m`).toContain(topLine(m, t, xy));
    }
  });

  test("a narrow road stopped short of its corner leaves the wider road's edge straight", () => {
    // A straight 国道 (lines 0 and 1, half 5) and a narrow road (line 2, half 3) leaving it at
    // ~31° with a first segment of under 6 m, too short to reach the ~15 m corner, then bending.
    const layer = linesOf(
      [
        [100, 2048, 0],
        [0, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [200, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [95, 2045, 0],
        [95, 2000, 0],
      ],
    );
    const t = tableOf(3, { half: [5, 5, 3], rank: [1, 1, 0] });
    const m = mesh(layer, { table: t });
    // Just inside the 国道's north edge, beside the node, under the narrow road's mouth.
    for (const x of [86, 90, 95, 99]) {
      const lines = coveringLines(m, t, [x, 2048 - 4.8]);
      expect(lines.has(0) || lines.has(1), `x = ${x}: ${[...lines].join(",")}`).toBe(true);
    }
  });

  test("a road running straight through a junction owns it over a wider road ending there", () => {
    // A narrow through road (lines 0 and 1, half 1) and a wider road (line 2, half 3) ending at
    // it, all of one rank: the junction is the through road's, so the wider one stops at its edge.
    const layer = linesOf(
      [
        [100, 2048, 0],
        [100, 1948, 0],
      ],
      [
        [100, 2048, 0],
        [100, 2148, 0],
      ],
      [
        [100, 2048, 0],
        [0, 2048, 0],
      ],
    );
    const t = tableOf(3, { half: [1, 1, 3] });
    const m = mesh(layer, { table: t });
    for (const xy of [
      [100, 2048],
      [100.5, 2047],
      [99.5, 2049.5],
    ] as [number, number][]) {
      expect([0, 1], xy.join(",")).toContain(topLine(m, t, xy));
    }
  });

  test("a road running through owns the junction over a higher rank only ending there", () => {
    // A 国道 running through (lines 0 and 1, rank 3) and a motorway ramp ending at it (line 2,
    // rank 4): the ramp stops on the 国道's edge.
    const layer = linesOf(
      [
        [100, 2048, 0],
        [100, 1948, 0],
      ],
      [
        [100, 2048, 0],
        [100, 2148, 0],
      ],
      [
        [100, 2048, 0],
        [0, 2048, 0],
      ],
    );
    const t = tableOf(3, { half: [5, 5, 3], rank: [3, 3, 4] });
    const m = mesh(layer, { table: t });
    for (const xy of [
      [100, 2048],
      [96, 2047],
      [96, 2049.5],
    ] as [number, number][]) {
      expect([0, 1], xy.join(",")).toContain(topLine(m, t, xy));
    }
  });

  test("ramps merging at a shallow angle do not make a road running through with it", () => {
    // From the data at 14/14344/6473: a 国道 (lines 0 and 1, rank 3) running through, and two
    // motorway ramps (lines 2 and 3, rank 4) leaving the node a few degrees off the 国道, each
    // within 30° of opposite to its western end.
    const layer = linesOf(
      [
        [100, 2048, 0],
        [-31, 2016, 0],
      ],
      [
        [100, 2048, 0],
        [185, 2074, 0],
      ],
      [
        [100, 2048, 0],
        [190, 2047, 0],
      ],
      [
        [100, 2048, 0],
        [152, 2082, 0],
      ],
    );
    const t = tableOf(4, { half: [8, 8, 3, 3], rank: [3, 3, 4, 4] });
    const m = mesh(layer, { table: t });
    // At the node, and 20–25 m out, where ramp 2 still runs inside the 国道: the 国道 is on top.
    for (const xy of [
      [100, 2048],
      [104, 2048.5],
      [120, 2048],
      [125, 2049],
    ] as [number, number][]) {
      expect([0, 1], xy.join(",")).toContain(topLine(m, t, xy));
    }
  });

  test("a higher-rank road turning at a node owns it over a lower one running straight", () => {
    // As at 14/14341/6472 (3103,3455): a 都道府県道 (lines 0 and 1, rank 2) turning by ~114°,
    // and a narrow road (lines 2 and 3, rank 0) running straight through.
    const layer = linesOf(
      [
        [100, 2048, 0],
        [120, 2070, 0],
      ],
      [
        [100, 2048, 0],
        [130, 2038, 0],
      ],
      [
        [100, 2048, 0],
        [92, 2028, 0],
      ],
      [
        [100, 2048, 0],
        [104, 2101, 0],
      ],
    );
    const t = tableOf(4, { half: [8, 5, 3, 3], rank: [2, 2, 0, 0] });
    const m = mesh(layer, { table: t });
    expect([0, 1]).toContain(topLine(m, t, [100, 2048]));
  });

  test("a higher-rank road bending slightly through a node owns it over a lower one running straight", () => {
    // From 16/57362/25890 (1461,3623), in metres: a 国道 (lines 0–2, rank 3) turning by 15.2°
    // through a 4.5 m link (line 1), just past what counts as running on through, and a narrow
    // road (lines 3 and 4, rank 0) crossing it nearly straight. At z18 the same node turns 13.7°.
    const layer = linesOf(
      to([0, 0], [-30.46, 41.3]),
      to([0, 0], [3.53, -2.8]),
      to([3.53, -2.8], [33.38, -35.21]),
      to([0, 0], [-0.12, -3.78], [0.12, -12.91], [4.02, -34.11]),
      to([0, 0], [1.34, 17.3], [5.97, 29.6]),
    );
    const t = tableOf(5, {
      half: [4.9, 4.9, 4.9, 2.94, 2.94],
      outer: [5.39, 5.39, 5.39, 3.43, 3.43],
      rank: [3, 3, 3, 0, 0],
    });
    const m = mesh(layer, { table: t });
    // At the node and along the narrow road inside the 国道: the 国道.
    for (const [x, y] of [
      [0, 0],
      [0, -3],
      [0, 3],
      [0, -4.5],
      [0.5, 4.5],
    ] as [number, number][]) {
      expect([0, 1, 2], `${x},${y}`).toContain(topLine(m, t, [2048 + x, 2048 + y]));
    }
  });

  test("two lower roads meeting each other inside the owner's band leave the owner unbroken", () => {
    // From 18/229467/103575 (1381,4126), in metres: a wide 国道 (lines 0 and 1, rank 3, half 8.32)
    // and, on its north side, a narrow road (line 2) and a 庭園路 at ~17° to the 国道 (line 3),
    // which meet each other at the node, inside the 国道.
    const layer = linesOf(
      to([0, 0], [-39.33, 2.41]),
      to([0, 0], [65.76, -7.1]),
      to([0, 0], [-3.87, -31.86], [-4.7, -45.55]),
      to([0, 0], [-39.33, -11.86]),
    );
    const t = tableOf(4, {
      half: [8.32, 8.32, 2.94, 1.22],
      outer: [8.81, 8.81, 3.43, 1.71],
      rank: [3, 3, 0, 1],
    });
    const m = mesh(layer, { table: t });
    // Inside the 国道's north edge, west of the node, between the two lower roads' mouths.
    for (const along of [2, 4, 6, 10]) {
      for (const north of [4, 6, 7.8]) {
        const xy = beside([-39.33, 2.41], along, north);
        expect([0, 1], `${along} m west, ${north} m north`).toContain(topLine(m, t, xy));
      }
    }
  });

  test("a road ending at a junction draws beneath its owner, along the links it continues into", () => {
    // A 国道 (lines 0 and 1, rank 3, half 8) running east-west, and a ramp (rank 4, half 3)
    // leaving it at a shallow angle: line 2 for 10 m to a two-link node, then line 3, which is
    // still inside the 国道 there and leaves it further on.
    const layer = linesOf(
      [
        [100, 2048, 0],
        [0, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [300, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [110, 2050, 0],
      ],
      [
        [110, 2050, 0],
        [200, 2070, 0],
      ],
    );
    const t = tableOf(4, { half: [8, 8, 3, 3], rank: [3, 3, 4, 4] });
    const m = mesh(layer, { table: t });
    // Inside the 国道, over line 3, 20–30 m from the node: the 国道 is on top.
    for (const xy of [
      [120, 2052],
      [130, 2054],
    ] as [number, number][]) {
      expect([0, 1], xy.join(",")).toContain(topLine(m, t, xy));
    }
    // Outside the 国道, the ramp shows.
    expect(topLine(m, t, [180, 2066])).toBe(3);
  });

  test("of two roads running through a crossing, the higher rank owns it", () => {
    const layer = linesOf(
      [
        [100, 2048, 0],
        [100, 1948, 0],
      ],
      [
        [100, 2048, 0],
        [100, 2148, 0],
      ],
      [
        [100, 2048, 0],
        [0, 2048, 0],
      ],
      [
        [100, 2048, 0],
        [200, 2048, 0],
      ],
    );
    const t = tableOf(4, { half: [5, 5, 3, 3], rank: [0, 0, 1, 1] });
    const m = mesh(layer, { table: t });
    expect([2, 3]).toContain(topLine(m, t, [100, 2048]));
  });

  test("a road owning a junction with its one end draws nothing past that end", () => {
    // From Zürich Nord (swissTLM3D), in metres: a 10 m road (line 0) ending where it splits into
    // two 6 m carriageways (lines 1 and 2) leaving 55° apart over their first metres, then running
    // on side by side. No two ends run through, so the 10 m road owns the junction alone.
    const layer = linesOf(
      [...to([-2.25, -6.22]), NODE],
      [
        NODE,
        ...to([-0.72, 2.92], [-0.76, 5.84], [-0.8, 8.28], [-0.29, 10.97], [1.44, 16.91]),
        ...to([6.89, 34.44], [11.4, 50.38]),
      ],
      [...to([12.04, 37.24], [6.85, 18.98], [2.99, 6.81], [0.78, 0.89]), NODE],
    );
    const t = tableOf(3, { half: [5, 3, 3], rank: [3, 2, 2] });
    const m = mesh(layer, { table: t });
    // Out of the node, the 10 m road leaves along (ux, uy). Its corners, where its edges meet the
    // carriageways', may lie a little behind the node; past them, whatever is drawn is the
    // carriageways'.
    const [ux, uy] = [-2.25 / Math.hypot(2.25, 6.22), -6.22 / Math.hypot(2.25, 6.22)];
    const corners = endsAt(m, 0, [2048, 2048]).map((i) => offset(m, t, i));
    expect(corners).toHaveLength(2);
    const past = Math.min(...corners.map(([x, y]) => x * ux + y * uy));
    let behind = 0;
    for (let x = -8; x <= 8; x += 0.5) {
      for (let y = -8; y <= 8; y += 0.5) {
        if (x * ux + y * uy > past - 0.05) continue;
        behind++;
        expect(topLine(m, t, [2048 + x, 2048 + y]), `${x}, ${y}`).not.toBe(0);
      }
    }
    expect(behind).toBeGreaterThan(40);
  });

  test("a road ending where it runs on straight into a lower one of its colour covers the junction as one road", () => {
    // From Zürich Nord (swissTLM3D), in metres: a motorway (line 0, half 4.5, rank 5) running on
    // straight into its on-ramp (line 1, half 3, rank 4), both red, and a white connector (line 2,
    // half 2, rank 1) leaving sideways. The connector stops at their edges.
    const layer = linesOf(
      [NODE, ...to([-30.54, -7.63], [-60.39, -14.7], [-105.4, -25.45])],
      [...to([69.05, 17.8], [38.41, 10.57], [10.79, 2.75]), NODE],
      [...to([1.01, -5.17]), NODE],
    );
    const t = tableOf(3, { half: [4.5, 3, 2], rank: [5, 4, 1] });
    for (const l of [0, 1]) t.fill.set([232, 132, 107], l * 3);
    t.fill.set([255, 255, 255], 2 * 3);
    const m = mesh(layer, { table: t });
    // The ramp leaves along (ux, uy), the motorway the other way; (nx, ny) is across them.
    const [ux, uy] = [10.79 / Math.hypot(10.79, 2.75), 2.75 / Math.hypot(10.79, 2.75)];
    const [nx, ny] = [-uy, ux];
    for (let along = -6; along <= 6; along += 0.25) {
      for (let across = -6; across <= 6; across += 0.25) {
        // Within the motorway's band before the node and the ramp's after it, short of the
        // connector's mouth, which runs straight from one's edge to the other's.
        if (Math.abs(across) > (along < 0 ? 3.5 : 2.9)) continue;
        const xy: [number, number] = [
          2048 + along * ux + across * nx,
          2048 + along * uy + across * ny,
        ];
        expect([0, 1], `${along}, ${across}`).toContain(topLine(m, t, xy));
      }
    }
  });

  test("a wide road entering a roundabout runs on whole to its curve, which keeps to its own band", () => {
    // From Zürich Nord (swissTLM3D), in metres: a 10 m road (line 0) meeting a 4 m roundabout
    // (lines 1 and 2, radius about 9 m) whose segments are under a metre long. The road's edges
    // meet the ring's 5 m out along its tangent, where the ring has curved well away.
    const ring1: [number, number][] = [
      [13.47, -3.5],
      [12.91, -3.87],
      [12.39, -4.16],
      [11.76, -4.46],
      [11.2, -4.67],
      [10.57, -4.87],
      [9.94, -5.01],
      [9.26, -5.12],
      [8.61, -5.17],
      [7.96, -5.18],
      [7.36, -5.13],
      [6.72, -5.06],
      [6.08, -4.92],
      [5.46, -4.75],
      [4.8, -4.51],
      [4.21, -4.25],
      [3.68, -3.96],
      [3.09, -3.6],
      [2.61, -3.24],
      [2.11, -2.82],
      [1.62, -2.34],
      [1.19, -1.85],
      [0.8, -1.33],
      [0.47, -0.83],
      [0, 0],
    ];
    const ring2: [number, number][] = [
      [0, 0],
      [-0.24, 0.6],
      [-0.47, 1.26],
      [-0.62, 1.83],
      [-0.75, 2.52],
      [-0.82, 3.11],
      [-0.85, 3.81],
      [-0.83, 4.45],
      [-0.76, 5.09],
      [-0.66, 5.68],
      [-0.49, 6.36],
      [-0.29, 6.97],
      [-0.04, 7.57],
      [0.25, 8.15],
      [0.55, 8.66],
      [0.91, 9.19],
      [1.32, 9.7],
      [1.75, 10.18],
      [2.22, 10.63],
      [2.76, 11.06],
      [3.35, 11.47],
    ];
    const layer = linesOf(
      to(
        [-102.56, -46.86],
        [-80.71, -37.02],
        [-53.03, -24.37],
        [-26.88, -12.57],
        [-4.98, -2.55],
        [0, 0],
      ),
      to(...ring1),
      to(...ring2),
    );
    const t = tableOf(3, { half: [5, 2, 2], rank: [3, 1, 1] });
    for (const l of [1, 2]) t.fill.set([255, 255, 255], l * 3);
    const m = mesh(layer, { table: t });
    /** The distance from `[x, y]` to the ring's centreline, in metres. */
    const toRing = (x: number, y: number) =>
      Math.min(
        ...[ring1, ring2].flatMap((ring) =>
          ring.slice(1).map(([bx, by], k) => {
            const [ax, ay] = ring[k];
            const [dx, dy] = [bx - ax, by - ay];
            const s = Math.max(
              0,
              Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)),
            );
            return Math.hypot(x - ax - s * dx, y - ay - s * dy);
          }),
        ),
      );
    // The road arrives along (ux, uy); (nx, ny) is across it.
    const [ux, uy] = [4.98 / Math.hypot(4.98, 2.55), 2.55 / Math.hypot(4.98, 2.55)];
    const [nx, ny] = [-uy, ux];
    for (let along = -8; along <= 4; along += 0.25) {
      for (let across = -6; across <= 6; across += 0.25) {
        const [x, y] = [along * ux + across * nx, along * uy + across * ny];
        const top = topLine(m, t, [2048 + x, 2048 + y]);
        const ring = toRing(x, y);
        const where = `${along}, ${across}`;
        // The ring's colour stays within its band: no notch beyond its curve.
        if (top === 1 || top === 2) expect(ring, where).toBeLessThan(2 + 0.05);
        // The ring runs on unbroken over the road's end.
        if (ring < 1.95) expect([1, 2], where).toContain(top);
        // The road keeps its full width right up to the ring.
        if (along <= 0 && Math.abs(across) < 4.9 && ring > 2.05) expect(top, where).toBe(0);
      }
    }
  });

  test("a neighbour the style hides leaves a free end", () => {
    const t = tableOf(3, { visible: [1, 0, 0] });
    const m = mesh(tee(), { table: t, cap: "square" });
    expect(m.lines).toHaveLength(8);
    expect([...new Set(m.lines)]).toEqual([0]);
  });
});

describe("tessellateRoads: order", () => {
  test("emits lines by group, then rank, and ranges the index buffer per group", () => {
    const layer = linesOf(
      [
        [0, 2048, 0],
        [10, 2048, 0],
      ],
      [
        [0, 2058, 0],
        [10, 2058, 0],
      ],
      [
        [0, 2068, 0],
        [10, 2068, 0],
      ],
    );
    const m = mesh(layer, { table: tableOf(3, { group: [1, 0, 1], rank: [5, 0, 0] }) });
    expect([...m.lines]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0]);
    expect(m.groups).toEqual([
      { group: 0, start: 0, count: 6 },
      { group: 1, start: 6, count: 12 },
    ]);
    expect([...m.indices.subarray(6, 12)]).toEqual([4, 5, 6, 5, 7, 6]);
  });

  test("skips lines the style hides, repeated points, and lines of one point", () => {
    const layer = linesOf(
      [
        [0, 2048, 0],
        [10, 2048, 0],
      ],
      [
        [0, 2058, 0],
        [0, 2058, 0],
        [10, 2058, 0],
      ],
      [
        [5, 2078, 0],
        [5, 2078, 0],
      ],
    );
    const m = mesh(layer, { table: tableOf(3, { visible: [0, 1, 1] }) });
    expect([...m.lines]).toEqual([1, 1, 1, 1]);
  });

  test("an end where the data runs out joins no node and gets no cap", () => {
    // Two pieces meeting end to start, as two tiles' data stop at the same vertex.
    const lines = {
      ...linesOf(
        [
          [0, 2048, 0],
          [10, 2048, 0],
        ],
        [
          [10, 2048, 0],
          [20, 2048, 0],
        ],
      ),
      endClipped: Uint8Array.of(1, 0),
      startClipped: Uint8Array.of(0, 1),
    };
    const t = tableOf(2);
    const steps = Math.ceil(Math.PI / ARC_STEP);
    // Each line: its segment, and a round cap at its one free end.
    const m = mesh(lines, { table: t, cap: "round" });
    expect(m.lines).toHaveLength(2 * (4 + steps + 2));
    expect(verticesAt(m, 0, [10, 2048])).toHaveLength(2);
    expect(verticesAt(m, 1, [10, 2048])).toHaveLength(2);
  });
});

describe("continueShortLinks", () => {
  // A wide road (line 0, half 2.94, white) narrowing at a node of two into a narrow link (line 1,
  // half 0.98, grey) that runs on to a crossing; the taper would need 3 × 1.96 = 5.88 m.
  const styled = (n: number) => {
    const t = tableOf(n, { half: [2.94, 0.98, 2.94, 1, 1], rank: [0, -1, 0, 0, 0] });
    t.fill.set([255, 255, 255], 0);
    t.fill.set([170, 170, 170], 3);
    t.casing.set([90, 90, 90], 0);
    t.casing.set([170, 170, 170], 3);
    return t;
  };
  const run = (layer: Lines, t: StyleTable) =>
    continueShortLinks(layer, frame, metre, t, lineNodes(layer));
  const crossing = (length: number, from: [number, number] = [-30, 0]) =>
    linesOf(
      to(from, [0, 0]),
      to([0, 0], [length, 0]),
      to([length, 0], [length + 30, 0]),
      to([length, 0], [length, -20]),
      to([length, 0], [length, 20]),
    );

  test("a link too short for its taper into a junction takes the road it continues", () => {
    const t = run(crossing(4.6), styled(5));
    expect(t.halfWidth[1]).toBeCloseTo(2.94, 6);
    expect(t.outerHalfWidth[1]).toBe(t.outerHalfWidth[0]);
    expect(t.rank[1]).toBe(0);
    expect([...t.fill.subarray(3, 6)]).toEqual([255, 255, 255]);
    expect([...t.casing.subarray(3, 6)]).toEqual([90, 90, 90]);
    // The others are as they were.
    expect(t.halfWidth[3]).toBe(1);
  });

  test("a link long enough for its taper keeps its own style", () => {
    const t = run(crossing(6.5), styled(5));
    expect(t.halfWidth[1]).toBeCloseTo(0.98, 6);
    expect(t.rank[1]).toBe(-1);
  });

  test("a short link between two nodes of two keeps its own style", () => {
    const layer = linesOf(to([-30, 0], [0, 0]), to([0, 0], [4.6, 0]), to([4.6, 0], [30, 0]));
    const t = run(layer, styled(3));
    expect(t.halfWidth[1]).toBeCloseTo(0.98, 6);
  });

  test("a short link turning by more than a right angle from the wider road keeps its own style", () => {
    const t = run(crossing(4.6, [20, 20]), styled(5));
    expect(t.halfWidth[1]).toBeCloseTo(0.98, 6);
  });
});
