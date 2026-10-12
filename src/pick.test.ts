import { describe, expect, test } from "vite-plus/test";
import { linesOf } from "./__fixtures__/lines";
import type { Lines } from "./lines";
import { pickRoad, type PickTarget, projectVertex } from "./pick";
import type { StyleTable } from "./style";
import { tileFrame } from "./transform";

function tableOf(n: number, visible?: number[], outerHalfWidth = 2.5): StyleTable {
  return {
    lines: n,
    visible: visible ? Uint8Array.from(visible) : new Uint8Array(n).fill(1),
    group: new Int32Array(n),
    rank: new Int32Array(n),
    halfWidth: new Float32Array(n).fill(2),
    outerHalfWidth: new Float32Array(n).fill(outerHalfWidth),
    fill: new Uint8Array(n * 3),
    casing: new Uint8Array(n * 3),
    groups: [0],
  };
}

// The world tile; Mercator (0..1) to clip (-1..1) with y flipped, as a column-major matrix.
const frame = tileFrame({ z: 0, x: 0, y: 0 }, 4096, 0);
const matrix = [2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1];
const metre = 1 / 4096;
const view = { width: 100, height: 100 };

function target(lines: Lines, visible?: number[], outerHalfWidth?: number): PickTarget {
  const table = tableOf(lines.props.length, visible, outerHalfWidth);
  return { index: { z: 0, x: 0, y: 0 }, lines, frame, table, matrix };
}

describe("projectVertex", () => {
  test("places a tile vertex on screen through the tile's matrix", () => {
    // Tile unit 2048 is Mercator 0.5, the middle of a 100 px view.
    expect(projectVertex(frame, metre, matrix, view, 2048, 2048, 10000)).toEqual([50, 50]);
    expect(projectVertex(frame, metre, matrix, view, 0, 4096, 10000)).toEqual([0, 100]);
  });

  test("is null behind the camera", () => {
    const behind = [...matrix];
    behind[15] = -1;
    expect(projectVertex(frame, metre, behind, view, 2048, 2048, 10000)).toBeNull();
  });
});

describe("pickRoad", () => {
  // Line 0 across the middle, line 1 down the right; neither touches the poles, where a metre
  // in Mercator units, and so a ribbon, grows without bound.
  const layer = linesOf(
    [
      [0, 2048, 10000],
      [4096, 2048, 10000],
    ],
    [
      [3277, 1024, 10000],
      [3277, 4096, 10000],
    ],
  );

  test("finds the nearest segment within the radius", () => {
    const hit = pickRoad([target(layer)], 30, 53, view, metre, 5);
    expect(hit).toMatchObject({ index: { z: 0, x: 0, y: 0 }, line: 0, props: { id: 0 } });
    expect(hit?.distance).toBeCloseTo(3, 6);
    expect(pickRoad([target(layer)], 78, 40, view, metre, 5)?.line).toBe(1);
  });

  test("accepts a click anywhere on the drawn ribbon, the radius being slack beyond its edge", () => {
    // 400 m at the equator of the world tile is 400 / 4096 of 100 px: a 9.8 px half width.
    const wide = target(layer, undefined, 400);
    expect(pickRoad([wide], 30, 59, view, metre, 0)?.line).toBe(0);
    expect(pickRoad([wide], 30, 62, view, metre, 0)).toBeNull();
    expect(pickRoad([wide], 30, 62, view, metre, 3)?.line).toBe(0);
  });

  test("is null farther than the radius, and ignores hidden lines", () => {
    expect(pickRoad([target(layer)], 30, 60, view, metre, 5)).toBeNull();
    expect(pickRoad([target(layer, [0, 1])], 30, 53, view, metre, 5)).toBeNull();
  });

  test("of roads overlapping on screen, picks the one nearest the camera", () => {
    // Line 0 at ground level across the middle; line 1 crossing it 30 m higher. Here clip z is
    // minus the elevation, so higher is nearer.
    const crossing = linesOf(
      [
        [0, 2048, 10000],
        [4096, 2048, 10000],
      ],
      [
        [1024, 1800, 10030],
        [3072, 2300, 10030],
      ],
    );
    const toward = [...matrix];
    toward[10] = -1;
    const t = { ...target(crossing, undefined, 400), matrix: toward };
    // At (40, 50.5) line 0's centreline is 0.5 px away and line 1's farther, but both ribbons
    // cover the point: the higher road wins.
    const hit = pickRoad([t], 40, 50.5, view, metre, 0);
    expect(hit?.line).toBe(1);
  });

  test("a road passing under and behind the camera does not claim the screen", () => {
    // Captured from the demo at #19.66/35.3023434/135.1264089/-36/35: a road of tile
    // 14/14341/6472 runs off screen below the camera, crossing behind it, while the middle of
    // the view shows another junction entirely.
    const index = { z: 14, x: 14341, y: 6472 };
    const base = linesOf([
      [2629, 4063, 1001586],
      [2636, 4063, 1001582],
      [2714, 4052, 1001579],
      [2767, 4047, 1001582],
    ]);
    const table = tableOf(1, undefined, 3.4115774631500244);
    const m = [
      579056714.423382, -612666501.3854128, -144983799.73601174, -142997900.89287856,
      -420709329.1556423, -843263095.7852094, -199553080.71785986, -196819725.4542867, 0,
      729847679.9230322, -352268662.39892316, -347443503.1024784, -5099.346990287304,
      71280.76422894001, 17934.157776892185, 17717.109480798244,
    ];
    const metre = 2.4981121214570498e-8;
    const hit = pickRoad(
      [{ index, lines: base, frame: tileFrame(index, 4096, -2), table, matrix: m }],
      640,
      360,
      { width: 1280, height: 720 },
      metre,
      0,
    );
    expect(hit).toBeNull();
  });

  test("ignores the part of a tile outside its clip rectangle", () => {
    const t = { ...target(layer), clip: [0, 0, 2048, 4096] as const };
    // Line 1 runs at x = 3277, outside the left half the tile is drawn for.
    expect(pickRoad([t], 80, 60, view, metre, 0)).toBeNull();
    expect(pickRoad([t], 30, 50, view, metre, 0)?.line).toBe(0);
  });
});
