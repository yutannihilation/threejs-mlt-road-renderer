import { describe, expect, test } from "vite-plus/test";
import { linesOf } from "./__fixtures__/lines";
import { centrelineSegments } from "./centrelines";
import { metreFrame, metreScale } from "./transform";

// The world tile: one tile unit is 1 / 4096 of the world.
const frame = metreFrame({ z: 0, x: 0, y: 0 }, 4096);
const metre = 1 / 4096;

describe("centrelineSegments", () => {
  test("each segment of each line is a pair of points, in the tile's Mercator units", () => {
    const lines = linesOf(
      [
        [0, 2048, 10],
        [100, 2048, 20],
        [100, 2148, 30],
      ],
      [
        [400, 1024, 0],
        [500, 1024, 0],
      ],
    );
    const s = centrelineSegments(lines, frame, metre);
    // Two segments of the first line, one of the second, and none between the lines.
    expect(s).toHaveLength(3 * 2 * 3);
    const point = (i: number) => [...s.subarray(i * 3, i * 3 + 3)];
    expect(point(0)[0]).toBeCloseTo(0, 9);
    expect(point(0)[1]).toBeCloseTo(0.5, 9);
    // z is the elevation in Mercator units at the point's latitude, as the ribbons place it,
    // stored as 32-bit floats.
    expect(point(0)[2]).toBe(Math.fround(10 * metre * metreScale(0.5)));
    expect(point(1)).toEqual(point(2));
    expect(point(3)[1]).toBeCloseTo(2148 / 4096, 9);
    expect(point(3)[2]).toBe(Math.fround(30 * metre * metreScale(2148 / 4096)));
    expect(point(4)[0]).toBeCloseTo(400 / 4096, 9);
    expect(point(5)[0]).toBeCloseTo(500 / 4096, 9);
  });

  test("a line of one point has no segment", () => {
    expect(centrelineSegments(linesOf([[0, 0, 0]]), frame, metre)).toHaveLength(0);
  });
});
