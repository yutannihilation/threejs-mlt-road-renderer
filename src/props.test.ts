import type { MltColumnLayer } from "@maplibre/mlt-wasm";
import { describe, expect, test } from "vite-plus/test";
import { allProps, featureProps } from "./props";

const layer: MltColumnLayer = {
  name: "roads",
  extent: 4096,
  version: 2,
  featureCount: 3,
  geometry: {
    types: Uint8Array.of(0, 0, 0),
    dimension: 3,
    vertices: Int32Array.of(0, 0, 0, 1, 1, 1, 2, 2, 2),
    zStep: 0,
  },
  properties: [
    // Feature 1 has no rdCtg.
    {
      name: "rdCtg",
      type: "string",
      values: ["国道", "", "都道府県道"],
      present: Uint8Array.of(0b101),
    },
    { name: "motorway", type: "i32", values: Int32Array.of(0, 9, 1) },
    { name: "toll", type: "bool", values: Uint8Array.of(1, 0, 1) },
  ],
};

describe("featureProps", () => {
  test("reads one feature's columns, bools as booleans", () => {
    expect(featureProps(layer, 0)).toEqual({ rdCtg: "国道", motorway: 0, toll: true });
  });

  test("leaves a column out when the feature has no value", () => {
    expect(featureProps(layer, 1)).toEqual({ motorway: 9, toll: false });
  });

  test("rejects a feature index out of range", () => {
    expect(() => featureProps(layer, 3)).toThrow();
  });
});

describe("allProps", () => {
  test("reads every feature in order", () => {
    const all = allProps(layer);
    expect(all).toHaveLength(3);
    expect(all[2]).toEqual({ rdCtg: "都道府県道", motorway: 1, toll: true });
  });
});
