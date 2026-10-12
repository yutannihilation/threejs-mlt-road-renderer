import { readFileSync } from "node:fs";
import { decodeTileColumns, type MltColumnLayer, MltGeometryType } from "@maplibre/mlt-wasm";
import { describe, expect, test } from "vite-plus/test";
import { lineIds } from "./lines";

const data = readFileSync(new URL("./__fixtures__/roads-14-14342-6472.mlt", import.meta.url));
const [layer] = decodeTileColumns(new Uint8Array(data), { layers: ["roads"] }).layers;

describe("lineIds", () => {
  test("numbers each line's vertices and maps lines to features", () => {
    const { lineOfVertex, featureOfLine, lineStart, featureLineStart } = lineIds(layer);
    // Every feature is one LineString.
    expect(featureOfLine).toHaveLength(1032);
    expect(featureOfLine.every((f, l) => f === l)).toBe(true);
    expect(lineStart).toHaveLength(1033);
    expect(lineStart[0]).toBe(0);
    expect(lineStart[1032]).toBe(5883);
    expect(lineOfVertex).toHaveLength(5883);
    expect(lineOfVertex[0]).toBe(0);
    expect(lineOfVertex[5882]).toBe(1031);
    expect(featureLineStart[1032]).toBe(1032);
  });

  test("rejects a feature that is not a line", () => {
    const point: MltColumnLayer = {
      ...layer,
      featureCount: 1,
      geometry: {
        ...layer.geometry,
        types: Uint8Array.of(MltGeometryType.Point),
        geometryOffsets: undefined,
        partOffsets: undefined,
      },
    };
    expect(() => lineIds(point)).toThrow(/is a Point, expected a line/);
  });
});
