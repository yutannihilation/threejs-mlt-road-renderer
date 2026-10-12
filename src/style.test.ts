import { describe, expect, test } from "vite-plus/test";
import {
  evaluateStyle,
  parseColor,
  type Props,
  type RoadStyle,
  STYLE_WIDTH,
  type StyleTable,
  styleTexels,
} from "./style";

describe("parseColor", () => {
  test("accepts a byte triple and the CSS forms a style would use", () => {
    expect(parseColor([1, 2, 3])).toEqual([1, 2, 3]);
    expect(parseColor("#f00")).toEqual([255, 0, 0]);
    expect(parseColor("#1a2b3c")).toEqual([26, 43, 60]);
    expect(parseColor("rgb(1 2 3)")).toEqual([1, 2, 3]);
    expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
  });

  test("rejects anything else, naming it", () => {
    expect(() => parseColor("red")).toThrow(/"red"/);
    expect(() => parseColor("#12345")).toThrow(/"#12345"/);
  });
});

// Three features; feature 2 has two lines, which share its props object.
const features: Props[] = [
  { c: "a", w: 4 },
  { c: "b", w: 2 },
  { c: "a", w: 4 },
];
const props = [0, 1, 2, 2].map((f) => features[f]);
const style: RoadStyle = {
  group: (p) => (p.c === "a" ? 1 : 0),
  rank: (p) => p.w as number,
  width: (p) => p.w as number,
  color: (p) => (p.c === "a" ? "#ff0000" : [0, 0, 255]),
  outline: { width: () => 0.5, color: () => "#000" },
};

describe("evaluateStyle", () => {
  test("evaluates every line through its props", () => {
    const table = evaluateStyle(style, props);
    expect(table.lines).toBe(4);
    expect([...table.visible]).toEqual([1, 1, 1, 1]);
    expect([...table.group]).toEqual([1, 0, 1, 1]);
    expect([...table.rank]).toEqual([4, 2, 4, 4]);
    expect([...table.halfWidth]).toEqual([2, 1, 2, 2]);
    expect([...table.outerHalfWidth]).toEqual([2.5, 1.5, 2.5, 2.5]);
    expect([...table.fill.subarray(0, 6)]).toEqual([255, 0, 0, 0, 0, 255]);
    expect([...table.casing.subarray(0, 6)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(table.groups).toEqual([0, 1]);
  });

  test("filters lines out, and lists only the groups left", () => {
    const table = evaluateStyle({ ...style, filter: (p) => p.c === "a" }, props);
    expect([...table.visible]).toEqual([1, 0, 1, 1]);
    expect(table.groups).toEqual([1]);
  });

  test("defaults group and rank to 0 and the casing to the fill", () => {
    const table = evaluateStyle({ width: () => 3, color: () => "#0f0" }, props);
    expect([...table.group]).toEqual([0, 0, 0, 0]);
    expect([...table.rank]).toEqual([0, 0, 0, 0]);
    expect([...table.outerHalfWidth]).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect([...table.casing]).toEqual([...table.fill]);
    expect(table.groups).toEqual([0]);
  });

  test("rejects widths, groups and ranks a shader cannot use, naming the line", () => {
    const base = { color: () => "#000" };
    const evaluate = (s: RoadStyle) => () => evaluateStyle(s, props);
    expect(evaluate({ ...base, width: (p) => (p.c === "b" ? -1 : 1) })).toThrow(/line 1/);
    expect(evaluate({ ...base, width: () => Number.NaN })).toThrow(/line 0/);
    expect(
      evaluate({ ...base, width: () => 1, outline: { width: () => -0.1, color: () => "#000" } }),
    ).toThrow(/line 0/);
    expect(evaluate({ ...base, width: () => 1, group: () => 1.5 })).toThrow(/line 0/);
    expect(evaluate({ ...base, width: () => 1, rank: () => Number.POSITIVE_INFINITY })).toThrow(
      /line 0/,
    );
  });
});

describe("styleTexels", () => {
  const tableOf = (lines: number): StyleTable => ({
    lines,
    visible: new Uint8Array(lines).fill(1),
    group: new Int32Array(lines),
    rank: new Int32Array(lines),
    halfWidth: new Float32Array(lines).fill(2),
    outerHalfWidth: new Float32Array(lines).fill(2.5),
    fill: new Uint8Array(lines * 3).fill(255),
    casing: new Uint8Array(lines * 3),
    groups: [0],
  });

  test("writes two float texels per line: fill and casing, colour then half width", () => {
    const { texels, height } = styleTexels(tableOf(2));
    expect(height).toBe(1);
    expect(texels).toHaveLength(STYLE_WIDTH * 4);
    expect([...texels.subarray(0, 8)]).toEqual([1, 1, 1, 2, 0, 0, 0, 2.5]);
    expect([...texels.subarray(8, 16)]).toEqual([1, 1, 1, 2, 0, 0, 0, 2.5]);
  });

  test("wraps into rows of STYLE_WIDTH texels", () => {
    const { texels, height } = styleTexels(tableOf(600));
    expect(height).toBe(2);
    expect(texels).toHaveLength(STYLE_WIDTH * 2 * 4);
  });
});
