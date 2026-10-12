import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { lineTile, tileUrl } from "./tile";

// data/14/14342/6472.mlt: GSI 3D road centrelines, one v2 layer "roads", z in cm.
const data = new Uint8Array(
  readFileSync(new URL("./__fixtures__/roads-14-14342-6472.mlt", import.meta.url)),
);
const index = { z: 14, x: 14342, y: 6472 };

describe("lineTile", () => {
  test("decodes the layer, its line ids and its frame", () => {
    const tile = lineTile(data, index, "roads");
    expect(tile.layer.featureCount).toBe(1032);
    expect(tile.ids.featureOfLine).toHaveLength(1032);
    expect(tile.ids.lineOfVertex).toHaveLength(5883);
    expect(tile.zStep).toBe(-2);
    expect(tile.frame.origin).toEqual([14342 / 16384, 6472 / 16384]);
    expect(tile.frame.zScale).toBeCloseTo(0.01, 12);
  });

  test("rejects a tile without the layer", () => {
    expect(() => lineTile(data, index, "nope")).toThrow(/0 layers named "nope"/);
  });
});

describe("tileUrl", () => {
  test("fills the template", () => {
    expect(tileUrl("/tiles/{z}/{x}/{y}.mlt", { z: 5, x: 28, y: 12 })).toBe("/tiles/5/28/12.mlt");
  });
});
