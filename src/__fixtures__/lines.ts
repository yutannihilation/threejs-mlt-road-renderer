import type { Lines } from "../lines";

export type Point = [number, number, number];

/** 3D lines as a `Lines` for tests: line `i` has props `{ id: i }` and no clipped end. */
export function linesOf(...lines: Point[][]): Lines {
  let total = 0;
  return {
    vertices: Float64Array.from(lines.flat(2)),
    lineStart: Uint32Array.from([0, ...lines.map((l) => (total += l.length))]),
    props: lines.map((_, i) => ({ id: i })),
    startClipped: new Uint8Array(lines.length),
    endClipped: new Uint8Array(lines.length),
  };
}
