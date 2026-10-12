import { describe, expect, test } from "vite-plus/test";
import { linesOf } from "./__fixtures__/lines";
import { lineNodes } from "./topology";

describe("lineNodes", () => {
  test("groups line ends at nodes by exact x, y, z", () => {
    // A: (0,0,0)→(10,0,0); B: (10,0,0)→(20,0,0); C: (10,0,0)→(10,10,0);
    // D: (10,0,5)→(30,30,0), same x, y as the junction but another z, so another node;
    // E: a single point, which makes no segment and touches no node.
    const t = lineNodes(
      linesOf(
        [
          [0, 0, 0],
          [10, 0, 0],
        ],
        [
          [10, 0, 0],
          [20, 0, 0],
        ],
        [
          [10, 0, 0],
          [10, 10, 0],
        ],
        [
          [10, 0, 5],
          [30, 30, 0],
        ],
        [[5, 5, 5]],
      ),
    );
    const degree = (n: number) => (n < 0 ? 0 : t.nodes[n].length);
    expect([...t.startNode].map(degree)).toEqual([1, 3, 3, 1, 0]);
    expect([...t.endNode].map(degree)).toEqual([3, 1, 1, 1, 0]);
    expect(t.nodes[t.endNode[0]]).toEqual([
      { line: 0, atEnd: true },
      { line: 1, atEnd: false },
      { line: 2, atEnd: false },
    ]);
    expect(t.startNode[4]).toBe(-1);
  });

  test("a closed line meets itself at its node", () => {
    const t = lineNodes(
      linesOf([
        [0, 0, 0],
        [5, 0, 0],
        [5, 5, 0],
        [0, 0, 0],
      ]),
    );
    expect(t.startNode[0]).toBe(t.endNode[0]);
    expect(t.nodes[t.startNode[0]]).toEqual([
      { line: 0, atEnd: false },
      { line: 0, atEnd: true },
    ]);
  });

  test("an end where the data runs out joins no node", () => {
    const lines = linesOf(
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      [
        [10, 0, 0],
        [20, 0, 0],
      ],
    );
    const t = lineNodes({
      ...lines,
      startClipped: Uint8Array.of(0, 1),
      endClipped: Uint8Array.of(1, 0),
    });
    expect(t.endNode[0]).toBe(-1);
    expect(t.startNode[1]).toBe(-1);
    expect(t.nodes.map((n) => n.length)).toEqual([1, 1]);
  });

  test("handles a layer without lines", () => {
    const t = lineNodes(linesOf());
    expect(t.startNode).toHaveLength(0);
    expect(t.nodes).toHaveLength(0);
  });
});
