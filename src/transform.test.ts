import { Matrix4, PerspectiveCamera } from "three";
import { describe, expect, test } from "vite-plus/test";
import { cameraPosition, metreFrame, metreScale, tileFrame, unitsPerMetre } from "./transform";

describe("tileFrame", () => {
  test("places the world tile at the origin with one metre per z step", () => {
    expect(tileFrame({ z: 0, x: 0, y: 0 }, 4096, 0)).toEqual({
      origin: [0, 0],
      scale: 1 / 4096,
      zScale: 1,
      zOffset: -10000,
    });
  });

  test("offsets a tile by its position and scales a fine z grid", () => {
    const frame = tileFrame({ z: 2, x: 3, y: 1 }, 4096, -2);
    expect(frame.origin).toEqual([0.75, 0.25]);
    expect(frame.scale).toBeCloseTo(1 / (4096 * 4), 15);
    expect(1001234 * frame.zScale + frame.zOffset).toBeCloseTo(12.34, 9);
  });
});

describe("metreScale", () => {
  test("is one at the equator and 1 / cos(latitude) elsewhere", () => {
    expect(metreScale(0.5)).toBe(1);
    // Mercator y 0.375 is latitude atan(sinh(π / 4)).
    expect(metreScale(0.375)).toBeCloseTo(1 / Math.cos(Math.atan(Math.sinh(Math.PI / 4))), 12);
  });
});

describe("metreFrame", () => {
  test("places a tile as tileFrame does, its z already in metres", () => {
    const frame = metreFrame({ z: 2, x: 3, y: 1 }, 4096);
    expect(frame).toEqual({ ...tileFrame({ z: 2, x: 3, y: 1 }, 4096, 0), zScale: 1, zOffset: 0 });
  });
});

describe("unitsPerMetre", () => {
  test("is the most tile units a metre spans anywhere in the tile: at its poleward edge", () => {
    // Metre and tile unit equal at the equator; the tile spans Mercator y 0.25 .. 0.5.
    expect(unitsPerMetre({ z: 2, x: 0, y: 1 }, 4096, 1 / (4096 * 4))).toBeCloseTo(
      Math.cosh(Math.PI / 2),
      12,
    );
    expect(unitsPerMetre({ z: 2, x: 0, y: 2 }, 4096, 1 / (4096 * 4))).toBeCloseTo(
      Math.cosh(Math.PI / 2),
      12,
    );
  });
});

describe("cameraPosition", () => {
  const view = (eye: [number, number, number], target: [number, number, number]) => {
    const camera = new PerspectiveCamera(36, 1.6, 0.01, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(...eye);
    camera.lookAt(...target);
    camera.updateMatrixWorld();
    return camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  };

  test("finds the eye of a perspective view, looking down at a pitch", () => {
    const eye = cameraPosition(view([3, -4, 5], [0, 0, 0]).elements);
    expect(eye[0]).toBeCloseTo(3, 9);
    expect(eye[1]).toBeCloseTo(-4, 9);
    expect(eye[2]).toBeCloseTo(5, 9);
  });

  test("is in the coordinates the matrix takes, after a translation to a tile's corner", () => {
    const m = view([0.5, 0.25, 1e-5], [0.5001, 0.2501, 0]).multiply(
      new Matrix4().makeTranslation(0.4999, 0.2499, 0),
    );
    const eye = cameraPosition(m.elements);
    expect(eye[0]).toBeCloseTo(1e-4, 12);
    expect(eye[1]).toBeCloseTo(1e-4, 12);
    expect(eye[2]).toBeCloseTo(1e-5, 12);
  });

  test("fails for a projection without an eye", () => {
    const orthographic = new Matrix4().makeOrthographic(-1, 1, 1, -1, 0.1, 10);
    expect(() => cameraPosition(orthographic.elements)).toThrow(/no eye/);
  });
});
