import { describe, expect, test } from "vite-plus/test";
import { linesOf, type Point } from "./__fixtures__/lines";
import type { StyleTable } from "./style";
import { collapseStubs } from "./stubs";
import { lineNodes } from "./topology";
import { metreFrame } from "./transform";

// The world tile, where at the equator (y = 2048) one tile unit is one metre.
const frame = metreFrame({ z: 0, x: 0, y: 0 }, 4096);
const metre = 1 / 4096;

function tableOf(half: number[], visible = half.map(() => 1)): StyleTable {
  const n = half.length;
  const group = new Int32Array(n);
  return {
    lines: n,
    visible: Uint8Array.from(visible),
    group,
    rank: new Int32Array(n),
    halfWidth: Float32Array.from(half),
    outerHalfWidth: Float32Array.from(half, (h) => h + 0.5),
    fill: new Uint8Array(n * 3),
    casing: new Uint8Array(n * 3),
    groups: [0],
  };
}

/** The points `(x, y)` metres from the tile's centre, at height `z`. */
const to = (...points: [number, number, number?][]): Point[] =>
  points.map(([x, y, z = 434]) => [2048 + x, 2048 + y, z]);

/** Line `l`'s vertex `k` (negative from its end), as `[x, y, z]`. */
function vertexOf(
  { vertices, lineStart }: { vertices: ArrayLike<number>; lineStart: ArrayLike<number> },
  l: number,
  k: number,
): number[] {
  const i = k >= 0 ? lineStart[l] + k : lineStart[l + 1] + k;
  return [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
}

describe("collapseStubs", () => {
  // From Zürich Nord (swissTLM3D), in metres: a 10 m road (line 0) ending at a node N, and two
  // carriageways (lines 3 and 4) starting 0.7 m to either side of it, joined to N by two
  // connectors (lines 1 and 2) running across the road.
  const split = () =>
    linesOf(
      to([0, 0], [4.23, -0.46], [12.26, -0.82]),
      to([0.15, 0.63], [0, 0]),
      to([0, 0], [-0.1, -0.69]),
      to([-33.71, 7.55], [-19.04, 4.66], [-7.8, 2.52], [0.15, 0.63]),
      to([-0.1, -0.69], [-2.27, -0.45], [-11.33, 1.47], [-19.38, 2.93]),
    );
  const N = [2048, 2048, 434];

  test("hides a line joined at both ends and shorter than its half width, merging its nodes", () => {
    const input = split();
    const table = tableOf([5, 2, 2, 2, 1.5]);
    const { lines, table: out } = collapseStubs(input, frame, metre, table, lineNodes(input));
    expect([...out.visible]).toEqual([1, 0, 0, 1, 1]);
    // The carriageways now end at N itself, where the road ends.
    expect(vertexOf(lines, 3, -1)).toEqual(N);
    expect(vertexOf(lines, 4, 0)).toEqual(N);
    const nodes = lineNodes(lines);
    expect(nodes.endNode[3]).toBe(nodes.startNode[0]);
    expect(nodes.startNode[4]).toBe(nodes.startNode[0]);
    // Only the ends of a line move; the rest stays, and so does the input.
    expect(vertexOf(lines, 3, -2)).toEqual(vertexOf(input, 3, -2));
    expect(vertexOf(input, 3, -1)).toEqual([2048.15, 2048.63, 434]);
    expect([...table.visible]).toEqual([1, 1, 1, 1, 1]);
  });

  test("merges a chain of stubs into the node most lines meet at", () => {
    // Line 0 ends at N; stub 1 runs from N to A, where line 2 starts; stub 3 runs on from A to B,
    // where line 4 starts. N has two ends besides the stubs' none; A and B one each.
    const input = linesOf(
      to([-20, 0], [0, 0]),
      to([0, 0], [0.5, 0]),
      to([0.5, 0], [0.5, 20]),
      to([0.5, 0], [1, 0]),
      to([1, 0], [20, 0]),
      to([0, 0], [0, -20]),
    );
    const table = tableOf([3, 2, 3, 2, 3, 3]);
    const { lines, table: out } = collapseStubs(input, frame, metre, table, lineNodes(input));
    expect([...out.visible]).toEqual([1, 0, 1, 0, 1, 1]);
    expect(vertexOf(lines, 2, 0)).toEqual(N);
    expect(vertexOf(lines, 4, 0)).toEqual(N);
  });

  test("keeps a short line with a free end, one as long as its half width, and hidden lines", () => {
    const input = linesOf(
      to([-20, 0], [0, 0]),
      // A free end.
      to([0, 0], [0, 1]),
      // Joined at both ends, but 2 m long at a half width of 2.
      to([0, 0], [2, 0]),
      to([2, 0], [20, 0]),
      to([0, 0], [0, -20]),
    );
    const table = tableOf([3, 2, 2, 3, 3]);
    const { lines, table: out } = collapseStubs(input, frame, metre, table, lineNodes(input));
    expect(lines).toBe(input);
    expect(out).toBe(table);
    // A stub the style hides is left as it is.
    const hidden = tableOf([3, 2, 2, 3, 3], [1, 1, 0, 1, 1]);
    hidden.halfWidth[2] = 5;
    expect(collapseStubs(input, frame, metre, hidden, lineNodes(input)).lines).toBe(input);
  });

  test("does not join a stub's ends where nothing else meets one of them", () => {
    // Line 1 is short, but only line 0 meets it: it is a free end of the network, not a stub.
    const input = linesOf(to([-20, 0], [0, 0]), to([0, 0], [0.5, 0]));
    const table = tableOf([3, 2]);
    expect(collapseStubs(input, frame, metre, table, lineNodes(input)).lines).toBe(input);
  });
});
