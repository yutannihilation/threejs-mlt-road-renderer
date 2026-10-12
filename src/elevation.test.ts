import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { elevationRange, unionRange } from "./elevation";
import { lineTile } from "./tile";

const data = new Uint8Array(
  readFileSync(new URL("./__fixtures__/roads-14-14342-6472.mlt", import.meta.url)),
);
const tile = lineTile(data, { z: 14, x: 14342, y: 6472 }, "roads");

describe("elevationRange", () => {
  test("is the lowest and highest vertex of the tile, in metres", () => {
    const { vertices } = tile.layer.geometry;
    const { zScale, zOffset } = tile.frame;
    let [lo, hi] = [Infinity, -Infinity];
    for (let k = 2; k < vertices.length; k += 3) {
      const z = vertices[k] * zScale + zOffset;
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    const range = elevationRange(tile);
    expect(range).toBeDefined();
    expect(range![0]).toBeCloseTo(lo, 9);
    expect(range![1]).toBeCloseTo(hi, 9);
    expect(range![0]).toBeLessThan(range![1]);
  });
});

describe("unionRange", () => {
  test("covers both ranges", () => {
    expect(unionRange([10, 20], [15, 40])).toEqual([10, 40]);
    expect(unionRange([-5, 0], [3, 4])).toEqual([-5, 4]);
  });

  test("is the other range where one is missing", () => {
    expect(unionRange(undefined, [1, 2])).toEqual([1, 2]);
    expect(unionRange([1, 2], undefined)).toEqual([1, 2]);
    expect(unionRange(undefined, undefined)).toBeUndefined();
  });
});
