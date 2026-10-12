import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { allProps } from "./props";
import { linesFor, type Piece, piecesOf, stitch } from "./stitch";
import type { Props } from "./style";
import { lineTile } from "./tile";

type Point = [number, number];

/** A piece at z 0 m; `start` / `end` mark a clip vertex at that end. */
function piece(points: Point[], o: { start?: boolean; end?: boolean; props?: Props } = {}): Piece {
  return {
    vertices: Float64Array.from(points.flatMap(([x, y]) => [x, y, 0])),
    props: o.props ?? { id: "a" },
    startClipped: o.start ?? false,
    endClipped: o.end ?? false,
  };
}

/** A line's `(x, y)` points and clip flags, for comparison. */
function shape(p: Piece) {
  const points: Point[] = [];
  for (let i = 0; i < p.vertices.length; i += 3) points.push([p.vertices[i], p.vertices[i + 1]]);
  return { points, start: p.startClipped, end: p.endClipped };
}

const sorted = (lines: Piece[]) =>
  lines
    .map(shape)
    .sort((a, b) => a.points[0][0] - b.points[0][0] || a.points[0][1] - b.points[0][1]);

describe("stitch", () => {
  test("joins pieces sharing a run of vertices", () => {
    const p = piece(
      [
        [0, 0],
        [10, 0],
        [20, 0],
        [40, 0],
        [45, 0],
      ],
      { end: true },
    );
    const q = piece(
      [
        [15, 0],
        [20, 0],
        [40, 0],
        [50, 0],
      ],
      { start: true },
    );
    expect(sorted(stitch([p, q]))).toEqual([
      {
        points: [
          [0, 0],
          [10, 0],
          [20, 0],
          [40, 0],
          [50, 0],
        ],
        start: false,
        end: false,
      },
    ]);
  });

  test("joins pieces sharing one vertex where both were clipped past it", () => {
    // A bend at (10, 0): the first tile clipped (10, 0)→(10, 20) at (10, 5), the second
    // (0, 0)→(10, 0) at (5, 0).
    const p = piece(
      [
        [0, 0],
        [10, 0],
        [10, 5],
      ],
      { end: true },
    );
    const q = piece(
      [
        [5, 0],
        [10, 0],
        [10, 20],
      ],
      { start: true },
    );
    expect(sorted(stitch([p, q]))).toEqual([
      {
        points: [
          [0, 0],
          [10, 0],
          [10, 20],
        ],
        start: false,
        end: false,
      },
    ]);
  });

  test("joins pieces across a segment with no vertex in either's overlap", () => {
    // The clip vertices are rounded to the grid, off the segment by up to half a unit.
    const p = piece(
      [
        [0, 0],
        [30, 0.4],
      ],
      { end: true },
    );
    const q = piece(
      [
        [70, -0.5],
        [100, 0],
      ],
      { start: true },
    );
    expect(sorted(stitch([p, q]))).toEqual([
      {
        points: [
          [0, 0],
          [100, 0],
        ],
        start: false,
        end: false,
      },
    ]);
  });

  test("joins a near-straight line through three tiles in order, not skipping the middle", () => {
    // Line 48663-12699-i-1451 around tile 18/229505/103583: (3251, -856) → (4254, -225) →
    // (4828, 135) → (5598, 683), so nearly straight that the first piece's clip vertex and the
    // last one's lie on the segment joining them too.
    const first = piece(
      [
        [3251, -856],
        [4160, -284],
      ],
      { end: true },
    );
    const middle = piece(
      [
        [4032, -364],
        [4254, -225],
        [4715, 64],
      ],
      { start: true, end: true },
    );
    const last = piece(
      [
        [4510, -64],
        [4828, 135],
        [5598, 683],
      ],
      { start: true },
    );
    expect(sorted(stitch([first, middle, last]))).toEqual([
      {
        points: [
          [3251, -856],
          [4254, -225],
          [4828, 135],
          [5598, 683],
        ],
        start: false,
        end: false,
      },
    ]);
  });

  test("does not join across a segment the clip vertices are not on", () => {
    const p = piece(
      [
        [0, 0],
        [30, 0],
      ],
      { end: true },
    );
    const q = piece(
      [
        [70, 10],
        [100, 0],
      ],
      { start: true },
    );
    expect(stitch([p, q])).toHaveLength(2);
  });

  test("removes duplicates and pieces contained in another", () => {
    const whole = piece([
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
    const part = piece(
      [
        [5, 0],
        [10, 0],
        [20, 0],
        [25, 0],
      ],
      { start: true, end: true },
    );
    expect(sorted(stitch([whole, part, whole]))).toEqual([shape(whole)]);
  });

  test("keeps lines meeting at a node apart, even with equal properties", () => {
    const a = piece([
      [0, 0],
      [10, 0],
    ]);
    const b = piece([
      [10, 0],
      [20, 0],
    ]);
    const c = piece([
      [10, 0],
      [10, 10],
    ]);
    expect(stitch([a, b, c])).toHaveLength(3);
  });

  test("keeps pieces of different properties apart", () => {
    const p = piece(
      [
        [0, 0],
        [10, 0],
        [20, 0],
        [25, 0],
      ],
      { end: true },
    );
    const q = piece(
      [
        [15, 0],
        [20, 0],
        [30, 0],
      ],
      { start: true, props: { id: "b" } },
    );
    expect(stitch([p, q])).toHaveLength(2);
  });

  test("drops a piece of clip vertices only that a joined line covers", () => {
    const p = piece(
      [
        [0, 0],
        [30, 0],
      ],
      { end: true },
    );
    const through = piece(
      [
        [25, 0],
        [75, 1],
      ],
      { start: true, end: true },
    );
    const q = piece(
      [
        [70, 0],
        [100, 0],
      ],
      { start: true },
    );
    expect(sorted(stitch([p, through, q]))).toEqual([
      {
        points: [
          [0, 0],
          [100, 0],
        ],
        start: false,
        end: false,
      },
    ]);
  });

  test("extends an unresolved clipped end along a piece of clip vertices only", () => {
    const p = piece(
      [
        [0, 0],
        [30, 0],
      ],
      { end: true },
    );
    const beyond = piece(
      [
        [25, 0],
        [60, 0],
      ],
      { start: true, end: true },
    );
    expect(sorted(stitch([p, beyond]))).toEqual([
      {
        points: [
          [0, 0],
          [60, 0],
        ],
        start: false,
        end: true,
      },
    ]);
  });

  test("extends a clipped end along a long piece of clip vertices only, despite rounding", () => {
    // Line 48663-12708-i-801 around tile 18/229506/103562: the clip vertex next to the first
    // vertex is too near it to give the direction to within the rounding over the long piece.
    const q = piece(
      [
        [4856, -64],
        [4952, 333],
      ],
      { start: true },
    );
    const through = piece(
      [
        [4032, -3506],
        [4887, 64],
      ],
      { start: true, end: true },
    );
    expect(sorted(stitch([q, through]))).toEqual([
      {
        points: [
          [4032, -3506],
          [4952, 333],
        ],
        start: true,
        end: false,
      },
    ]);
  });

  test("extends a clipped end to the farthest of several pieces, whatever their order", () => {
    // Line 48645-12711-i-1261 around tile 18/229467/103553: one segment crossing four tiles.
    const pieces = [
      piece(
        [
          [4160, 36],
          [4079, 64],
        ],
        { start: true, end: true },
      ),
      piece(
        [
          [8256, -1364],
          [4079, 64],
        ],
        { start: true, end: true },
      ),
      piece(
        [
          [4160, 36],
          [3425, 288],
        ],
        { start: true },
      ),
      piece(
        [
          [4453, -64],
          [4032, 80],
        ],
        { start: true, end: true },
      ),
    ];
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
    ]) {
      expect(sorted(stitch(order.map((i) => pieces[i])))).toEqual([
        {
          points: [
            [8256, -1364],
            [3425, 288],
          ],
          start: true,
          end: false,
        },
      ]);
    }
  });

  test("merges a short and a long piece of clip vertices only on one segment", () => {
    const short = piece(
      [
        [0, 0],
        [100, 0],
      ],
      { start: true, end: true },
    );
    const long = piece(
      [
        [50, 0.5],
        [5000, 49.5],
      ],
      { start: true, end: true },
    );
    expect(stitch([short, long])).toHaveLength(1);
  });

  test("merges overlapping pieces of clip vertices only on one segment", () => {
    const a = piece(
      [
        [0, 0],
        [60, 0],
      ],
      { start: true, end: true },
    );
    const b = piece(
      [
        [40, 0],
        [100, 1],
      ],
      { start: true, end: true },
    );
    expect(sorted(stitch([a, b]))).toEqual([
      {
        points: [
          [0, 0],
          [100, 1],
        ],
        start: true,
        end: true,
      },
    ]);
  });

  test("keeps an unresolved clipped end with its clip vertex", () => {
    const p = piece(
      [
        [0, 0],
        [10, 0],
        [15, 0],
      ],
      { end: true },
    );
    expect(sorted(stitch([p]))).toEqual([shape(p)]);
  });

  test("orders lines by properties, independent of the order of the pieces", () => {
    const a = piece(
      [
        [0, 0],
        [10, 0],
      ],
      { props: { id: "b" } },
    );
    const b = piece(
      [
        [0, 5],
        [10, 5],
      ],
      { props: { id: "a" } },
    );
    expect(stitch([a, b]).map((l) => l.props.id)).toEqual(["a", "b"]);
    expect(stitch([b, a]).map((l) => l.props.id)).toEqual(["a", "b"]);
  });
});

describe("the crossing at node (4248, 2123) across tiles 18/229456/103565 and 18/229457/103565", () => {
  const read = (x: number) => {
    const data = readFileSync(new URL(`./__fixtures__/roads-18-${x}-103565.mlt`, import.meta.url));
    const tile = lineTile(new Uint8Array(data), { z: 18, x, y: 103565 }, "roads");
    return { tile, props: allProps(tile.layer) };
  };
  const a = read(229456);
  const b = read(229457);
  // Both in the first tile's units.
  const pieces = [
    ...piecesOf(a.tile, a.props, 64, [0, 0]),
    ...piecesOf(b.tile, b.props, 64, [4096, 0]),
  ];
  const lines = stitch(pieces);
  const byId = (id: string) =>
    lines.filter((l) => l.props.rID === `48639-12708-i-${id}`).map(shape);

  test("piecesOf marks the vertices on the buffer box as clipped", () => {
    const of = (id: string) =>
      piecesOf(a.tile, a.props, 64, [0, 0])
        .filter((p) => p.props.rID === `48639-12708-i-${id}`)
        .map(shape);
    expect(of("2521")).toEqual([
      {
        points: [
          [4160, 2112],
          [3633, 2049],
        ],
        start: true,
        end: false,
      },
    ]);
    expect(of("2484")).toEqual([
      {
        points: [
          [3570, -64],
          [4160, 1840],
        ],
        start: true,
        end: true,
      },
    ]);
    expect(of("2528")[0]).toMatchObject({ start: false, end: false });
  });

  test("piecesOf puts z in metres", () => {
    const [p] = piecesOf(a.tile, a.props, 64, [0, 0]);
    const z = a.tile.layer.geometry.vertices[2];
    expect(p.vertices[2]).toBeCloseTo(z * a.tile.frame.zScale + a.tile.frame.zOffset, 9);
  });

  test("piecesOf keeps only the lines whose bounds meet a box, given one", () => {
    const all = piecesOf(a.tile, a.props, 64, [0, 0]);
    const near = piecesOf(a.tile, a.props, 64, [0, 0], [4000, 1800, 4200, 2400]);
    const ids = (pieces: Piece[]) => pieces.map((p) => String(p.props.rID)).toSorted();
    expect(ids(near)).toEqual(["2460", "2484", "2521", "2543"].map((id) => `48639-12708-i-${id}`));
    expect(all.length).toBeGreaterThan(near.length);
  });

  test("piecesOf throws when a vertex lies beyond the buffer", () => {
    expect(() => piecesOf(a.tile, a.props, 32, [0, 0])).toThrow(/beyond the tile's buffer of 32/);
  });

  test("each link through the node is one line, ending unclipped at the node", () => {
    expect(byId("2521")).toEqual([
      {
        points: [
          [4248, 2123],
          [3633, 2049],
        ],
        start: false,
        end: false,
      },
    ]);
    expect(byId("2460")).toEqual([
      {
        points: [
          [2439, 2552],
          [2895, 2525],
          [3815, 2591],
          [4132, 2400],
          [4248, 2123],
        ],
        start: false,
        end: false,
      },
    ]);
    expect(byId("2543")).toEqual([
      {
        points: [
          [1807, 1635],
          [2359, 1523],
          [3046, 1498],
          [3522, 1537],
          [4031, 1830],
          [4248, 2123],
        ],
        start: false,
        end: false,
      },
    ]);
    // Its far end lies beyond both tiles: it keeps the farthest clip vertex.
    expect(byId("2484")).toEqual([
      {
        points: [
          [3570, -64],
          [4248, 2123],
        ],
        start: true,
        end: false,
      },
    ]);
    const ends = lines.filter((l) => {
      const n = l.vertices.length;
      return (
        (!l.startClipped && l.vertices[0] === 4248 && l.vertices[1] === 2123) ||
        (!l.endClipped && l.vertices[n - 3] === 4248 && l.vertices[n - 2] === 2123)
      );
    });
    expect(ends.map((l) => String(l.props.rID)).toSorted()).toEqual(
      ["2460", "2484", "2513", "2520", "2521", "2543"].map((id) => `48639-12708-i-${id}`),
    );
  });
});

describe("linesFor", () => {
  test("cuts lines to the tile and its margin, marking the cut ends clipped", () => {
    // Extent 100, margin 10: the box is -10 .. 110.
    const across = piece([
      [-50, 50],
      [-20, 50],
      [50, 50],
      [130, 50],
      [150, 50],
    ]);
    const inside = piece(
      [
        [20, 20],
        [30, 30],
      ],
      { end: true },
    );
    // No vertex in the box: kept whole, its own ends.
    const passing = piece([
      [-30, -30],
      [130, 130],
    ]);
    const outside = piece([
      [200, 200],
      [300, 300],
    ]);
    const lines = linesFor([across, inside, passing, outside], 100, 10);
    const all = Array.from({ length: lines.lineStart.length - 1 }, (_, l) => {
      const points: Point[] = [];
      for (let i = lines.lineStart[l]; i < lines.lineStart[l + 1]; i++) {
        points.push([lines.vertices[i * 3], lines.vertices[i * 3 + 1]]);
      }
      return { points, start: lines.startClipped[l] === 1, end: lines.endClipped[l] === 1 };
    });
    expect(all).toEqual([
      {
        points: [
          [-20, 50],
          [50, 50],
          [130, 50],
        ],
        start: true,
        end: true,
      },
      {
        points: [
          [20, 20],
          [30, 30],
        ],
        start: false,
        end: true,
      },
      {
        points: [
          [-30, -30],
          [130, 130],
        ],
        start: false,
        end: false,
      },
    ]);
    expect(lines.props).toEqual([across.props, inside.props, passing.props]);
  });

  test("splits a line leaving and re-entering the box", () => {
    const out = piece([
      [0, 50],
      [50, 50],
      [50, 300],
      [60, 300],
      [60, 50],
      [90, 50],
    ]);
    const lines = linesFor([out], 100, 10);
    expect([...lines.lineStart]).toEqual([0, 3, 6]);
    expect([...lines.startClipped]).toEqual([0, 1]);
    expect([...lines.endClipped]).toEqual([1, 0]);
  });
});
