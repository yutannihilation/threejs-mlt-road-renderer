import type { Lines } from "./lines";
import type { StyleTable } from "./style";
import type { LineNodes } from "./topology";
import { type TileFrame, unitsPerMetreAt } from "./transform";

/**
 * The lines with every stub taken out of the network. A stub is a visible line joined to other
 * visible lines at both ends and shorter than its own half width, so that its ribbon would be
 * wider than it is long: the data's way of joining lines a few decimetres apart, as connectors
 * from a road's end to the carriageways it splits into. Drawn, a stub reads as a road across the
 * others; it is hidden instead, and the nodes it joins become one. Of a group of nodes stubs join,
 * the one with the most other ends, then the most ends, then the first, stays; every other line
 * ending at the others has its end vertex moved onto it. `metre` is one metre in Mercator units at
 * the equator.
 *
 * Returns the inputs themselves where there is no stub; else new lines and a new table, the
 * inputs kept.
 */
export function collapseStubs(
  input: Lines,
  frame: TileFrame,
  metre: number,
  table: StyleTable,
  nodes: LineNodes,
): { lines: Lines; table: StyleTable } {
  const { vertices, lineStart } = input;
  const { startNode, endNode } = nodes;
  const visible = (l: number) => table.visible[l] === 1;
  /** A line's length in metres. */
  const length = (l: number) => {
    let total = 0;
    for (let k = lineStart[l] + 1; k < lineStart[l + 1]; k++) {
      const [x0, y0, x1, y1] = [
        vertices[k * 3 - 3],
        vertices[k * 3 - 2],
        vertices[k * 3],
        vertices[k * 3 + 1],
      ];
      total += Math.hypot(x1 - x0, y1 - y0) / unitsPerMetreAt(frame, metre, (y0 + y1) / 2);
    }
    return total;
  };
  /** Whether another visible line than `l` ends at `node`. */
  const joined = (node: number, l: number) =>
    nodes.nodes[node].some((e) => e.line !== l && visible(e.line));
  const stubs: number[] = [];
  for (let l = 0; l < table.lines; l++) {
    const [a, b] = [startNode[l], endNode[l]];
    if (!visible(l) || a < 0 || b < 0 || a === b || !joined(a, l) || !joined(b, l)) continue;
    if (length(l) < table.halfWidth[l]) stubs.push(l);
  }
  if (stubs.length === 0) return { lines: input, table };

  // The groups of nodes the stubs join.
  const parent = Int32Array.from(nodes.nodes, (_, i) => i);
  const find = (n: number): number => {
    while (parent[n] !== n) n = parent[n] = parent[parent[n]];
    return n;
  };
  for (const l of stubs) parent[find(startNode[l])] = find(endNode[l]);
  const isStub = new Uint8Array(table.lines);
  for (const l of stubs) isStub[l] = 1;
  /** How a node ranks to stay: its ends that are not stubs, then all its ends. */
  const weight = (n: number) => {
    const ends = nodes.nodes[n].filter((e) => visible(e.line));
    return [ends.filter((e) => !isStub[e.line]).length, ends.length];
  };
  const kept = new Map<number, number>();
  for (const l of stubs) {
    for (const n of [startNode[l], endNode[l]]) {
      const root = find(n);
      const best = kept.get(root);
      if (best === undefined) {
        kept.set(root, n);
        continue;
      }
      const [wn, wb] = [weight(n), weight(best)];
      if (wn[0] > wb[0] || (wn[0] === wb[0] && (wn[1] > wb[1] || (wn[1] === wb[1] && n < best)))) {
        kept.set(root, n);
      }
    }
  }

  const moved = Float64Array.from(vertices);
  /** The vertex of a node's first end, whose position the node is. */
  const vertexAt = (n: number) => {
    const { line, atEnd } = nodes.nodes[n][0];
    return atEnd ? lineStart[line + 1] - 1 : lineStart[line];
  };
  for (let l = 0; l < table.lines; l++) {
    if (isStub[l]) continue;
    for (const [n, k] of [
      [startNode[l], lineStart[l]],
      [endNode[l], lineStart[l + 1] - 1],
    ]) {
      if (n < 0) continue;
      const stay = kept.get(find(n));
      if (stay === undefined || stay === n) continue;
      moved.set(vertices.subarray(vertexAt(stay) * 3, vertexAt(stay) * 3 + 3), k * 3);
    }
  }
  const hidden = Uint8Array.from(table.visible);
  for (const l of stubs) hidden[l] = 0;
  return { lines: { ...input, vertices: moved }, table: { ...table, visible: hidden } };
}
